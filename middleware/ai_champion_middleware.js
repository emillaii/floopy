#!/usr/bin/env node
// Express middleware exposing the AI Champion chatbot via HTTP APIs.

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pinecone } = require('@pinecone-database/pinecone');
const { ChampionChatManager, parseBoolean } = require('./ai_champion_core');
const { CharacterStore } = require('./character_store');
const { UserStore } = require('./user_store');
const { SessionStore } = require('./session_store');
const { MessageStore } = require('./message_store');
const { AuthStore } = require('./auth_store');
const { PgUserStore, PgAuthStore, PgSessionStore, PgMessageStore, PgFloppyStore, PgSandboxStore } = require('./postgres_stores');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { loadEnv } = require('./utils/env');
const { buildChunkObjects, extractTextFromFile } = require('./utils/knowledge');

loadEnv();

const fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const originalConsole = {
  log: console.log.bind(console),
  info: (console.info || console.log).bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console),
};

const logDirectory = process.env.CHAMPION_LOG_DIR
  ? path.resolve(process.env.CHAMPION_LOG_DIR)
  : path.resolve(__dirname, '../logs');
const logFilePath = process.env.CHAMPION_LOG_FILE
  ? path.resolve(process.env.CHAMPION_LOG_FILE)
  : path.join(logDirectory, 'ai_champion.log');
const mirrorLogsToConsole = parseBoolean(process.env.CHAMPION_LOG_STDOUT ?? 'false');
const captureConsole = parseBoolean(process.env.CHAMPION_LOG_CAPTURE_CONSOLE ?? 'true');
const logLevelName = (process.env.CHAMPION_LOG_LEVEL || 'info').toLowerCase();

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const effectiveLogLevel = LOG_LEVELS[logLevelName] || LOG_LEVELS.info;

let logFileAvailable = true;
try {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
} catch (err) {
  originalConsole.warn('[Champion][Logging] Failed to prepare log directory:', err?.message || err);
  logFileAvailable = false;
}

const normaliseLogPart = (part) => {
  if (part instanceof Error) {
    return part.stack || part.message || String(part);
  }
  if (typeof part === 'object' && part !== null) {
    try {
      return JSON.stringify(part);
    } catch (err) {
      return String(part);
    }
  }
  return String(part);
};

const appendLog = (level, parts) => {
  if ((LOG_LEVELS[level] || LOG_LEVELS.info) < effectiveLogLevel) {
    if (mirrorLogsToConsole || level === 'error') {
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'log';
      originalConsole[method](...parts);
    }
    return;
  }

  const timestamp = new Date().toISOString();
  const message = parts.map(normaliseLogPart).join(' ');
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

  if (logFileAvailable) {
    fs.appendFile(logFilePath, line, (err) => {
      if (err) {
        logFileAvailable = false;
        originalConsole.error('[Champion][Logging] Failed to append log file:', err?.message || err);
      }
    });
  }

  if (mirrorLogsToConsole || level === 'error') {
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'log';
    originalConsole[method](line.trim());
  }
};

const logger = {
  info: (...parts) => appendLog('info', parts),
  warn: (...parts) => appendLog('warn', parts),
  error: (...parts) => appendLog('error', parts),
  debug: (...parts) => appendLog('debug', parts),
};

if (captureConsole) {
  console.log = (...parts) => logger.info(...parts);
  console.info = (...parts) => logger.info(...parts);
  console.warn = (...parts) => logger.warn(...parts);
  console.error = (...parts) => logger.error(...parts);
  console.debug = (...parts) => logger.debug(...parts);
}

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const FLOPPY_UPLOAD_LIMIT_BYTES = parseNumber(process.env.FLOPPY_MAX_UPLOAD_SIZE, 8 * 1024 * 1024);
const FLOPPY_MAX_UPLOAD_FILES = parseNumber(process.env.FLOPPY_MAX_UPLOAD_FILES, 5);
const FLOPPY_CHUNK_OPTIONS = {
  chunkSize: parseNumber(process.env.FLOPPY_CHUNK_SIZE, 900),
  minChunkSize: parseNumber(process.env.FLOPPY_MIN_CHUNK_SIZE, 280),
};

const floppyUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: FLOPPY_UPLOAD_LIMIT_BYTES,
  },
});

const pineconeApiKey = (process.env.PINECONE_API_KEY || '').trim();
const pineconeEnabled = Boolean(pineconeApiKey);
const pineconeConfig = {
  enabled: pineconeEnabled,
  cloud: (process.env.PINECONE_CLOUD || 'aws').trim() || 'aws',
  region: (process.env.PINECONE_REGION || 'us-west-2').trim() || 'us-west-2',
  metric: (process.env.PINECONE_METRIC || 'cosine').trim() || 'cosine',
  podType: (process.env.PINECONE_POD_TYPE || '').trim(),
  embedModel: (process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text:latest').trim() || 'nomic-embed-text:latest',
  ollamaBaseUrl: ((process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim() || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  queryTopK: Number.isFinite(Number.parseInt(process.env.PINECONE_QUERY_TOP_K || '', 10))
    ? Math.max(1, Math.min(20, Number.parseInt(process.env.PINECONE_QUERY_TOP_K, 10)))
    : 6,
};

let pineconeClient = null;
if (pineconeConfig.enabled) {
  try {
    pineconeClient = new Pinecone({ apiKey: pineconeApiKey });
  } catch (err) {
    logger.warn('[Champion][Pinecone] Failed to initialise client:', err?.message || err);
    pineconeClient = null;
  }
}

const ensuredTenantIndexes = new Map();

function sanitizeIndexName(raw) {
  const fallback = 'default';
  const base = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
  const truncated = base.slice(0, 40) || fallback;
  return `tenant-${truncated}`;
}

function sanitizeNamespace(raw) {
  const fallback = 'default';
  const base = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
  return base.slice(0, 63) || fallback;
}

function hashChunkId(raw) {
  return crypto.createHash('sha256').update(String(raw || crypto.randomUUID())).digest('hex');
}

function normalizeMetadata(input) {
  if (!input || typeof input !== 'object') return {};
  const result = {};
  Object.entries(input).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'object') {
      try {
        result[key] = JSON.stringify(value);
      } catch (_) {
        result[key] = String(value);
      }
    } else {
      result[key] = value;
    }
  });
  return result;
}

function isPineconeNotFound(err) {
  if (!err) return false;
  if (err.statusCode === 404 || err.status === 404) return true;
  const message = String(err?.message || '').toLowerCase();
  return message.includes('404') || message.includes('not found');
}

function extractCaseIdsFromText(text) {
  if (!text) return [];
  const matches = String(text)
    .toUpperCase()
    .match(/CS\d{5,}/g);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

async function waitForPineconeIndexReady(indexName, { timeoutMs = 180_000, pollMs = 5_000 } = {}) {
  if (!pineconeClient) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const description = await pineconeClient.describeIndex(indexName);
      if (description?.status?.ready || description?.status?.state === 'Ready') {
        return description;
      }
    } catch (err) {
      if (!isPineconeNotFound(err)) {
        throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  logger.warn(`[Champion][Pinecone] Timed out waiting for index ${indexName} to become ready.`);
}

async function ensureTenantIndex(tenantId, dimension) {
  if (!pineconeClient || !pineconeConfig.enabled) return null;
  const indexName = sanitizeIndexName(tenantId || 'default');
  const cached = ensuredTenantIndexes.get(indexName);
  if (cached?.dimension === dimension) {
    return indexName;
  }

  let description = null;
  let exists = false;
  try {
    description = await pineconeClient.describeIndex(indexName);
    exists = true;
  } catch (err) {
    if (isPineconeNotFound(err)) {
      exists = false;
    } else {
      logger.warn('[Champion][Pinecone] describeIndex failed:', err?.message || err);
      throw err;
    }
  }

  if (exists) {
    const existingDimension = description?.dimension || description?.spec?.dimension;
    if (existingDimension && existingDimension !== dimension) {
      logger.warn(`[Champion][Pinecone] Index ${indexName} dimension mismatch (${existingDimension} !== ${dimension}). Using existing index.`);
    }
  } else {
    const spec = pineconeConfig.podType
      ? {
        pod: {
          environment: pineconeConfig.region,
          pods: 1,
          replicas: 1,
          shards: 1,
          podType: pineconeConfig.podType,
        },
      }
      : {
        serverless: {
          cloud: pineconeConfig.cloud,
          region: pineconeConfig.region,
        },
      };
    await pineconeClient.createIndex({
      name: indexName,
      dimension,
      metric: pineconeConfig.metric,
      spec,
    });
    await waitForPineconeIndexReady(indexName);
  }

  ensuredTenantIndexes.set(indexName, { dimension });
  return indexName;
}

async function embedTextsWithOllama(texts = []) {
  if (!Array.isArray(texts) || !texts.length) return [];
  const results = [];
  for (const text of texts) {
    const payload = {
      model: pineconeConfig.embedModel,
      prompt: String(text || ''),
    };
    const resp = await fetch(`${pineconeConfig.ollamaBaseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Ollama embedding request failed (${resp.status}): ${errorText}`);
    }
    const data = await resp.json();
    if (!Array.isArray(data?.embedding)) {
      throw new Error('Ollama embedding response missing embedding array');
    }
    results.push(data.embedding.map((value) => Number(value) || 0));
  }
  return results;
}

async function syncFloppyToPinecone(tenantId, floppy) {
  if (!pineconeClient || !pineconeConfig.enabled || !tenantId || !floppy) return;
  const chunks = Array.isArray(floppy.knowledgeChunks) ? floppy.knowledgeChunks : [];
  const prepared = chunks
    .map((chunk, index) => {
      if (!chunk) return null;
      if (typeof chunk === 'string') {
        const trimmed = chunk.trim();
        if (!trimmed) return null;
        return {
          id: `${floppy.id}:legacy:${index}`,
          text: trimmed,
          sourceType: 'manual',
          sourceName: 'Manual knowledge',
          metadata: { source: 'manual' },
        };
      }
      const text = String(chunk.text || '').trim();
      if (!text) return null;
      return {
        id: chunk.id || `${floppy.id}:chunk:${index}`,
        text,
        sourceType: chunk.sourceType || chunk.metadata?.source || 'manual',
        sourceName: chunk.sourceName || chunk.metadata?.filename || chunk.metadata?.source || '',
        metadata: chunk.metadata || {},
      };
    })
    .filter((item) => item && item.text);

  const namespace = sanitizeNamespace(`floppy-${floppy.id}`);
  const indexName = sanitizeIndexName(tenantId || 'default');
  if (!prepared.length) {
    if (pineconeClient) {
      try {
        const index = pineconeClient.index(indexName);
        await index.namespace(namespace).deleteAll();
      } catch (err) {
        if (!isPineconeNotFound(err)) {
          logger.warn('[Champion][Pinecone] Failed to clear namespace for empty floppy:', err?.message || err);
        }
      }
    }
    return;
  }

  const embeddings = await embedTextsWithOllama(prepared.map((item) => item.text));
  if (!embeddings.length) {
    logger.warn('[Champion][Pinecone] Skipping sync — no embeddings generated.');
    return;
  }

  const dimension = embeddings[0]?.length;
  if (!dimension) {
    logger.warn('[Champion][Pinecone] Skipping sync — embedding dimension missing.');
    return;
  }

  const ensuredIndexName = await ensureTenantIndex(tenantId, dimension);
  if (!ensuredIndexName) {
    logger.warn('[Champion][Pinecone] Unable to ensure index for tenant', tenantId);
    return;
  }

  const index = pineconeClient.index(ensuredIndexName);
  const namespaceHandle = index.namespace(namespace);

  try {
    await namespaceHandle.deleteAll();
  } catch (err) {
    if (!isPineconeNotFound(err)) {
      logger.warn('[Champion][Pinecone] Failed to purge namespace before upsert:', err?.message || err);
    }
  }

  const vectors = prepared.map((chunk, idx) => ({
    id: hashChunkId(chunk.id),
    values: embeddings[idx] || embeddings[0],
    metadata: {
      tenantId,
      floppyId: floppy.id,
      floppyTitle: floppy.title || '',
      chunkId: chunk.id,
      sourceType: chunk.sourceType || 'manual',
      sourceName: chunk.sourceName || '',
      text: chunk.text.slice(0, 512),
      ...normalizeMetadata(chunk.metadata),
    },
  }));

  await namespaceHandle.upsert(vectors);
  logger.info(`[Champion][Pinecone] Synced ${vectors.length} vectors for floppy ${floppy.id} in index ${ensuredIndexName}.`);
}

async function deleteFloppyFromPinecone(tenantId, floppyId) {
  if (!pineconeClient || !pineconeConfig.enabled || !tenantId || !floppyId) return;
  const indexName = sanitizeIndexName(tenantId || 'default');
  const namespace = sanitizeNamespace(`floppy-${floppyId}`);
  try {
    const index = pineconeClient.index(indexName);
    await index.namespace(namespace).deleteAll();
    logger.info(`[Champion][Pinecone] Cleared namespace for floppy ${floppyId} in index ${indexName}.`);
  } catch (err) {
    if (isPineconeNotFound(err)) return;
    logger.warn('[Champion][Pinecone] Failed to delete namespace:', err?.message || err);
  }
}

function normaliseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function collectPineconeTargets(source, defaultNamespace, addTarget) {
  if (!source) return;
  if (Array.isArray(source)) {
    source.forEach((item) => collectPineconeTargets(item, defaultNamespace, addTarget));
    return;
  }
  if (typeof source === 'string') {
    addTarget(source, defaultNamespace);
    return;
  }
  if (typeof source !== 'object') return;

  const namespace = source.namespace || source.ns || source.pineconeNamespace || defaultNamespace;

  ['index', 'indexName', 'pineconeIndex'].forEach((key) => {
    if (typeof source[key] === 'string' && source[key].trim()) {
      addTarget(source[key].trim(), namespace);
    }
  });

  ['indexes', 'indexNames', 'pineconeIndexes'].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] == null) return;
    const value = source[key];
    if (Array.isArray(value)) {
      value.forEach((item) => collectPineconeTargets(item, namespace, addTarget));
    } else if (typeof value === 'string') {
      normaliseList(value).forEach((entry) => addTarget(entry, namespace));
    } else if (typeof value === 'object') {
      collectPineconeTargets(value, namespace, addTarget);
    }
  });

  if (source.targets) {
    collectPineconeTargets(source.targets, namespace, addTarget);
  }
}

function resolvePineconeTargetsForFloppy(floppy, tenantId) {
  if (!floppy) return [];
  const metadata = floppy.metadata || {};
  const pineconeMeta = metadata.pinecone || metadata.pineconeConfig || {};
  const fallbackNamespaceRaw = pineconeMeta.namespace
    || (Array.isArray(pineconeMeta.namespaces) && pineconeMeta.namespaces[0])
    || `floppy-${floppy.id}`;
  const fallbackNamespace = sanitizeNamespace(fallbackNamespaceRaw || `floppy-${floppy.id}`);

  const targets = new Map();
  const addTarget = (indexNameRaw, namespaceRaw) => {
    const trimmedIndex = typeof indexNameRaw === 'string' ? indexNameRaw.trim() : '';
    if (!trimmedIndex) return;
    const namespace = namespaceRaw ? sanitizeNamespace(namespaceRaw) : fallbackNamespace;
    const key = `${trimmedIndex}::${namespace}`;
    if (!targets.has(key)) {
      targets.set(key, { indexName: trimmedIndex, namespace });
    }
  };

  collectPineconeTargets(pineconeMeta.targets, fallbackNamespace, addTarget);
  collectPineconeTargets(pineconeMeta.indexes, fallbackNamespace, addTarget);
  collectPineconeTargets(pineconeMeta.indexNames, fallbackNamespace, addTarget);
  collectPineconeTargets(metadata.pineconeIndexes, fallbackNamespace, addTarget);
  collectPineconeTargets(floppy.pineconeIndexes, fallbackNamespace, addTarget);
  collectPineconeTargets(floppy.pineconeTargets, fallbackNamespace, addTarget);
  const knowledgeGroups = [
    ...(Array.isArray(metadata.knowledgeGroups) ? metadata.knowledgeGroups : []),
    ...(Array.isArray(floppy.knowledgeGroups) ? floppy.knowledgeGroups : []),
  ].filter((group) => group && (
    typeof group.pineconeIndex === 'string'
    || typeof group.index === 'string'
    || typeof group.indexName === 'string'
    || group.targets
    || group.indexes
    || group.indexNames
  ));
  knowledgeGroups.forEach((group) => collectPineconeTargets(group, fallbackNamespace, addTarget));

  if (!targets.size) {
    const fallbackIndex = sanitizeIndexName(floppy.tenantId || tenantId || 'default');
    addTarget(fallbackIndex, fallbackNamespace);
  }

  return Array.from(targets.values());
}

function createPineconeMemoryProvider({ floppy, tenantId, targets }) {
  if (!pineconeClient || !pineconeConfig.enabled || !floppy) return null;
  const resolvedTargets = Array.isArray(targets) && targets.length
    ? targets
    : resolvePineconeTargetsForFloppy(floppy, tenantId);
  if (!resolvedTargets.length) return null;
  const maxTopK = pineconeConfig.queryTopK || 6;

  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'your', 'will', 'into', 'about',
    'there', 'their', 'when', 'what', 'which', 'while', 'where', 'these', 'those', 'been', 'being',
    'more', 'some', 'than', 'then', 'them', 'they', 'could', 'would', 'should', 'because', 'through',
    'using', 'given', 'after', 'before', 'during', 'within', 'between', 'among', 'over', 'under',
    'into', 'onto', 'also', 'just', 'very', 'each', 'other', 'every', 'such', 'amongst', 'maybe',
    'might', 'much', 'many', 'like', 'said', 'does', 'done', 'only', 'even', 'well', 'keep', 'know',
  ]);

  const extractKeywords = (text, existing = []) => {
    if (!text || typeof text !== 'string') return existing;
    const tokens = text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9-]{2,}/g);
    if (!tokens) return existing;
    const counts = new Map();
    tokens.forEach((token) => {
      if (stopWords.has(token)) return;
      counts.set(token, (counts.get(token) || 0) + 1);
    });
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word)
      .slice(0, 6);
    const merged = new Set((Array.isArray(existing) ? existing : []).map((item) => String(item).toLowerCase()));
    ranked.forEach((word) => merged.add(word));
    return Array.from(merged)
      .filter(Boolean)
      .slice(0, 8);
  };

  const knowledgeChunks = Array.isArray(floppy.knowledgeChunks) ? floppy.knowledgeChunks : [];

  return async ({ query, topK }) => {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) return [];

    let vector;
    try {
      const embeddings = await embedTextsWithOllama([text]);
      vector = embeddings[0];
    } catch (err) {
      logger.warn('[Champion][Pinecone] Failed to embed query:', err?.message || err);
      return [];
    }

    if (!Array.isArray(vector) || !vector.length) {
      return [];
    }

    const limit = Math.max(1, Math.min(20, topK || maxTopK));
    const aggregated = [];
    const queryCaseIds = extractCaseIdsFromText(text);
    const queryCaseIdsLower = queryCaseIds.map((id) => id.toLowerCase());

    for (const target of resolvedTargets) {
      try {
        const index = pineconeClient.index(target.indexName);
        const payload = {
          topK: limit,
          vector,
          includeMetadata: true,
          includeValues: false,
        };
        const response = target.namespace
          ? await index.namespace(target.namespace).query(payload)
          : await index.query(payload);
        const matches = response?.matches || [];
        matches.forEach((match) => {
          aggregated.push({ target, match });
        });
      } catch (err) {
        logger.warn(`[Champion][Pinecone] Query failed for index ${target.indexName}:`, err?.message || err);
      }
    }

    const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
    const uniqueTokens = Array.from(new Set(tokens));
    const directCaseMatches = [];
    if (queryCaseIdsLower.length && knowledgeChunks.length) {
      knowledgeChunks.forEach((chunk, idx) => {
        const chunkTextRaw = typeof chunk?.text === 'string' ? chunk.text : String(chunk?.content || '');
        if (!chunkTextRaw) return;
        const lower = chunkTextRaw.toLowerCase();
        const matchedIds = queryCaseIdsLower.filter((id) => lower.includes(id));
        if (!matchedIds.length) return;

        const chunkMetadata = (chunk && typeof chunk.metadata === 'object') ? { ...chunk.metadata } : {};
        const chunkId = chunk.id || chunkMetadata.chunkId || `${floppy.id}:chunk:${idx}`;
        const keywordSet = new Set(
          Array.isArray(chunkMetadata.keywords)
            ? chunkMetadata.keywords.map((word) => (typeof word === 'string' ? word.trim() : '')).filter(Boolean)
            : [],
        );
        matchedIds.forEach((id) => keywordSet.add(id));

        const sourceLabel = chunkMetadata.sourceName
          || chunkMetadata.title
          || chunkMetadata.filename
          || chunkMetadata.documentTitle
          || chunkMetadata.source
          || chunkMetadata.groupName
          || chunk.name
          || chunkId;

        directCaseMatches.push({
          id: chunkId,
          score: 0.999,
          metadata: {
            ...chunkMetadata,
            origin: 'case-id',
            chunkId,
            sourceName: sourceLabel,
            keywords: Array.from(keywordSet),
            matchedCaseIds: matchedIds.map((id) => id.toUpperCase()),
            text: chunkTextRaw,
          },
        });
      });
      if (directCaseMatches.length) {
        logger.debug('[Champion][CaseId] Direct matches found for query', { caseIds: queryCaseIds, matches: directCaseMatches.length });
      }
    }

    const lexicalMatches = [];
    if (uniqueTokens.length && knowledgeChunks.length) {
      const strongTokens = uniqueTokens.filter((token) => token.length > 2);
      const searchTokens = strongTokens.length ? strongTokens : uniqueTokens;

      knowledgeChunks.forEach((chunk, idx) => {
        const chunkTextRaw = typeof chunk?.text === 'string' ? chunk.text : String(chunk?.content || '');
        if (!chunkTextRaw) return;
        const chunkText = chunkTextRaw.toLowerCase();
        if (queryCaseIdsLower.length && !queryCaseIdsLower.some((id) => chunkText.includes(id))) {
          return;
        }
        const hits = searchTokens.filter((token) => chunkText.includes(token));
        if (!hits.length) return;

        const chunkMetadata = (chunk && typeof chunk.metadata === 'object') ? { ...chunk.metadata } : {};
        const chunkId = chunk.id || chunkMetadata.chunkId || `${floppy.id}:chunk:${idx}`;
        const keywordSet = new Set(
          Array.isArray(chunkMetadata.keywords)
            ? chunkMetadata.keywords.map((word) => (typeof word === 'string' ? word.trim() : '')).filter(Boolean)
            : [],
        );
        hits.forEach((word) => keywordSet.add(word));
        if (queryCaseIdsLower.length) {
          queryCaseIdsLower.forEach((id) => {
            if (chunkText.includes(id)) {
              keywordSet.add(id.toUpperCase());
            }
          });
        }

        const sourceLabel = chunkMetadata.sourceName
          || chunkMetadata.title
          || chunkMetadata.filename
          || chunkMetadata.documentTitle
          || chunkMetadata.source
          || chunkMetadata.groupName
          || chunk.name
          || chunkId;

        const lexicalScore = Math.min(0.98, 0.6 + (hits.length / searchTokens.length) * 0.4);

        lexicalMatches.push({
          id: chunkId,
          score: lexicalScore,
          metadata: {
            ...chunkMetadata,
            origin: chunkMetadata.origin || 'lexical',
            chunkId,
            sourceName: sourceLabel,
            keywords: Array.from(keywordSet),
            text: chunkTextRaw,
          },
        });
      });

      if (lexicalMatches.length) {
        logger.info(`[Champion][Lexical] Added ${lexicalMatches.length} keyword match${lexicalMatches.length === 1 ? '' : 'es'} from local knowledge search.`);
      }
    }

    directCaseMatches.forEach((match) => {
      aggregated.push({
        target: { indexName: match.metadata.pineconeIndex || null, namespace: match.metadata.pineconeNamespace || null },
        match,
      });
    });
    lexicalMatches.forEach((match) => {
      aggregated.push({
        target: { indexName: match.metadata.pineconeIndex || null, namespace: match.metadata.pineconeNamespace || null },
        match: {
          id: match.id,
          score: match.score,
          metadata: match.metadata,
        },
      });
    });

    if (!aggregated.length) {
      logger.info(`[Champion][Pinecone] No knowledge hits for ${floppy.id} across ${resolvedTargets.length} index${resolvedTargets.length === 1 ? '' : 'es'}.`);
      return [];
    }

    aggregated.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
    const effectiveLimit = Math.max(1, limit);
    const seen = new Set();
    const results = [];
    for (const { target, match } of aggregated) {
      if (results.length >= effectiveLimit) {
        break;
      }
      const metadata = match?.metadata || {};
      const snippet = typeof metadata.text === 'string' && metadata.text.trim()
        ? metadata.text.trim()
        : typeof metadata.snippet === 'string' && metadata.snippet.trim()
          ? metadata.snippet.trim()
          : '';
      if (!snippet) continue;
      const docId = metadata.chunkId || metadata.id || match.id;
      if (!docId || seen.has(docId)) continue;
      seen.add(docId);

      const enrichedMetadata = {
        ...metadata,
        pineconeIndex: target.indexName || metadata.pineconeIndex || null,
        pineconeNamespace: target.namespace || metadata.pineconeNamespace || null,
        score: match?.score,
      };

      const existingKeywords = Array.isArray(metadata?.keywords)
        ? metadata.keywords
        : (() => {
          try {
            const parsed = typeof metadata?.metadata === 'string' ? JSON.parse(metadata.metadata) : null;
            return Array.isArray(parsed?.keywords) ? parsed.keywords : [];
          } catch (_) {
            return [];
          }
        })();

      enrichedMetadata.keywords = extractKeywords(snippet, existingKeywords);

      results.push({
        Score: match?.score,
        Fields: {
          doc_id: docId,
          role: metadata.role || 'knowledge',
          content: snippet,
          createdAt: metadata.createdAt || new Date().toISOString(),
          model: metadata.model || 'pinecone',
          metadata: JSON.stringify(enrichedMetadata),
        },
      });
    }

    logger.info(`[Champion][Pinecone] Retrieved ${results.length} knowledge chunk${results.length === 1 ? '' : 's'} for ${floppy.id} across ${resolvedTargets.length} index${resolvedTargets.length === 1 ? '' : 'es'}.`);
    if (results.length) {
      const contextPreview = results.map((item) => {
        const fields = item?.Fields || {};
        let meta = {};
        try {
          meta = fields.metadata ? JSON.parse(fields.metadata) : {};
        } catch (_) {
          meta = {};
        }
        const snippet = typeof fields.content === 'string' ? fields.content : '';
        return {
          docId: fields.doc_id,
          score: item?.Score,
          origin: meta.origin || 'pinecone',
          index: meta.pineconeIndex || null,
          namespace: meta.pineconeNamespace || null,
          source: meta.sourceName || meta.title || meta.filename || null,
          snippet: snippet.length > 600 ? `${snippet.slice(0, 600)}…` : snippet,
        };
      });
      logger.debug('[Champion][Pinecone] Context prepared for LLM', {
        query: text,
        limit,
        returned: results.length,
        contexts: contextPreview,
      });
    }
    return results;
  };
}

const scheduleFloppySync = (tenantId, floppy) => {
  if (!pineconeConfig.enabled || !tenantId || !floppy) return;
  Promise.resolve()
    .then(() => syncFloppyToPinecone(tenantId, floppy))
    .catch((err) => {
      logger.warn('[Champion][Pinecone] Sync failed:', err?.message || err);
    });
};

const scheduleFloppyDelete = (tenantId, floppyId) => {
  if (!pineconeConfig.enabled || !tenantId || !floppyId) return;
  Promise.resolve()
    .then(() => deleteFloppyFromPinecone(tenantId, floppyId))
    .catch((err) => {
      logger.warn('[Champion][Pinecone] Namespace cleanup failed:', err?.message || err);
    });
};

const ADMIN_USERS_ENV = process.env.CHAMPION_ADMIN_USERS || process.env.ADMIN_USERS || '';
const DEFAULT_ADMIN_USER = (process.env.CHAMPION_DEFAULT_ADMIN_USER || process.env.ADMIN_USER || '').trim();
const DEFAULT_ADMIN_PASSWORD = process.env.CHAMPION_DEFAULT_ADMIN_PASSWORD
  || process.env.ADMIN_DEFAULT_PASSWORD
  || process.env.ADMIN_PASSWORD
  || process.env.ADMIN_PASS
  || '';

const adminUsers = new Set(
  ADMIN_USERS_ENV
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
);

if (DEFAULT_ADMIN_USER) {
  adminUsers.add(DEFAULT_ADMIN_USER);
}

const ELEVENLABS_TTS_URL = (process.env.ELEVENLABS_TTS_URL && process.env.ELEVENLABS_TTS_URL.trim())
  || 'https://api.elevenlabs.io/v1/text-to-speech';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_DEFAULT_VOICE_ID = (process.env.ELEVENLABS_DEFAULT_VOICE_ID || '').trim();
const ELEVENLABS_MODEL_ID = (process.env.ELEVENLABS_MODEL_ID || 'eleven_monolingual_v1').trim();

const PORT = Number.parseInt(process.env.CHAMPION_SERVER_PORT || '4001', 10);

function maskConnectionString(url) {
  if (!url) return url;
  return url.replace(/:[^:@/]+@/, ':****@');
}

function createMemoryMessageStore() {
  const memoryMessages = new Map();
  return {
    async appendMessages(sessionId, entries = []) {
      if (!sessionId || !entries.length) return;
      const existing = memoryMessages.get(sessionId) || [];
      entries.forEach((entry) => {
        existing.push({
          id: `${sessionId}-${existing.length + 1}`,
          sessionId,
          role: entry.role,
          content: entry.content,
          createdAt: entry.createdAt || new Date(),
        });
      });
      memoryMessages.set(sessionId, existing);
    },
    async list(sessionId) {
      return (memoryMessages.get(sessionId) || []).slice();
    },
    async deleteBySession(sessionId) {
      memoryMessages.delete(sessionId);
    },
  };
}

async function initMongoStore(StoreCtor, options, ensureDefaultsMethod) {
  const store = new StoreCtor(options);
  if (typeof store.connect === 'function') {
    await store.connect();
  }
  if (ensureDefaultsMethod && typeof store[ensureDefaultsMethod] === 'function') {
    await store[ensureDefaultsMethod]();
  }
  return store;
}

async function initialiseStores() {
  const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const mongoUri = process.env.MONGO_URI;

  if (postgresUrl) {
    logger.info('[Champion] Initialising PostgreSQL stores via', maskConnectionString(postgresUrl));
    const pgConfig = {
      connectionString: postgresUrl,
      logger: console,
    };

    const userStore = new PgUserStore(pgConfig);
    await userStore.connect();
    if (typeof userStore.ensureDefaults === 'function') {
      await userStore.ensureDefaults();
    }

    const sessionStore = new PgSessionStore(pgConfig);
    await sessionStore.connect();

    const messageStore = new PgMessageStore(pgConfig);
    await messageStore.connect();

    const authStore = new PgAuthStore(pgConfig);
    await authStore.connect();

    const floppyStore = new PgFloppyStore(pgConfig);
    await floppyStore.connect();

    const sandboxStore = new PgSandboxStore(pgConfig);
    await sandboxStore.connect();

    let characterStore = null;
    if (mongoUri) {
      characterStore = await initMongoStore(CharacterStore, {
        uri: mongoUri,
        dbName: process.env.MONGO_DB_NAME,
        collectionName: process.env.MONGO_CHARACTER_COLLECTION || 'characters',
      }, 'ensureDefaults');
    }

    return { characterStore, userStore, sessionStore, authStore, messageStore, floppyStore, sandboxStore };
  }

  if (mongoUri) {
    logger.info('[Champion] Initialising MongoDB stores via', maskConnectionString(mongoUri));
    const baseConfig = { uri: mongoUri, dbName: process.env.MONGO_DB_NAME };
    const characterStore = await initMongoStore(CharacterStore, {
      ...baseConfig,
      collectionName: process.env.MONGO_CHARACTER_COLLECTION || 'characters',
    }, 'ensureDefaults');

    const userStore = await initMongoStore(UserStore, {
      ...baseConfig,
      collectionName: process.env.MONGO_USER_COLLECTION || 'users',
    }, 'ensureDefaults');

    const sessionStore = await initMongoStore(SessionStore, {
      ...baseConfig,
      collectionName: process.env.MONGO_SESSION_COLLECTION || 'chat_sessions',
    });

    const messageStore = await initMongoStore(MessageStore, {
      ...baseConfig,
      collectionName: process.env.MONGO_MESSAGE_COLLECTION || 'chat_messages',
    });

    const authStore = await initMongoStore(AuthStore, {
      ...baseConfig,
      collectionName: process.env.MONGO_CREDENTIAL_COLLECTION || 'user_credentials',
    });

    return { characterStore, userStore, sessionStore, authStore, messageStore, floppyStore: null, sandboxStore: null };
  }

  logger.info('[Champion] No database configured, falling back to in-memory stores');
  return {
    characterStore: null,
    userStore: null,
    sessionStore: null,
    authStore: new AuthStore(),
    messageStore: createMemoryMessageStore(),
    floppyStore: null,
    sandboxStore: null,
  };
}

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const { characterStore, userStore, sessionStore, authStore, messageStore, floppyStore: persistentFloppyStore, sandboxStore: persistentSandboxStore } = await initialiseStores();

  const manager = new ChampionChatManager({}, { characterStore, userStore });
  await manager.init();

  const sessions = new Map();
  const authSessions = new Map();

  const cloneDeep = (value) => JSON.parse(JSON.stringify(value));

  const recomputeAggregatedKnowledge = (entry) => {
    const manual = Array.isArray(entry.manualChunks) ? entry.manualChunks : [];
    const fileChunks = (Array.isArray(entry.knowledgeFiles) ? entry.knowledgeFiles : [])
      .flatMap((file) => (Array.isArray(file?.chunks) ? file.chunks : []));
    entry.knowledgeChunks = [...manual, ...fileChunks];
    entry.knowledgeChunkCount = entry.knowledgeChunks.length;
    return entry;
  };

  const applyManualKnowledge = (entry, rawText) => {
    const text = typeof rawText === 'string' ? rawText : '';
    entry.knowledge = text;
    entry.manualChunks = text.trim()
      ? buildChunkObjects(text, {
        id: `${entry.id}:manual`,
        type: 'manual',
        name: 'Manual knowledge',
        metadata: { source: 'manual' },
      }, { ...FLOPPY_CHUNK_OPTIONS, baseId: `${entry.id}:manual`, useStableIds: true })
      : [];
    return recomputeAggregatedKnowledge(entry);
  };

  const appendFilesToEntry = async (entry, uploads = [], context = {}) => {
    const outcomes = [];
    entry.knowledgeFiles = Array.isArray(entry.knowledgeFiles) ? entry.knowledgeFiles : [];
    entry.knowledgeGroups = sanitiseKnowledgeGroups(entry.knowledgeGroups);
    for (const file of uploads) {
      if (!file) continue;
      try {
        const text = await extractTextFromFile(file);
        if (!text) {
          outcomes.push({
            name: file.originalname || file.fieldname || 'file',
            skipped: 'empty',
          });
          continue;
        }

        const fileId = `${entry.id}:file:${crypto.randomUUID()}`;
        const groupId = context.groupId ? String(context.groupId) : null;
        const groupName = context.groupName !== undefined && context.groupName !== null
          ? String(context.groupName)
          : null;
        const groupDescription = context.groupDescription !== undefined && context.groupDescription !== null
          ? String(context.groupDescription)
          : null;
        if (groupId) {
          const existingGroup = entry.knowledgeGroups.find((group) => group.id === groupId);
          if (existingGroup) {
            if (groupName) existingGroup.name = groupName;
            if (groupDescription !== null && groupDescription !== undefined) {
              existingGroup.description = groupDescription;
            }
          } else {
            entry.knowledgeGroups.push({
              id: groupId,
              name: groupName || 'Untitled context',
              description: groupDescription || '',
            });
          }
        }
        const csvSegments = Array.isArray(file.__csvSegments) && file.__csvSegments.length ? file.__csvSegments : null;
        const chunkOptions = csvSegments
          ? {
              ...FLOPPY_CHUNK_OPTIONS,
              baseId: fileId,
              useStableIds: true,
              segments: csvSegments,
            }
          : FLOPPY_CHUNK_OPTIONS;
        const chunks = buildChunkObjects(text, {
          id: fileId,
          type: 'file',
          name: file.originalname || file.fieldname || 'Document',
          metadata: {
            source: 'file',
            filename: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            groupId,
          },
        }, chunkOptions);
        if (file.__csvSegments) {
          delete file.__csvSegments;
        }

        const fileEntry = {
          id: fileId,
          name: file.originalname || 'Document',
          mimetype: file.mimetype,
          size: file.size,
          uploadedBy: context.uploadedBy || null,
          uploadedAt: new Date().toISOString(),
          chunkCount: chunks.length,
          chunks,
          groupId,
        };
        entry.knowledgeFiles.push(fileEntry);

        outcomes.push({
          fileId,
          name: fileEntry.name,
          chunkCount: chunks.length,
          groupId,
        });
      } catch (err) {
        outcomes.push({
          name: file?.originalname || file?.fieldname || 'file',
          error: err?.message || String(err),
        });
      }
    }

    recomputeAggregatedKnowledge(entry);
    entry.updatedAt = new Date().toISOString();
    entry.updatedBy = context.uploadedBy || entry.updatedBy || null;
    syncKnowledgeGroupsToMetadata(entry);
    return { entry, outcomes };
  };

  function sanitiseKnowledgeGroups(groups = []) {
    if (!Array.isArray(groups)) return [];
    return groups
      .map((group) => ({
        id: group?.id || crypto.randomUUID(),
        name: String(group?.name || '').trim(),
        description: String(group?.description || '').trim(),
      }))
      .map((group) => ({
        ...group,
        name: group.name || 'Untitled context',
      }));
  }

  function syncKnowledgeGroupsToMetadata(entry) {
    const groups = Array.isArray(entry.knowledgeGroups) ? entry.knowledgeGroups : [];
    if (!entry.metadata || typeof entry.metadata !== 'object') {
      entry.metadata = groups.length ? { knowledgeGroups: groups } : null;
      return entry;
    }
    const metadata = { ...entry.metadata };
    if (groups.length) {
      metadata.knowledgeGroups = groups;
    } else if (metadata.knowledgeGroups) {
      delete metadata.knowledgeGroups;
    }
    entry.metadata = Object.keys(metadata).length ? metadata : null;
    return entry;
  }

  const CHARACTER_CARD_ASSET_LIMIT = parseNumber(process.env.SANDBOX_CARD_ASSET_LIMIT, 1_500_000);

  const sanitiseCharacterAsset = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl.trim() : '';
    if (!dataUrl) return null;
    if (!dataUrl.startsWith('data:')) {
      throw new Error('Character card images must be provided as data URLs.');
    }
    if (CHARACTER_CARD_ASSET_LIMIT && dataUrl.length > CHARACTER_CARD_ASSET_LIMIT) {
      throw new Error('Character card image exceeds the allowed size.');
    }
    return {
      dataUrl,
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      mimeType: typeof raw.mimeType === 'string' ? raw.mimeType.trim() : '',
    };
  };

  const sanitiseCharacterCard = (raw) => {
    const card = raw && typeof raw === 'object' ? raw : {};
    return {
      name: typeof card.name === 'string' ? card.name.trim() : '',
      prompt: typeof card.prompt === 'string' ? card.prompt : '',
      avatar: sanitiseCharacterAsset(card.avatar),
      background: sanitiseCharacterAsset(card.background),
    };
  };

  const removeFileFromEntry = (entry, fileId, context = {}) => {
    entry.knowledgeFiles = Array.isArray(entry.knowledgeFiles) ? entry.knowledgeFiles : [];
    entry.knowledgeGroups = sanitiseKnowledgeGroups(entry.knowledgeGroups);
    const index = entry.knowledgeFiles.findIndex((file) => file.id === fileId);
    if (index === -1) {
      return { entry, removed: null };
    }
    const [removed] = entry.knowledgeFiles.splice(index, 1);
    recomputeAggregatedKnowledge(entry);
    entry.updatedAt = new Date().toISOString();
    entry.updatedBy = context.updatedBy || entry.updatedBy || null;
    entry.knowledgeChunkCount = entry.knowledgeChunks.length;
    syncKnowledgeGroupsToMetadata(entry);
    return { entry, removed };
  };

  const createMemoryFloppyStore = () => {
    const records = [];

    const ensureSorted = () => {
      records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    };

    return {
      async list(tenantId) {
        ensureSorted();
        const filtered = tenantId ? records.filter((item) => item.tenantId === tenantId) : records;
        return filtered.map(cloneDeep);
      },
      async get(id) {
        if (!id) return null;
        const entry = records.find((item) => item.id === id);
        return entry ? cloneDeep(entry) : null;
      },
      async create(payload = {}) {
        const now = new Date().toISOString();
        const tenantId = payload.tenantId || payload.createdBy || null;
        const entry = {
          id: crypto.randomUUID(),
          tenantId,
          title: payload.title || '',
          description: payload.description || '',
          level: payload.level || 'primary',
          metadata: payload.metadata ?? null,
          knowledge: '',
          manualChunks: [],
          knowledgeFiles: [],
          knowledgeChunks: [],
          knowledgeChunkCount: 0,
          createdBy: payload.createdBy || tenantId || null,
          updatedBy: payload.createdBy || tenantId || null,
          createdAt: now,
          updatedAt: now,
        };
        applyManualKnowledge(entry, payload.knowledge || '');
        entry.knowledgeChunkCount = entry.knowledgeChunks.length;
        entry.knowledgeGroups = sanitiseKnowledgeGroups(payload.knowledgeGroups);
        syncKnowledgeGroupsToMetadata(entry);
        records.unshift(entry);
        ensureSorted();
        return cloneDeep(entry);
      },
      async update(id, payload = {}) {
        if (!id) return null;
        const entry = records.find((item) => item.id === id);
        if (!entry) return null;
        if (payload.title !== undefined) entry.title = payload.title;
        if (payload.description !== undefined) entry.description = payload.description;
        if (payload.level !== undefined) entry.level = payload.level || 'primary';
        if (payload.metadata !== undefined) entry.metadata = payload.metadata;
        if (payload.knowledge !== undefined) {
          applyManualKnowledge(entry, payload.knowledge);
          entry.knowledgeChunkCount = entry.knowledgeChunks.length;
        } else {
          recomputeAggregatedKnowledge(entry);
          entry.knowledgeChunkCount = entry.knowledgeChunks.length;
        }
        if (payload.knowledgeGroups !== undefined) {
          entry.knowledgeGroups = sanitiseKnowledgeGroups(payload.knowledgeGroups);
        } else if (!Array.isArray(entry.knowledgeGroups)) {
          entry.knowledgeGroups = [];
        }
        if (payload.updatedBy !== undefined) {
          entry.updatedBy = payload.updatedBy;
        }
        entry.updatedAt = new Date().toISOString();
        syncKnowledgeGroupsToMetadata(entry);
        ensureSorted();
        return cloneDeep(entry);
      },
      async remove(id) {
        if (!id) return false;
        const index = records.findIndex((item) => item.id === id);
        if (index === -1) return false;
        records.splice(index, 1);
        return true;
      },
      async addFiles(id, uploads = [], context = {}) {
        if (!id) return null;
        const entry = records.find((item) => item.id === id);
        if (!entry) return null;
        const { outcomes } = await appendFilesToEntry(entry, uploads, context);
        ensureSorted();
        return {
          floppy: cloneDeep(entry),
          outcomes,
        };
      },
      async removeFile(id, fileId, context = {}) {
        if (!id || !fileId) return null;
        const entry = records.find((item) => item.id === id);
        if (!entry) return null;
        const { removed } = removeFileFromEntry(entry, fileId, context);
        if (!removed) return null;
        ensureSorted();
        return {
          floppy: cloneDeep(entry),
          removed: cloneDeep(removed),
        };
      },
    };
  };

  const createPersistentFloppyStore = (pgStore) => ({
    async list(tenantId) {
      return pgStore.listByTenant(tenantId);
    },
    async get(id) {
      return pgStore.get(id);
    },
    async create(payload = {}) {
      const now = new Date().toISOString();
      const tenantId = payload.tenantId || payload.createdBy || null;
      const entry = {
        id: crypto.randomUUID(),
        tenantId,
        title: payload.title || '',
        description: payload.description || '',
        level: payload.level || 'primary',
        metadata: payload.metadata ?? null,
        knowledge: '',
        manualChunks: [],
        knowledgeFiles: [],
        knowledgeChunks: [],
        knowledgeChunkCount: 0,
        createdBy: payload.createdBy || tenantId || null,
        updatedBy: payload.createdBy || tenantId || null,
        createdAt: now,
        updatedAt: now,
      };
      applyManualKnowledge(entry, payload.knowledge || '');
      entry.knowledgeChunkCount = entry.knowledgeChunks.length;
      entry.knowledgeGroups = sanitiseKnowledgeGroups(payload.knowledgeGroups);
      syncKnowledgeGroupsToMetadata(entry);
      return pgStore.insert(entry);
    },
    async update(id, payload = {}) {
      if (!id) return null;
      const existing = await pgStore.get(id);
      if (!existing) return null;
      const entry = cloneDeep(existing);
      if (payload.title !== undefined) entry.title = payload.title;
      if (payload.description !== undefined) entry.description = payload.description;
      if (payload.level !== undefined) entry.level = payload.level || 'primary';
      if (payload.metadata !== undefined) entry.metadata = payload.metadata;
      if (payload.knowledge !== undefined) {
        applyManualKnowledge(entry, payload.knowledge);
      } else {
        recomputeAggregatedKnowledge(entry);
      }
      if (payload.knowledgeGroups !== undefined) {
        entry.knowledgeGroups = sanitiseKnowledgeGroups(payload.knowledgeGroups);
      } else if (!Array.isArray(entry.knowledgeGroups)) {
        entry.knowledgeGroups = [];
      }
      if (payload.updatedBy !== undefined) {
        entry.updatedBy = payload.updatedBy;
      } else {
        entry.updatedBy = entry.updatedBy || entry.tenantId || null;
      }
      entry.updatedAt = new Date().toISOString();
      entry.knowledgeChunkCount = entry.knowledgeChunks.length;
      syncKnowledgeGroupsToMetadata(entry);
      return pgStore.update(id, entry);
    },
    async remove(id) {
      return pgStore.delete(id);
    },
    async addFiles(id, uploads = [], context = {}) {
      if (!id) return null;
      const existing = await pgStore.get(id);
      if (!existing) return null;
      const entry = cloneDeep(existing);
      const { entry: updatedEntry, outcomes } = await appendFilesToEntry(entry, uploads, context);
      updatedEntry.tenantId = updatedEntry.tenantId || existing.tenantId;
      updatedEntry.knowledgeChunkCount = updatedEntry.knowledgeChunks.length;
      const saved = await pgStore.update(id, updatedEntry);
      return {
        floppy: saved,
        outcomes,
      };
    },
    async removeFile(id, fileId, context = {}) {
      if (!id || !fileId) return null;
      const existing = await pgStore.get(id);
      if (!existing) return null;
      const entry = cloneDeep(existing);
      const { entry: updatedEntry, removed } = removeFileFromEntry(entry, fileId, context);
      if (!removed) return null;
      updatedEntry.tenantId = updatedEntry.tenantId || existing.tenantId;
      updatedEntry.knowledgeChunkCount = updatedEntry.knowledgeChunks.length;
      const saved = await pgStore.update(id, updatedEntry);
      return {
        floppy: saved,
        removed,
      };
    },
  });

  const floppyStore = persistentFloppyStore
    ? createPersistentFloppyStore(persistentFloppyStore)
    : createMemoryFloppyStore();

  const createMemorySandboxStore = () => {
    const records = [];

    const ensureSorted = () => {
      records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    };

    return {
      async list(tenantId) {
        ensureSorted();
        const filtered = tenantId ? records.filter((item) => item.tenantId === tenantId) : records;
        return filtered.map(cloneDeep);
      },
      async get(id) {
        if (!id) return null;
        const entry = records.find((item) => item.id === id);
        return entry ? cloneDeep(entry) : null;
      },
      async create(payload = {}) {
        const now = new Date().toISOString();
        const tenantId = payload.tenantId || payload.createdBy || null;
        const entry = {
          id: crypto.randomUUID(),
          tenantId,
          floppyId: payload.floppyId || null,
          title: payload.title || '',
          personaPrompt: payload.personaPrompt || '',
          characterCard: sanitiseCharacterCard(payload.characterCard),
          metadata: payload.metadata && typeof payload.metadata === 'object' ? cloneDeep(payload.metadata) : null,
          createdBy: payload.createdBy || tenantId || null,
          updatedBy: payload.createdBy || tenantId || null,
          createdAt: now,
          updatedAt: now,
        };
        records.unshift(entry);
        ensureSorted();
        return cloneDeep(entry);
      },
      async update(id, payload = {}) {
        if (!id) return null;
        const entry = records.find((item) => item.id === id);
        if (!entry) return null;
        if (payload.floppyId !== undefined) entry.floppyId = payload.floppyId || null;
        if (payload.title !== undefined) entry.title = payload.title || '';
        if (payload.personaPrompt !== undefined) entry.personaPrompt = payload.personaPrompt || '';
        if (payload.characterCard !== undefined) {
          entry.characterCard = sanitiseCharacterCard(payload.characterCard);
        }
        if (payload.metadata !== undefined) {
          entry.metadata = payload.metadata && typeof payload.metadata === 'object' ? cloneDeep(payload.metadata) : null;
        }
        entry.updatedBy = payload.updatedBy || entry.updatedBy || entry.tenantId || null;
        entry.updatedAt = new Date().toISOString();
        ensureSorted();
        return cloneDeep(entry);
      },
      async remove(id) {
        if (!id) return false;
        const index = records.findIndex((item) => item.id === id);
        if (index === -1) return false;
        records.splice(index, 1);
        return true;
      },
    };
  };

  const createPersistentSandboxStore = (pgStore) => ({
    async list(tenantId) {
      return pgStore.listByTenant(tenantId);
    },
    async get(id) {
      return pgStore.get(id);
    },
    async create(payload = {}) {
      const now = new Date().toISOString();
      const tenantId = payload.tenantId || payload.createdBy || null;
      const record = {
        id: crypto.randomUUID(),
        tenantId,
        floppyId: payload.floppyId || null,
        title: payload.title || '',
        personaPrompt: payload.personaPrompt || '',
        characterCard: sanitiseCharacterCard(payload.characterCard),
        metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null,
        createdBy: payload.createdBy || tenantId || null,
        updatedBy: payload.createdBy || tenantId || null,
        createdAt: now,
        updatedAt: now,
      };
      return pgStore.insert(record);
    },
    async update(id, payload = {}) {
      if (!id) return null;
      const existing = await pgStore.get(id);
      if (!existing) return null;
      const record = {
        tenantId: existing.tenantId,
        floppyId: payload.floppyId !== undefined ? (payload.floppyId || null) : existing.floppyId,
        title: payload.title !== undefined ? (payload.title || '') : existing.title,
        personaPrompt: payload.personaPrompt !== undefined ? (payload.personaPrompt || '') : existing.personaPrompt,
        characterCard: payload.characterCard !== undefined ? sanitiseCharacterCard(payload.characterCard) : existing.characterCard,
        metadata: payload.metadata !== undefined
          ? (payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null)
          : existing.metadata,
        updatedBy: payload.updatedBy || existing.updatedBy || existing.tenantId || null,
      };
      return pgStore.update(id, record);
    },
    async remove(id) {
      return pgStore.delete(id);
    },
  });

  const sandboxStore = persistentSandboxStore
    ? createPersistentSandboxStore(persistentSandboxStore)
    : createMemorySandboxStore();

  const runFloppyUpload = (req, res, next) => {
    floppyUpload.array('files', FLOPPY_MAX_UPLOAD_FILES)(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: `File exceeds upload limit of ${FLOPPY_UPLOAD_LIMIT_BYTES} bytes`,
          });
        }
        return res.status(400).json({ error: err?.message || 'Upload failed' });
      }
      return next();
    });
  };

  const sandboxSessions = new Map();

  const buildSandboxPersonaPrompt = (floppy, basePrompt) => {
    const intro = `You are running in admin sandbox mode for the floppy "${floppy.title || 'Untitled floppy'}".`;
    const objectives = floppy.description
      ? `Floppy overview: ${floppy.description}`
      : 'No explicit floppy overview was provided. Ask clarifying questions before proceeding.';
    const chunkCount = Number.isFinite(Number(floppy.knowledgeChunkCount))
      ? Number(floppy.knowledgeChunkCount)
      : (floppy.knowledgeChunks?.length || 0);
    const knowledgeHint = chunkCount
      ? 'Use the provided knowledge snippets as an authoritative memory source. Quote or reference them when helpful, and acknowledge when the knowledge is silent.'
      : 'There is no dedicated knowledge base for this floppy. Rely on general reasoning and request more information when needed.';
    const base = basePrompt ? `${basePrompt}` : '';
    return [base, intro, objectives, knowledgeHint]
      .map((part) => part && part.trim())
      .filter(Boolean)
      .join(' ');
  };

  const upsertKnowledgeBatch = async (managerInstance, fields = []) => {
    if (!fields.length) return;
    const prepared = fields.map((content) => ({
      doc_id: `${content.sessionId}-knowledge-${crypto.randomUUID()}`,
      sessionId: content.sessionId,
      role: 'knowledge',
      content: content.text,
      createdAt: content.createdAt || new Date().toISOString(),
      model: 'floppy-knowledge',
      metadata: JSON.stringify(content.metadata || {}),
      text_embed: content.text,
    }));
    try {
      await managerInstance.service.data.UpsertData({
        CollectionName: managerInstance.collectionName,
        Fields: prepared,
        Async: false,
      });
    } catch (err) {
      logger.warn('[Champion][Sandbox] Failed to upsert knowledge batch:', err?.message || err);
    }
  };

  const seedSandboxKnowledge = async (session, floppiesInput) => {
    if (!session) return [];
    const floppies = Array.isArray(floppiesInput)
      ? floppiesInput.filter(Boolean)
      : floppiesInput
        ? [floppiesInput]
        : [];
    if (!floppies.length) return [];

    const entries = floppies
      .flatMap((floppy) => {
        if (!floppy) return [];
        const chunks = Array.isArray(floppy.knowledgeChunks) ? floppy.knowledgeChunks : [];
        if (!chunks.length) return [];
        const floppyId = floppy.id || 'unknown';
        const floppyTitle = floppy.title || '';
        return chunks.map((chunk, index) => {
          if (!chunk) return null;
          if (typeof chunk === 'string') {
            const text = chunk.trim();
            if (!text) return null;
            return {
              sessionId: session.sessionId,
              text,
              metadata: {
                source: 'floppy',
                floppyId,
                floppyTitle,
                sourceType: 'manual',
                sourceName: 'Manual knowledge',
                chunkId: `${floppyId}:manual:${index}`,
              },
            };
          }

          const text = String(chunk.text || '').trim();
          if (!text) return null;
          const baseMetadata = {
            source: 'floppy',
            floppyId,
            floppyTitle,
            chunkId: chunk.id || `${floppyId}:chunk:${index}`,
            sourceType: chunk.sourceType || 'manual',
            sourceName: chunk.sourceName || 'Manual knowledge',
          };
          const metadata = {
            ...baseMetadata,
            ...(chunk.metadata || {}),
          };
          return {
            sessionId: session.sessionId,
            text,
            metadata,
          };
        });
      })
      .filter((entry) => entry && entry.text);

    if (!entries.length) return [];

    await upsertKnowledgeBatch(session.manager, entries);
    return entries.map((entry) => ({
      id: `${session.sessionId}:knowledge:${crypto.randomUUID()}`,
      text: entry.text,
    }));
  };

  const syncSessionProfiles = () => {
    const users = manager.listUsers();
    const lookup = new Map(users.map((user) => [user.userId, user]));
    sessions.forEach((session) => {
      const profile = lookup.get(session.userId);
      session.userProfile = profile || {
        id: session.userId,
        userId: session.userId,
        displayName: session.userId,
        avatar: '',
        label: session.userId,
      };
    });
  };

  const isAdminUserId = (userId) => {
    if (!userId) return false;
    return adminUsers.has(String(userId).trim());
  };

  const ensureAdminAccounts = async () => {
    if (!adminUsers.size) return;
    const duplicateCodes = new Set(['11000', '23505']);
    for (const rawUserId of adminUsers) {
      const userId = String(rawUserId || '').trim();
      if (!userId) continue;
      try {
        const hasCredential = await authStore.hasCredential(userId);
        if (!hasCredential && userId === DEFAULT_ADMIN_USER && DEFAULT_ADMIN_PASSWORD) {
          await authStore.setCredential(userId, String(DEFAULT_ADMIN_PASSWORD));
          logger.info(`[Champion] Provisioned default admin credential for ${userId}`);
        } else if (!hasCredential && userId === DEFAULT_ADMIN_USER && !DEFAULT_ADMIN_PASSWORD) {
          logger.warn(`[Champion] Admin user ${userId} is configured but no password has been provisioned.`);
        }
      } catch (err) {
        logger.warn(`[Champion] Failed to ensure admin credentials for ${userId}:`, err?.message || err);
      }

      if (!manager.getUserProfile(userId)) {
        if (userStore) {
          try {
            await userStore.createUser({
              userId,
              displayName: userId,
              avatar: '',
            });
            await manager.reloadUsers();
          } catch (err) {
            if (duplicateCodes.has(String(err?.code))) {
              try {
                await manager.reloadUsers();
              } catch (reloadErr) {
                logger.warn('[Champion] Failed to reload users for admin provisioning:', reloadErr?.message || reloadErr);
              }
            } else {
              logger.warn(`[Champion] Failed to ensure admin profile for ${userId}:`, err?.message || err);
            }
          }
        } else {
          manager.addOrUpdateUser({
            userId,
            displayName: userId,
            avatar: '',
          });
        }
      }
    }
  };

  await ensureAdminAccounts();
  syncSessionProfiles();

  const populateSessionHistory = async (session) => {
    if (!messageStore || !session) return [];
    const records = await messageStore.list(session.sessionId);
    if (records.length) {
      session.history.splice(0, session.history.length);
      records.forEach((record) => {
        session.history.push({ role: record.role, content: record.content });
      });
    }
    return records;
  };

  const extractBearerToken = (headerValue) => {
    if (!headerValue || typeof headerValue !== 'string') return null;
    const trimmed = headerValue.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
    return null;
  };

  const getTokenFromRequest = (req) => {
    const headerToken = extractBearerToken(req.headers?.authorization);
    if (headerToken) return headerToken;
    if (typeof req.query?.token === 'string' && req.query.token) return req.query.token;
    if (typeof req.body?.token === 'string' && req.body.token) return req.body.token;
    return null;
  };

  const issueAuthToken = (userId, role = 'user') => {
    if (!userId) return null;
    const token = crypto.randomUUID();
    authSessions.set(token, { userId, issuedAt: Date.now(), role });
    return token;
  };

  const revokeAuthToken = (token) => {
    if (!token) return;
    authSessions.delete(token);
  };

  const requireAdminAuth = (req, res, next) => {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }
    const session = authSessions.get(token);
    if (!session || session.role !== 'admin') {
      return res.status(401).json({ error: 'Invalid or expired admin session' });
    }
    req.adminToken = token;
    req.adminSession = session;
    req.adminUserId = session.userId;
    return next();
  };

  const HOMEWORK_PERSONAS = {
    primary: {
      personaName: 'Primary Homework Buddy',
      personaPrompt: [
        'You are a friendly homework helper for primary school students.',
        'Explain ideas with simple words, short sentences, and relatable examples.',
        'Encourage curiosity and celebrate effort. Offer gentle hints before giving full answers.',
        'Keep the tone warm and supportive, and suggest next steps the student can try.'
      ].join(' '),
    },
    secondary: {
      personaName: 'Secondary Study Coach',
      personaPrompt: [
        'You are a knowledgeable study coach for secondary school students.',
        'Provide structured explanations, show your reasoning, and connect ideas to real-world uses.',
        'Encourage students to think critically, and offer follow-up questions or study tips.',
        'Maintain an empowering tone that builds confidence without giving away full solutions immediately.'
      ].join(' '),
    },
  };

  const homeworkSessions = new Map();

  const normaliseHomeworkLevel = (value) => {
    if (!value) return 'primary';
    const normalised = String(value).trim().toLowerCase();
    if (normalised.startsWith('sec')) return 'secondary';
    if (['middle', 'high'].includes(normalised)) return 'secondary';
    return 'primary';
  };

  const ensureHomeworkSession = async ({
    requestedSessionId,
    userId,
    level,
    title,
  }) => {
    const config = HOMEWORK_PERSONAS[level] || HOMEWORK_PERSONAS.primary;
    const { personaName, personaPrompt } = config;

    if (requestedSessionId) {
      if (sessions.has(requestedSessionId)) {
        const existing = sessions.get(requestedSessionId);
        const current = homeworkSessions.get(existing.sessionId) || {};
        const resolvedTitle = title || current.title || existing.persona?.name || config.personaName;
        homeworkSessions.set(existing.sessionId, {
          level,
          personaName: existing.persona?.name || config.personaName,
          title: resolvedTitle,
        });
        if (title && sessionStore?.updateTitle) {
          await sessionStore.updateTitle(existing.sessionId, resolvedTitle);
        }
        await populateSessionHistory(existing);
        return existing;
      }
      if (sessionStore) {
        const stored = await sessionStore.getBySessionId(requestedSessionId);
        if (stored) {
          const restored = await ensureSessionInstance({
            sessionId: stored.sessionId,
            userId: stored.userId,
            personaName: stored.personaName,
            personaPrompt: stored.personaPrompt,
          });
          const resolvedTitle = title || stored.title || restored.persona?.name || config.personaName;
          homeworkSessions.set(restored.sessionId, {
            level,
            personaName: restored.persona?.name || config.personaName,
            title: resolvedTitle,
          });
          if (title && sessionStore.updateTitle) {
            await sessionStore.updateTitle(restored.sessionId, resolvedTitle);
          }
          await populateSessionHistory(restored);
          return restored;
        }
      }
    }

    const session = manager.createSession({
      userId,
      personaName,
      personaPrompt,
      sessionId: requestedSessionId,
      forceNewSession: !requestedSessionId,
    });

    sessions.set(session.sessionId, session);
    const resolvedTitle = title || `${session.persona.name} with ${session.userProfile.displayName || session.userId}`;
    homeworkSessions.set(session.sessionId, { level, personaName: session.persona.name, title: resolvedTitle });
    syncSessionProfiles();

    if (sessionStore) {
      await sessionStore.upsertSession({
        sessionId: session.sessionId,
        userId: session.userId,
        title: resolvedTitle,
        personaName: session.persona.name,
        personaPrompt: session.persona.prompt,
        metadata: { user: session.userProfile, persona: session.persona, level },
      });
    }

    await populateSessionHistory(session);
    return session;
  };

  const ensureSessionInstance = async ({
    sessionId,
    userId,
    personaName,
    personaPrompt,
  }) => {
    let session = sessions.get(sessionId);
    if (session) return session;
    session = manager.createSession({
      userId,
      personaName,
      personaPrompt,
      sessionId,
      forceNewSession: false,
    });
    sessions.set(session.sessionId, session);
    syncSessionProfiles();
    await populateSessionHistory(session);
    return session;
  };

  const summariseMemory = (records = []) => records.map((item, index) => {
    const fields = item?.Fields || {};
    const metadataValue = fields.metadata;
    let metadata = {};
    let metadataRaw = null;
    if (metadataValue && typeof metadataValue === 'string') {
      metadataRaw = metadataValue;
      try {
        const parsed = JSON.parse(metadataValue);
        if (parsed && typeof parsed === 'object') {
          metadata = parsed;
        }
      } catch (err) {
        metadata = { raw: metadataValue };
      }
    } else if (metadataValue && typeof metadataValue === 'object') {
      metadata = { ...metadataValue };
    }

    const sourceLabel = metadata.sourceName
      || metadata.title
      || metadata.filename
      || metadata.documentTitle
      || metadata.docTitle
      || metadata.source
      || metadata.groupName
      || fields.doc_id
      || `Source ${index + 1}`;
    const url = metadata.url || metadata.sourceUrl || metadata.link || metadata.href || null;
    const keywords = Array.isArray(metadata.keywords)
      ? metadata.keywords
        .map((word) => (typeof word === 'string' ? word.trim() : ''))
        .filter(Boolean)
        .slice(0, 8)
      : [];

    const citation = sourceLabel
      ? {
          id: `C${index + 1}`,
          label: sourceLabel,
          url,
          chunkId: metadata.chunkId || fields.doc_id || null,
          index: metadata.pineconeIndex || null,
          namespace: metadata.pineconeNamespace || null,
          group: metadata.groupName || metadata.sourceType || null,
          score: item?.Score ?? null,
        }
      : null;

    return {
      docId: fields.doc_id || null,
      role: fields.role || null,
      content: fields.content || '',
      createdAt: fields.createdAt || null,
      score: item?.Score ?? null,
      source: sourceLabel || null,
      url,
      keywords,
      metadata,
      metadataRaw,
      citation,
    };
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  const sanitizeUserId = (value) => (value || '').trim();

  app.post('/api/auth/register', async (req, res) => {
    try {
      const userId = sanitizeUserId(req.body?.userId);
      const password = req.body?.password;
      const displayName = (req.body?.displayName || '').trim();

      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }
      if (!password || String(password).length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters long' });
      }

      const existingProfile = manager.getUserProfile(userId);
      const hasCredential = await authStore.hasCredential(userId);
      if (existingProfile || hasCredential) {
        return res.status(409).json({ error: 'User already exists' });
      }

      let profile;
      if (userStore) {
        try {
          await userStore.createUser({
            userId,
            displayName: displayName || userId,
            avatar: '',
          });
          await manager.reloadUsers();
          profile = manager.getUserProfile(userId);
        } catch (err) {
          const duplicateCodes = new Set(['11000', '23505']);
          if (duplicateCodes.has(String(err?.code))) {
            return res.status(409).json({ error: 'User already exists' });
          }
          throw err;
        }
      } else {
        profile = manager.addOrUpdateUser({
          userId,
          displayName: displayName || userId,
          avatar: '',
        });
      }

      await authStore.setCredential(userId, String(password));
      syncSessionProfiles();

      const role = isAdminUserId(userId) ? 'admin' : 'user';
      const token = issueAuthToken(userId, role);

      res.status(201).json({
        user: profile,
        token,
        role,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const userId = sanitizeUserId(req.body?.userId);
      const password = req.body?.password;

      if (!userId || !password) {
        return res.status(400).json({ error: 'userId and password are required' });
      }

      const valid = await authStore.verifyCredential(userId, String(password));
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (!manager.getUserProfile(userId)) {
        if (userStore) {
          await manager.reloadUsers();
        } else {
          manager.addOrUpdateUser({ userId });
        }
      }

      const profile = manager.getUserProfile(userId);
      if (!profile) {
        return res.status(404).json({ error: 'User profile not found' });
      }

      const role = isAdminUserId(userId) ? 'admin' : 'user';
      const token = issueAuthToken(userId, role);

      res.json({
        user: profile,
        token,
        role,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/admin/login', async (req, res) => {
    try {
      const userId = sanitizeUserId(req.body?.userId);
      const password = req.body?.password;

      if (!userId || !password) {
        return res.status(400).json({ error: 'userId and password are required' });
      }

      if (!isAdminUserId(userId)) {
        return res.status(403).json({ error: 'User is not authorised for admin access' });
      }

      const valid = await authStore.verifyCredential(userId, String(password));
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (!manager.getUserProfile(userId)) {
        if (userStore) {
          await manager.reloadUsers();
        } else {
          manager.addOrUpdateUser({ userId });
        }
      }

      const profile = manager.getUserProfile(userId);
      if (!profile) {
        return res.status(404).json({ error: 'User profile not found' });
      }

      const token = issueAuthToken(userId, 'admin');

      res.json({
        user: profile,
        token,
        role: 'admin',
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/admin/logout', requireAdminAuth, (req, res) => {
    revokeAuthToken(req.adminToken);
    res.json({ success: true });
  });

  app.get('/api/admin/profile', requireAdminAuth, (req, res) => {
    const profile = manager.getUserProfile(req.adminUserId) || null;
    res.json({
      user: profile ? { ...profile, role: 'admin' } : { userId: req.adminUserId, role: 'admin' },
    });
  });

  app.get('/api/admin/floppies', requireAdminAuth, async (req, res) => {
    try {
      const floppies = await floppyStore.list(req.adminUserId);
      res.json({ floppies });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/admin/floppies/:id', requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const floppy = await floppyStore.get(id);
      if (!floppy) {
        return res.status(404).json({ error: 'Floppy not found' });
      }
      return res.json({ floppy });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/admin/floppies', requireAdminAuth, async (req, res) => {
    try {
      const title = (req.body?.title || '').trim();
      const description = (req.body?.description || '').trim();
      const levelRaw = (req.body?.level || '').trim();
      const level = levelRaw || 'primary';
      const metadata = req.body?.metadata ?? null;
      const knowledge = typeof req.body?.knowledge === 'string' ? req.body.knowledge : '';
      const knowledgeGroups = Array.isArray(req.body?.knowledgeGroups)
        ? req.body.knowledgeGroups
        : [];

      if (!title) {
        return res.status(400).json({ error: 'Title is required' });
      }

      const floppy = await floppyStore.create({
        tenantId: req.adminUserId,
        title,
        description,
        level,
        knowledge,
        metadata,
        knowledgeGroups,
        createdBy: req.adminUserId,
      });

      scheduleFloppySync(floppy?.tenantId || req.adminUserId, floppy);
      res.status(201).json({ floppy });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.put('/api/admin/floppies/:id', requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: 'Floppy id is required' });
      }
      const payload = {};
      if (req.body?.title !== undefined) payload.title = String(req.body.title || '').trim();
      if (req.body?.description !== undefined) payload.description = String(req.body.description || '').trim();
      if (req.body?.level !== undefined) payload.level = String(req.body.level || '').trim() || 'primary';
      if (req.body?.metadata !== undefined) payload.metadata = req.body.metadata;
      if (req.body?.knowledge !== undefined) {
        payload.knowledge = typeof req.body.knowledge === 'string' ? req.body.knowledge : '';
      }
      if (req.body?.knowledgeGroups !== undefined) {
        payload.knowledgeGroups = Array.isArray(req.body.knowledgeGroups)
          ? req.body.knowledgeGroups
          : [];
      }
      payload.updatedBy = req.adminUserId;

      const updated = await floppyStore.update(id, payload);
      if (!updated) {
        return res.status(404).json({ error: 'Floppy not found' });
      }

      scheduleFloppySync(updated?.tenantId || req.adminUserId, updated);
      res.json({ floppy: updated });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/admin/floppies/:id/knowledge/upload', requireAdminAuth, runFloppyUpload, async (req, res) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: 'Floppy id is required' });
      }
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        return res.status(400).json({ error: 'At least one file must be provided' });
      }
      const groupId = req.body && Object.prototype.hasOwnProperty.call(req.body, 'groupId')
        ? String(req.body.groupId || '') || null
        : null;
      const groupName = req.body && Object.prototype.hasOwnProperty.call(req.body, 'groupName')
        ? String(req.body.groupName || '')
        : null;
      const groupDescription = req.body && Object.prototype.hasOwnProperty.call(req.body, 'groupDescription')
        ? String(req.body.groupDescription || '')
        : null;

      const result = await floppyStore.addFiles(id, files, {
        uploadedBy: req.adminUserId,
        groupId,
        groupName,
        groupDescription,
      });
      if (!result) {
        return res.status(404).json({ error: 'Floppy not found' });
      }

      scheduleFloppySync(result.floppy?.tenantId || req.adminUserId, result.floppy);
      res.status(201).json({
        floppy: result.floppy,
        outcomes: result.outcomes,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.delete('/api/admin/floppies/:id/knowledge/:fileId', requireAdminAuth, async (req, res) => {
    try {
      const { id, fileId } = req.params;
      if (!id || !fileId) {
        return res.status(400).json({ error: 'Floppy id and file id are required' });
      }

      const result = await floppyStore.removeFile(id, fileId, { updatedBy: req.adminUserId });
      if (!result) {
        return res.status(404).json({ error: 'Document not found' });
      }

      scheduleFloppySync(result.floppy?.tenantId || req.adminUserId, result.floppy);
      res.json({ floppy: result.floppy, removed: result.removed });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.delete('/api/admin/floppies/:id', requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: 'Floppy id is required' });
      }

      const floppy = await floppyStore.get(id);
      if (!floppy) {
        return res.status(404).json({ error: 'Floppy not found' });
      }

      const removed = await floppyStore.remove(id);
      if (!removed) {
        return res.status(404).json({ error: 'Floppy not found' });
      }

      scheduleFloppyDelete(floppy?.tenantId || req.adminUserId, id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/admin/sandboxes', requireAdminAuth, async (req, res) => {
    try {
      const sandboxes = await sandboxStore.list(req.adminUserId);
      res.json({ sandboxes });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/admin/sandboxes', requireAdminAuth, async (req, res) => {
    try {
      const title = String(req.body?.title || '').trim();
      if (!title) {
        return res.status(400).json({ error: 'Sandbox title is required' });
      }

      let characterCard;
      try {
        characterCard = sanitiseCharacterCard(req.body?.characterCard);
      } catch (err) {
        return res.status(400).json({ error: err?.message || 'Invalid character card' });
      }

      const sandbox = await sandboxStore.create({
        tenantId: req.adminUserId,
        title,
        floppyId: String(req.body?.floppyId || '').trim() || null,
        personaPrompt: typeof req.body?.personaPrompt === 'string' ? req.body.personaPrompt : '',
        characterCard,
        metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : null,
        createdBy: req.adminUserId,
      });

      res.status(201).json({ sandbox });
    } catch (err) {
      const message = err?.message || String(err);
      const status = /character card image exceeds/i.test(message) ? 413 : 500;
      res.status(status).json({ error: message });
    }
  });

  app.put('/api/admin/sandboxes/:id', requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: 'Sandbox id is required' });
      }

      const payload = { updatedBy: req.adminUserId };
      if (req.body?.floppyId !== undefined) {
        payload.floppyId = String(req.body.floppyId || '').trim() || null;
      }
      if (req.body?.title !== undefined) {
        payload.title = String(req.body.title || '').trim();
        if (!payload.title) {
          return res.status(400).json({ error: 'Sandbox title cannot be empty' });
        }
      }
      if (req.body?.personaPrompt !== undefined) {
        payload.personaPrompt = typeof req.body.personaPrompt === 'string' ? req.body.personaPrompt : '';
      }
      if (req.body?.metadata !== undefined) {
        payload.metadata = req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : null;
      }
      if (req.body?.characterCard !== undefined) {
        try {
          payload.characterCard = sanitiseCharacterCard(req.body.characterCard);
        } catch (err) {
          return res.status(400).json({ error: err?.message || 'Invalid character card' });
        }
      }

      const sandbox = await sandboxStore.update(id, payload);
      if (!sandbox) {
        return res.status(404).json({ error: 'Sandbox not found' });
      }
      res.json({ sandbox });
    } catch (err) {
      const message = err?.message || String(err);
      const status = /character card image exceeds/i.test(message) ? 413 : 500;
      res.status(status).json({ error: message });
    }
  });

  app.delete('/api/admin/sandboxes/:id', requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: 'Sandbox id is required' });
      }
      const removed = await sandboxStore.remove(id);
      if (!removed) {
        return res.status(404).json({ error: 'Sandbox not found' });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/admin/sandbox/session', requireAdminAuth, async (req, res) => {
    try {
      const sandboxIdRaw = (req.body?.sandboxId || '').trim();
      const requestedFloppyIds = Array.isArray(req.body?.floppyIds)
        ? req.body.floppyIds.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      const singleFloppyId = String(req.body?.floppyId || '').trim();
      let floppyIds = Array.from(new Set([
        ...requestedFloppyIds,
        ...(singleFloppyId ? [singleFloppyId] : []),
      ]));

      let sandboxConfig = null;
      if (sandboxIdRaw) {
        sandboxConfig = await sandboxStore.get(sandboxIdRaw);
        if (!sandboxConfig) {
          return res.status(404).json({ error: 'Sandbox not found' });
        }
        const metadataFloppyIds = Array.isArray(sandboxConfig.metadata?.floppyIds)
          ? sandboxConfig.metadata.floppyIds
              .map((value) => String(value || '').trim())
              .filter(Boolean)
          : [];
        if (!floppyIds.length && metadataFloppyIds.length) {
          floppyIds = Array.from(new Set(metadataFloppyIds));
        }
        const sandboxFloppyId = String(sandboxConfig.floppyId || '').trim();
        if (!floppyIds.length && sandboxFloppyId) {
          floppyIds = [sandboxFloppyId];
        } else if (sandboxFloppyId && floppyIds.length && !floppyIds.includes(sandboxFloppyId)) {
          logger.warn('[Admin][Sandbox] Requested floppy mismatch for sandbox', sandboxIdRaw);
        }
      }

      const uniqueFloppyIds = Array.from(new Set(floppyIds.filter(Boolean)));
      if (!uniqueFloppyIds.length) {
        return res.status(400).json({ error: 'At least one floppyId is required' });
      }

      const floppies = [];
      for (const id of uniqueFloppyIds) {
        const floppy = await floppyStore.get(id);
        if (!floppy) {
          return res.status(404).json({ error: `Floppy not found: ${id}` });
        }
        floppies.push(floppy);
      }

      const primaryFloppy = floppies[0];
      const basePersona = HOMEWORK_PERSONAS[primaryFloppy.level] || HOMEWORK_PERSONAS.primary;
      let personaName = `${primaryFloppy.title || 'Floppy'} Sandbox Coach`;
      let personaPrompt = buildSandboxPersonaPrompt(primaryFloppy, basePersona.personaPrompt);
      let personaImage = '';

      if (floppies.length > 1) {
        const additionalTitles = floppies
          .slice(1)
          .map((floppy) => `“${floppy.title || 'Untitled floppy'}”`)
          .join(', ');
        if (additionalTitles) {
          const additionalPrompt = `You also have access to knowledge from ${additionalTitles}. Blend insights from every source when answering.`;
          personaPrompt = [personaPrompt, additionalPrompt]
            .map((part) => part && part.trim())
            .filter(Boolean)
            .join(' ');
        }
      }

      if (sandboxConfig) {
        if (sandboxConfig.title) {
          personaName = sandboxConfig.title;
        }
        if (sandboxConfig.personaPrompt) {
          personaPrompt = sandboxConfig.personaPrompt;
        } else if (sandboxConfig.characterCard?.prompt) {
          personaPrompt = sandboxConfig.characterCard.prompt;
        }
        if (sandboxConfig.characterCard?.avatar?.dataUrl) {
          personaImage = sandboxConfig.characterCard.avatar.dataUrl;
        }
      }

      if (typeof req.body?.personaPrompt === 'string' && req.body.personaPrompt.trim()) {
        personaPrompt = req.body.personaPrompt.trim();
      }

      const session = manager.createSession({
        userId: req.adminUserId,
        personaName,
        personaPrompt,
        personaImage,
        newSessionPerRun: true,
      });

      sessions.set(session.sessionId, session);
      syncSessionProfiles();

      await seedSandboxKnowledge(session, floppies);

      const pineconeMetadata = [];
      for (const floppy of floppies) {
        const tenantKey = floppy.tenantId || req.adminUserId;
        const pineconeTargets = resolvePineconeTargetsForFloppy(floppy, tenantKey);
        const pineconeProvider = createPineconeMemoryProvider({
          floppy,
          tenantId: tenantKey,
          targets: pineconeTargets,
        });
        if (pineconeProvider && typeof session.addMemoryProvider === 'function') {
          session.addMemoryProvider(pineconeProvider);
        }
        pineconeMetadata.push({
          floppyId: floppy.id,
          tenantId: tenantKey,
          targets: pineconeTargets,
        });
      }

      sandboxSessions.set(session.sessionId, {
        floppyId: primaryFloppy?.id || null,
        floppyIds: floppies.map((floppy) => floppy.id),
        adminUserId: req.adminUserId,
        personaName: session.persona.name,
        createdAt: new Date(),
        knowledgeLoaded: true,
        pineconeTargets: pineconeMetadata,
        sandboxId: sandboxConfig?.id || null,
      });

      res.status(201).json({
        sessionId: session.sessionId,
        persona: session.persona,
        floppy: primaryFloppy,
        floppies,
        user: session.userProfile,
        sandbox: sandboxConfig,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/admin/sandbox/session/:id/message', requireAdminAuth, async (req, res) => {
    const sessionId = req.params.id;
    const rawMessage = req.body?.message;

    if (!rawMessage || !String(rawMessage).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    try {
      let session = sessions.get(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Sandbox session not found' });
      }

      const meta = sandboxSessions.get(sessionId);
      if (!meta) {
        return res.status(404).json({ error: 'Sandbox session metadata missing' });
      }

      const userText = String(rawMessage);
      const result = await session.sendMessage(userText);

      const history = result.history.map((entry) => ({ role: entry.role, content: entry.content }));
      const memorySummaries = summariseMemory(result.memories);
      const citations = memorySummaries
        .map((entry) => entry.citation)
        .filter(Boolean);

      res.json({
        sessionId: result.sessionId,
        reply: result.reply,
        history,
        memories: memorySummaries,
        citations,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/admin/sandbox/session/:id/history', requireAdminAuth, (req, res) => {
    const { id } = req.params;
    const session = sessions.get(id);
    const meta = sandboxSessions.get(id);
    if (!session || !meta) {
      return res.status(404).json({ error: 'Sandbox session not found' });
    }
    res.json({
      sessionId: id,
      history: session.getHistory(),
      persona: session.persona,
      floppyId: meta.floppyId,
    });
  });

  app.get('/api/users', (req, res) => {
    try {
      res.json({
        users: manager.listUsers(),
        defaultUser: manager.defaultUser,
        canEdit: Boolean(userStore),
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/users', async (req, res) => {
    if (!userStore) {
      return res.status(400).json({ error: 'User management requires MongoDB (MONGO_URI).' });
    }
    try {
      const { userId, displayName, avatar } = req.body || {};
      if (!userId || !userId.trim()) {
        return res.status(400).json({ error: 'User ID is required' });
      }
      const user = await userStore.createUser({
        userId: userId.trim(),
        displayName: (displayName || '').trim() || userId.trim(),
        avatar: (avatar || '').trim(),
      });
      await manager.reloadUsers();
      syncSessionProfiles();
      res.status(201).json({ user });
    } catch (err) {
      const duplicateCodes = new Set(['11000', '23505']);
      const isDuplicate = duplicateCodes.has(String(err?.code));
      const status = isDuplicate ? 409 : 500;
      const message = isDuplicate ? 'User ID must be unique' : err?.message || String(err);
      res.status(status).json({ error: message });
    }
  });

  app.put('/api/users/:id', async (req, res) => {
    if (!userStore) {
      return res.status(400).json({ error: 'User management requires MongoDB (MONGO_URI).' });
    }
    try {
      const { id } = req.params;
      const payload = {
        displayName: req.body?.displayName,
        avatar: req.body?.avatar,
      };
      const updated = await userStore.updateUser(id, payload);
      if (!updated) {
        return res.status(404).json({ error: 'User not found' });
      }
      await manager.reloadUsers();
      syncSessionProfiles();
      res.json({ user: updated });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.delete('/api/users/:id', async (req, res) => {
    if (!userStore) {
      return res.status(400).json({ error: 'User management requires MongoDB (MONGO_URI).' });
    }
    try {
      const { id } = req.params;
      await userStore.deleteUser(id);
      await manager.reloadUsers();
      syncSessionProfiles();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/personas', (req, res) => {
    res.json({
      personas: manager.listPersonas(),
      defaultPersona: manager.defaultPersona,
    });
  });

  app.get('/api/characters', async (req, res) => {
    try {
      const characters = await characterStore.list();
      res.json({ characters });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/homework/session', async (req, res) => {
    try {
      const level = normaliseHomeworkLevel(req.body?.level);
      const studentId = (req.body?.studentId && String(req.body.studentId).trim())
        || `student_${level}`;
      const requestedSessionId = (req.body?.sessionId && String(req.body.sessionId).trim()) || null;
      const title = (req.body?.title && String(req.body.title).trim()) || '';

      const session = await ensureHomeworkSession({
        requestedSessionId,
        userId: studentId,
        level,
        title,
      });

      const storedMeta = homeworkSessions.get(session.sessionId) || {};
      const messages = messageStore
        ? await messageStore.list(session.sessionId)
        : session.getHistory().map((entry) => ({ role: entry.role, content: entry.content, createdAt: new Date() }));

      res.json({
        sessionId: session.sessionId,
        level,
        title: storedMeta.title || title || session.persona.name,
        persona: {
          name: session.persona.name,
          prompt: session.persona.prompt,
        },
        user: {
          id: session.userProfile.id,
          userId: session.userProfile.userId,
          displayName: session.userProfile.displayName,
        },
        history: messages.map((entry) => ({ role: entry.role, content: entry.content })),
        messages,
        resumed: Boolean(requestedSessionId && requestedSessionId === session.sessionId),
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/homework/session/:id/message', async (req, res) => {
    const sessionId = req.params.id;
    const { message } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    try {
      let session = sessions.get(sessionId);
      if (!session && sessionStore) {
        const stored = await sessionStore.getBySessionId(sessionId);
        if (stored) {
          session = await ensureSessionInstance({
            sessionId: stored.sessionId,
            userId: stored.userId,
            personaName: stored.personaName,
            personaPrompt: stored.personaPrompt,
          });
        }
      }

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const userText = String(message);
      const result = await session.sendMessage(userText);

      const meta = homeworkSessions.get(result.sessionId) || {
        level: normaliseHomeworkLevel(),
        personaName: result.persona.name,
        title: `${result.persona.name} with ${result.user.displayName || result.userId}`,
      };
      homeworkSessions.set(result.sessionId, meta);

      if (messageStore) {
        const now = new Date();
        await messageStore.appendMessages(result.sessionId, [
          { role: 'user', content: userText, createdAt: now },
          { role: 'assistant', content: result.reply, createdAt: new Date() },
        ]);
      }

      if (sessionStore) {
        await sessionStore.upsertSession({
          sessionId: result.sessionId,
          userId: result.userId,
          title: meta.title,
          personaName: result.persona.name,
          personaPrompt: result.persona.prompt,
          metadata: { user: result.user, persona: result.persona, level: meta.level },
          lastActiveAt: new Date(),
        });
      }

      const historyMessages = messageStore
        ? await messageStore.list(result.sessionId)
        : result.history.map((entry) => ({ role: entry.role, content: entry.content, createdAt: new Date() }));

      const memorySummaries = summariseMemory(result.memories);
      const citations = memorySummaries
        .map((entry) => entry.citation)
        .filter(Boolean);

      res.json({
        sessionId: result.sessionId,
        reply: result.reply,
        memories: memorySummaries,
        citations,
        history: historyMessages.map((entry) => ({ role: entry.role, content: entry.content })),
        messages: historyMessages,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.put('/api/homework/session/:id', async (req, res) => {
    const sessionId = req.params.id;
    const nextTitle = (req.body?.title && String(req.body.title).trim()) || '';
    if (!nextTitle) {
      return res.status(400).json({ error: 'Title is required' });
    }

    try {
      const meta = homeworkSessions.get(sessionId) || { level: normaliseHomeworkLevel() };
      meta.title = nextTitle;
      homeworkSessions.set(sessionId, meta);

      if (sessionStore?.updateTitle) {
        await sessionStore.updateTitle(sessionId, nextTitle);
      }

      res.json({ sessionId, title: nextTitle });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/homework/session/:id/messages', async (req, res) => {
    const sessionId = req.params.id;
    try {
      let session = sessions.get(sessionId);
      if (!session && sessionStore) {
        const stored = await sessionStore.getBySessionId(sessionId);
        if (stored) {
          session = await ensureSessionInstance({
            sessionId: stored.sessionId,
            userId: stored.userId,
            personaName: stored.personaName,
            personaPrompt: stored.personaPrompt,
          });
        }
      }

      if (!sessionStore && !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const messages = messageStore
        ? await messageStore.list(sessionId)
        : (session ? session.getHistory().map((entry) => ({ role: entry.role, content: entry.content, createdAt: new Date() })) : []);

      res.json({
        sessionId,
        messages,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/characters', async (req, res) => {
    try {
      const {
        name,
        prompt,
        image = '',
        voiceId = req.body?.voice_id ?? '',
      } = req.body || {};
      if (!name || !prompt) {
        return res.status(400).json({ error: 'Character name and prompt are required' });
      }
      const character = await characterStore.createCharacter({ name, prompt, image, voiceId });
      await manager.reloadPersonas();
      res.status(201).json({ character });
    } catch (err) {
      const status = err?.code === 11000 ? 409 : 500;
      const message = err?.code === 11000 ? 'Character name must be unique' : err?.message || String(err);
      res.status(status).json({ error: message });
    }
  });

  app.put('/api/characters/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const payload = { ...req.body };
      if (!payload.voiceId && payload.voice_id) {
        payload.voiceId = payload.voice_id;
      }
      const updated = await characterStore.updateCharacter(id, payload);
      if (!updated) {
        return res.status(404).json({ error: 'Character not found' });
      }
      await manager.reloadPersonas();
      res.json({ character: updated });
    } catch (err) {
      const status = err?.code === 11000 ? 409 : 500;
      const message = err?.code === 11000 ? 'Character name must be unique' : err?.message || String(err);
      res.status(status).json({ error: message });
    }
  });

  app.delete('/api/characters/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await characterStore.deleteCharacter(id);
      await manager.reloadPersonas();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  const callElevenLabsTTS = async ({ text, voiceId, voiceSettings, modelId }) => {
    if (!ELEVENLABS_API_KEY) {
      throw new Error('ElevenLabs API key not configured (ELEVENLABS_API_KEY).');
    }
    const resolvedVoiceId = (voiceId || ELEVENLABS_DEFAULT_VOICE_ID || '').trim();
    if (!resolvedVoiceId) {
      throw new Error('Voice ID is required for ElevenLabs TTS.');
    }

    const url = `${ELEVENLABS_TTS_URL.replace(/\/$/, '')}/${encodeURIComponent(resolvedVoiceId)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        model_id: (modelId || ELEVENLABS_MODEL_ID || '').trim() || 'eleven_monolingual_v1',
        text,
        voice_settings: voiceSettings || undefined,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs TTS failed: ${errorText || response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'audio/mpeg';

    return { audio: audioBase64, format: contentType, voiceId: resolvedVoiceId };
  };

  app.post('/api/tts', async (req, res) => {
    try {
      const {
        text,
        voiceId,
        voiceSettings,
        modelId,
      } = req.body || {};
      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Text is required for TTS.' });
      }

      const result = await callElevenLabsTTS({
        text: text.trim(),
        voiceId,
        voiceSettings,
        modelId,
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/sessions', async (req, res) => {
    try {
      const {
        userId,
        personaName,
        personaPrompt,
        sessionId,
        forceNewSession = false,
      } = req.body || {};

      const forceNew = parseBoolean(forceNewSession);

      if (sessionId && !forceNew) {
        if (sessions.has(sessionId)) {
          const existing = sessions.get(sessionId);
          return res.json({
            sessionId: existing.sessionId,
            userId: existing.userId,
            user: existing.userProfile,
            persona: existing.persona,
            history: existing.getHistory(),
            resumed: true,
          });
        }
        if (sessionStore) {
          const stored = await sessionStore.getBySessionId(sessionId);
          if (stored) {
            const restored = await ensureSessionInstance({
              sessionId: stored.sessionId,
              userId: stored.userId,
              personaName: stored.personaName,
              personaPrompt: stored.personaPrompt,
            });
            return res.json({
              sessionId: restored.sessionId,
              userId: restored.userId,
              user: restored.userProfile,
              persona: restored.persona,
              history: restored.getHistory(),
              resumed: true,
            });
          }
        }
      }

      const session = manager.createSession({
        userId,
        personaName,
        personaPrompt,
        sessionId,
        forceNewSession: forceNew,
      });
      sessions.set(session.sessionId, session);
      syncSessionProfiles();

      if (sessionStore) {
        await sessionStore.upsertSession({
          sessionId: session.sessionId,
          userId: session.userId,
          personaName: session.persona.name,
          personaPrompt: session.persona.prompt,
          metadata: { user: session.userProfile, persona: session.persona },
        });
      }

      res.json({
        sessionId: session.sessionId,
        userId: session.userId,
        user: session.userProfile,
        persona: session.persona,
        history: session.getHistory(),
        resumed: false,
      });
    } catch (err) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/sessions', async (req, res) => {
    try {
      if (!sessionStore) {
        const activeSessions = [...sessions.values()].map((session) => {
          const meta = homeworkSessions.get(session.sessionId) || {};
          return {
            sessionId: session.sessionId,
            userId: session.userId,
            title: meta.title || session.persona.name,
            level: meta.level || 'primary',
            user: session.userProfile,
            persona: session.persona,
            active: true,
          };
        });
        return res.json({ sessions: activeSessions });
      }

      const storedSessions = await sessionStore.list();
      const enriched = await Promise.all(storedSessions.map(async (item) => {
        const active = sessions.get(item.sessionId);
        const persona = manager.getPersona(item.personaName);
        const userProfile = manager.getUserProfile(item.userId);
        let level = homeworkSessions.get(item.sessionId)?.level || item.metadata?.level;
        if (!level) level = normaliseHomeworkLevel();
        const title = item.title || homeworkSessions.get(item.sessionId)?.title || persona.name;
        return {
          sessionId: item.sessionId,
          userId: item.userId,
          title,
          level,
          user: userProfile,
          persona,
          storedPersona: item.personaName,
          personaPrompt: item.personaPrompt,
          lastActiveAt: item.lastActiveAt,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          active: Boolean(active),
        };
      }));

      enriched.sort((a, b) => {
        const left = new Date(a.updatedAt || a.lastActiveAt || 0).getTime();
        const right = new Date(b.updatedAt || b.lastActiveAt || 0).getTime();
        return right - left;
      });

      res.json({ sessions: enriched });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/sessions/:id', async (req, res) => {
    try {
      const sessionId = req.params.id;
      let session = sessions.get(sessionId);

      if (!session && sessionStore) {
        const stored = await sessionStore.getBySessionId(sessionId);
        if (stored) {
          session = await ensureSessionInstance({
            sessionId: stored.sessionId,
            userId: stored.userId,
            personaName: stored.personaName,
            personaPrompt: stored.personaPrompt,
          });
        }
      }

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json({ session: session.getInfo(), history: session.getHistory() });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/sessions/:id/messages', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { content } = req.body || {};
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    try {
      const result = await session.sendMessage(content);
      if (sessionStore) {
        await sessionStore.upsertSession({
          sessionId: result.sessionId,
          userId: result.userId,
          personaName: result.persona.name,
          personaPrompt: result.persona.prompt,
          metadata: { user: result.user, persona: result.persona },
          lastActiveAt: new Date(),
        });
      }
      const memorySummaries = summariseMemory(result.memories);
      const citations = memorySummaries
        .map((entry) => entry.citation)
        .filter(Boolean);
      res.json({
        sessionId: result.sessionId,
        userId: result.userId,
        user: result.user,
        persona: result.persona,
        reply: result.reply,
        memories: memorySummaries,
        citations,
        history: result.history,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const sessionId = req.params.id;
    const existed = sessions.delete(sessionId);
    if (sessionStore) {
      sessionStore.deleteSession(sessionId).catch((err) => {
        logger.warn('Failed to delete session from store:', err);
      });
    }
    if (messageStore?.deleteBySession) {
      messageStore.deleteBySession(sessionId).catch((err) => {
        logger.warn('Failed to delete messages from store:', err);
      });
    }
    res.json({ sessionId, removed: existed });
  });

  app.listen(PORT, () => {
    logger.info(`AI Champion middleware listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  logger.error('Failed to start AI Champion middleware:', err?.stack || err?.message || String(err));
  process.exit(1);
});
