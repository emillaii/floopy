#!/usr/bin/env node
// Core utilities for the AI Champion chatbot.
// Provides reusable helpers for managing VikingDB-backed chat sessions
// and invoking an LLM with persona-aware prompts.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { vikingdb } = require('@volcengine/openapi');
const { CharacterStore } = require('./character_store');
const { DEFAULT_CHARACTER_CARDS } = require('./default_characters');
const { UserStore } = require('./user_store');
const { DEFAULT_USERS } = require('./default_users');

const { loadEnv } = require('./utils/env');

loadEnv();

// ----- Shared helpers -----
function ensureHttpPrefix(endpoint) {
  if (!endpoint) return endpoint;
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
  return `https://${endpoint}`;
}

function patchRegionEndpoint(service, region, endpoint) {
  if (!endpoint) return;
  const url = ensureHttpPrefix(endpoint);
  ['collection', 'index', 'data', 'search', 'embedding', 'custom', 'task'].forEach((k) => {
    if (service[k] && service[k].region2Url) {
      service[k].region2Url[region] = url;
    }
  });
}

function parseCsv(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parsePersonaConfig(raw) {
  if (!raw) return [];
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [namePart, ...promptParts] = entry.split('|');
      const name = namePart?.trim();
      const prompt = promptParts.join('|').trim();
      if (!name) return null;
      return { name, prompt };
    })
    .filter(Boolean);
}

const DEFAULT_PERSONAS = DEFAULT_CHARACTER_CARDS.map((character) => ({
  name: character.name,
  prompt: character.prompt,
}));

async function ensureChatCollection(service, config) {
  const {
    collectionName,
    embModel,
    embDim,
    description,
  } = config;

  const Fields = [
    { FieldName: 'doc_id', FieldType: vikingdb.FieldType.String, IsPrimary: true },
    { FieldName: 'sessionId', FieldType: vikingdb.FieldType.String },
    { FieldName: 'role', FieldType: vikingdb.FieldType.String },
    { FieldName: 'content', FieldType: vikingdb.FieldType.String },
    { FieldName: 'createdAt', FieldType: vikingdb.FieldType.String },
    { FieldName: 'model', FieldType: vikingdb.FieldType.String },
    { FieldName: 'metadata', FieldType: vikingdb.FieldType.String },
    { FieldName: 'text_embed', FieldType: vikingdb.FieldType.Text },
  ];

  const Vectorize = [{
    dense: {
      text_field: 'text_embed',
      model_name: embModel,
      dim: embDim,
    },
  }];

  try {
    await service.collection.CreateCollection({
      CollectionName: collectionName,
      Description: description,
      Fields,
      Vectorize,
    });
  } catch (err) {
    if (String(err?.Code) === '1000004') {
      return;
    }
    if (err?.message) {
      throw new Error(`Failed to ensure collection: ${err.message}`);
    }
    throw err;
  }
}

async function ensureChatIndex(service, config) {
  const {
    collectionName,
    indexName,
    description,
    distance = 'cosine',
    quant = 'float',
    shardPolicy = 'auto',
    hnswM = 32,
  } = config;

  try {
    const list = await service.index.ListIndexes({ CollectionName: collectionName });
    const names = list?.ListIndexes?.map?.((info) => info.IndexName)
      || list?.Infos?.map?.((info) => info.IndexName)
      || list?.data?.map?.((info) => info.IndexName)
      || [];
    if (names.includes(indexName)) {
      return;
    }
  } catch (err) {
    // Non-fatal; proceed to create
  }

  try {
    await service.index.CreateIndex({
      CollectionName: collectionName,
      IndexName: indexName,
      Description: description,
      ShardConfig: { ShardPolicy: shardPolicy },
      VectorIndex: {
        IndexType: 'hnsw',
        Distance: distance,
        Quant: quant,
        HnswM: hnswM,
      },
    });
  } catch (err) {
    if (String(err?.Code) === '1000004') {
      return;
    }
    throw new Error(`Failed to ensure index: ${err?.message || err}`);
  }
}

async function waitForIndexReady(service, collectionName, indexName, options = {}) {
  const { timeoutMs = 120_000, pollIntervalMs = 5_000 } = options;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let status;
    try {
      const info = await service.index.GetIndexInfo({
        CollectionName: collectionName,
        IndexName: indexName,
      });
      status = info?.IndexInfo?.Status
        || info?.IndexInfo?.status
        || info?.indexInfo?.Status
        || info?.indexInfo?.status;
      if (status === 'READY') {
        return;
      }
    } catch (err) {
      // ignore and keep polling
    }

    if (Date.now() > deadline) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function upsertMessage(service, collectionName, field) {
  await service.data.UpsertData({
    CollectionName: collectionName,
    Fields: [field],
    Async: false,
  });
}

async function searchContext(service, collectionName, indexName, query, limit, sessionId) {
  if (!query || !query.trim()) return [];
  const resp = await service.search.SearchByText({
    CollectionName: collectionName,
    IndexName: indexName,
    Text: query,
    Limit: limit,
    OutputFields: ['doc_id', 'role', 'content', 'sessionId', 'createdAt', 'model', 'metadata'],
  });
  const rawGroups = resp.Data || [];
  const flat = rawGroups.flat();
  const filtered = sessionId
    ? flat.filter((item) => item?.Fields?.sessionId === sessionId)
    : flat;
  return filtered.slice(0, limit);
}

function parseMemoryMetadataValue(value) {
  if (value == null) {
    return { data: {}, raw: null };
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return { data: parsed && typeof parsed === 'object' ? parsed : {}, raw: value };
    } catch (err) {
      return { data: { raw: value }, raw: value };
    }
  }
  if (typeof value === 'object') {
    return { data: { ...value }, raw: null };
  }
  return { data: {}, raw: value };
}

function deriveMemorySourceLabel(metadata, fallback, defaultLabel) {
  return metadata.sourceName
    || metadata.title
    || metadata.filename
    || metadata.documentTitle
    || metadata.docTitle
    || metadata.source
    || metadata.groupName
    || fallback
    || defaultLabel;
}

function extractMemoryUrl(metadata) {
  return metadata.url || metadata.sourceUrl || metadata.link || metadata.href || null;
}

function extractMemoryKeywords(metadata, limit = 8) {
  if (!Array.isArray(metadata.keywords)) return [];
  return metadata.keywords
    .map((word) => (typeof word === 'string' ? word.trim() : ''))
    .filter(Boolean)
    .slice(0, limit);
}

function buildMemorySnippet(items) {
  if (!items || !items.length) return 'No earlier memory retrieved.';
  return items
    .map((item, index) => {
      const f = item.Fields || {};
      const when = f.createdAt ? new Date(f.createdAt).toLocaleString() : '';
      const { data: metadata } = parseMemoryMetadataValue(f.metadata);
      const sourceLabel = deriveMemorySourceLabel(metadata, f.doc_id, `Source ${index + 1}`);
      const url = extractMemoryUrl(metadata);
      const keywords = extractMemoryKeywords(metadata, 5);

      const headerSegments = [];
      headerSegments.push(`${(f.role || 'unknown').toUpperCase()}${when ? ` (${when})` : ''}`);
      if (sourceLabel) headerSegments.push(`Source: ${sourceLabel}`);
      if (url) headerSegments.push(`URL: ${url}`);
      if (keywords.length) headerSegments.push(`Keywords: ${keywords.join(', ')}`);

      return `${headerSegments.join(' | ')}\n${f.content}`;
    })
    .join('\n---\n');
}

async function callLLM(config, messages) {
  const {
    apiUrl,
    apiKey,
    apiKeyHeader,
    apiKeyPrefix,
    model,
    temperature,
    topP,
    extraHeaders,
  } = config;

  if (!apiUrl || !apiKey) {
    return { content: null, reason: 'LLM credentials missing' };
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(extraHeaders || {}),
  };
  const prefix = apiKeyPrefix || '';
  const trimmedPrefix = prefix.trim();
  const trimmedKey = apiKey.trim();
  const useKey = trimmedPrefix && trimmedKey.startsWith(trimmedPrefix)
    ? trimmedKey
    : `${prefix}${trimmedKey}`;
  headers[apiKeyHeader] = useKey;

  const body = {
    model,
    messages,
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (typeof topP === 'number') body.top_p = topP;

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM request failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  return { content: content?.trim?.() || '', raw: data };
}

function fallbackResponder(userInput, memories, persona) {
  const bulletMemories = memories.slice(0, 3).map((item) => {
    const f = item.Fields || {};
    const role = (f.role || 'unknown').toUpperCase();
    return `- ${role}: ${f.content}`;
  });
  const memoryText = bulletMemories.length
    ? `\nRelevant memories:\n${bulletMemories.join('\n')}`
    : '';
  const personaText = persona?.name ? ` while staying in persona "${persona.name}"` : '';
  return `I am running without an LLM backend right now${personaText}. You said: "${userInput}".${memoryText}`;
}

function buildMessages(systemPrompt, persona, userId, memories, history, userInput) {
  const memorySnippet = buildMemorySnippet(memories);
  const contextBlock = memories.length
    ? `Here are the most relevant context snippets (chat history and knowledge):\n${memorySnippet}`
    : 'No prior context was retrieved for this query.';

  const messages = [
    { role: 'system', content: systemPrompt },
    persona?.prompt
      ? { role: 'system', content: `Persona profile (${persona.name}): ${persona.prompt}` }
      : { role: 'system', content: `Persona profile (${persona?.name || 'Champion'}): Stay consistent, supportive, and memory-aware.` },
    { role: 'system', content: `You are currently speaking with user "${userId}". Personalise responses for this user while respecting healthy boundaries.` },
    { role: 'system', content: 'When you reference the context snippets, cite their source names in square brackets (e.g., [Manual knowledge]). If a URL is provided, share it so the user can follow up.' },
    { role: 'system', content: contextBlock },
    ...history.map((msg) => ({ role: msg.role, content: msg.content })),
    { role: 'user', content: userInput },
  ];
  return messages;
}

class ChampionChatSession {
  constructor(manager, options) {
    this.manager = manager;
    this.userId = options.userId;
    this.userProfile = options.userProfile || null;
    this.persona = options.persona;
    this.sessionId = options.sessionId;
    this.messageMetadata = options.messageMetadata;
    this.historyLimit = options.historyLimit;
    this.topK = options.topK;
    this.history = [];
    this.memoryProviders = Array.isArray(options.memoryProviders)
      ? options.memoryProviders.filter((fn) => typeof fn === 'function')
      : [];
  }

  getInfo() {
    return {
      sessionId: this.sessionId,
      userId: this.userId,
      user: this.userProfile,
      persona: this.persona,
    };
  }

  getHistory() {
    return this.history.map((item) => ({ ...item }));
  }

  addMemoryProvider(provider) {
    if (typeof provider !== 'function') return;
    if (!Array.isArray(this.memoryProviders)) {
      this.memoryProviders = [];
    }
    this.memoryProviders.push(provider);
  }

  async sendMessage(userInput) {
    const {
      service,
      config,
      collectionName,
      indexName,
    } = this.manager;

    const userDocId = `${this.sessionId}-user-${Date.now()}`;
    const createdAt = new Date().toISOString();
    const userField = {
      doc_id: userDocId,
      sessionId: this.sessionId,
      role: 'user',
      content: userInput,
      createdAt,
      model: 'human',
      metadata: this.messageMetadata,
      text_embed: userInput,
    };

    await upsertMessage(service, collectionName, userField);
    this.history.push({ role: 'user', content: userInput });
    while (this.history.length > this.historyLimit * 2) {
      this.history.shift();
    }

    let memories = [];
    // eslint-disable-next-line no-console
    console.log(`[Champion][Memory] Skipping VikingDB search for ${this.sessionId}; using external providers only.`);

    if (Array.isArray(this.memoryProviders) && this.memoryProviders.length) {
      const external = [];
      for (const provider of this.memoryProviders) {
        try {
          const results = await provider({
            query: userInput,
            topK: this.topK,
            session: this,
            history: this.history.slice(),
          });
          if (Array.isArray(results) && results.length) {
            external.push(...results);
          }
        } catch (err) {
          console.warn('[Champion] Memory provider failed:', err?.message || err);
        }
      }
      memories = external;
    }

    if (memories.length) {
      const preview = memories.slice(0, 3).map((item) => {
        const fields = item?.Fields || {};
        return {
          docId: fields.doc_id,
          role: fields.role,
          score: item?.Score,
          snippet: typeof fields.content === 'string' ? fields.content.slice(0, 120) : null,
        };
      });
      // eslint-disable-next-line no-console
      console.log(
        `[Champion][Memory] Retrieved ${memories.length} context chunk${memories.length === 1 ? '' : 's'} for ${this.sessionId}. Preview:`,
        preview,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(`[Champion][Memory] No external context found for ${this.sessionId}.`);
    }

    const promptHistory = this.history.slice(-this.historyLimit * 2);
    if (promptHistory.length && promptHistory[promptHistory.length - 1]?.role === 'user') {
      promptHistory.pop();
    }

    const messages = buildMessages(
      config.systemPrompt,
      this.persona,
      this.userId,
      memories,
      promptHistory,
      userInput,
    );

    try {
      const contextLog = {
        sessionId: this.sessionId,
        userId: this.userId,
        persona: this.persona?.name,
        messageCount: messages.length,
        messages,
        memoryPreview: buildMemorySnippet(memories),
      };
      // eslint-disable-next-line no-console
      console.log(`[Champion][LLM Input] ${this.sessionId}`, JSON.stringify(contextLog, null, 2));
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.warn('Failed to serialise LLM context for logging:', logErr);
    }

    let assistantReply;
    try {
      const llmResponse = await callLLM(config.llm, messages);
      if (!llmResponse.content) {
        assistantReply = fallbackResponder(userInput, memories, this.persona);
      } else {
        assistantReply = llmResponse.content;
      }
    } catch (err) {
      assistantReply = fallbackResponder(userInput, memories, this.persona);
    }

    const assistantDocId = `${this.sessionId}-assistant-${Date.now()}`;
    const assistantField = {
      doc_id: assistantDocId,
      sessionId: this.sessionId,
      role: 'assistant',
      content: assistantReply,
      createdAt: new Date().toISOString(),
      model: this.manager.config.llm.model,
      metadata: this.messageMetadata,
      text_embed: assistantReply,
    };
    await upsertMessage(service, collectionName, assistantField);

    this.history.push({ role: 'assistant', content: assistantReply });
    while (this.history.length > this.historyLimit * 2) {
      this.history.shift();
    }

    return {
      reply: assistantReply,
      persona: this.persona,
      sessionId: this.sessionId,
      userId: this.userId,
      user: this.userProfile,
      memories,
      history: this.getHistory(),
    };
  }
}

class ChampionChatManager {
  constructor(envOverrides = {}, dependencies = {}) {
    const {
      VIKINGDB_AK,
      VIKINGDB_SK,
      VIKINGDB_REGION = 'ap-southeast-1',
      VIKINGDB_ENDPOINT = 'api-vikingdb.mlp.ap-mya.byteplus.com',
      VIKINGDB_CHAT_COLLECTION = 'ai_champion_chat_memory',
      VIKINGDB_CHAT_INDEX,
      VIKINGDB_EMB_MODEL = 'bge-visualized-m3',
      VIKINGDB_EMB_DIM = '1024',
      CHAT_TOP_K = '6',
      CHAT_HISTORY_LIMIT = '8',
      CHAT_SYSTEM_PROMPT = 'You are the AI Champion assistant. Use provided memory to answer succinctly and helpfully. If memory is empty, rely on your general reasoning.',
      CHAT_USERS,
      CHAT_DEFAULT_USER,
      CHAT_PERSONAS,
      CHAT_PERSONA_DEFAULT,
      CHAT_INDEX_TIMEOUT_MS = '120000',
      CHAT_INDEX_POLL_MS = '5000',
      LLM_API_URL,
      LLM_API_KEY,
      LLM_MODEL = 'gpt-4o-mini',
      LLM_TEMPERATURE,
      LLM_TOP_P,
      LLM_API_KEY_HEADER = 'Authorization',
      LLM_API_KEY_PREFIX = 'Bearer ',
      MONGO_URI,
      MONGO_DB_NAME,
      MONGO_CHARACTER_COLLECTION = 'characters',
      MONGO_USER_COLLECTION = 'users',
    } = { ...process.env, ...envOverrides };

    if (!VIKINGDB_AK || !VIKINGDB_SK) {
      throw new Error('Missing VIKINGDB_AK or VIKINGDB_SK environment variables.');
    }

    this.collectionName = VIKINGDB_CHAT_COLLECTION;
    this.indexName = (VIKINGDB_CHAT_INDEX && VIKINGDB_CHAT_INDEX.trim()) || VIKINGDB_CHAT_COLLECTION;
    this.embModel = VIKINGDB_EMB_MODEL;
    this.embDim = Number.parseInt(String(VIKINGDB_EMB_DIM), 10) || 1024;

    this.service = new vikingdb.VikingdbService({
      ak: VIKINGDB_AK,
      sk: VIKINGDB_SK,
      region: VIKINGDB_REGION,
    });
    patchRegionEndpoint(this.service, VIKINGDB_REGION, VIKINGDB_ENDPOINT);

    this.topK = Number.parseInt(String(CHAT_TOP_K), 10) || 6;
    this.historyLimit = Number.parseInt(String(CHAT_HISTORY_LIMIT), 10) || 8;
    this.indexTimeoutMs = Number.parseInt(String(CHAT_INDEX_TIMEOUT_MS), 10) || 120_000;
    this.indexPollMs = Number.parseInt(String(CHAT_INDEX_POLL_MS), 10) || 5_000;

    this.envUsers = parseCsv(CHAT_USERS).map((u) => u.trim()).filter(Boolean);
    this.envDefaultUser = (CHAT_DEFAULT_USER && CHAT_DEFAULT_USER.trim()) || null;

    this.characterStore = dependencies.characterStore || null;
    if (!this.characterStore && MONGO_URI) {
      this.characterStore = new CharacterStore({
        uri: MONGO_URI,
        dbName: MONGO_DB_NAME,
        collectionName: MONGO_CHARACTER_COLLECTION,
      });
    }
    if (!this.characterStore) {
      console.warn('MONGO_URI not provided. Falling back to built-in persona configuration.');
    }

    this.userStore = dependencies.userStore || null;
    if (!this.userStore && MONGO_URI) {
      this.userStore = new UserStore({
        uri: MONGO_URI,
        dbName: MONGO_DB_NAME,
        collectionName: MONGO_USER_COLLECTION,
      });
    }
    if (!this.userStore) {
      console.warn('MONGO_URI not provided. Falling back to built-in user configuration.');
    }

    this.envPersonaConfig = parsePersonaConfig(CHAT_PERSONAS);
    this.envDefaultPersona = (CHAT_PERSONA_DEFAULT && CHAT_PERSONA_DEFAULT.trim()) || null;
    this.personas = [];
    this.defaultPersona = null;
    this.users = [];
    this.defaultUser = null;

    this.config = {
      systemPrompt: CHAT_SYSTEM_PROMPT,
      llm: {
        apiUrl: LLM_API_URL,
        apiKey: LLM_API_KEY,
        apiKeyHeader: LLM_API_KEY_HEADER,
        apiKeyPrefix: LLM_API_KEY_PREFIX,
        model: LLM_MODEL,
        temperature: Number.isFinite(Number(LLM_TEMPERATURE)) ? Number(LLM_TEMPERATURE) : undefined,
        topP: Number.isFinite(Number(LLM_TOP_P)) ? Number(LLM_TOP_P) : undefined,
        extraHeaders: {},
      },
    };
  }

  async init() {
    await ensureChatCollection(this.service, {
      collectionName: this.collectionName,
      embModel: this.embModel,
      embDim: this.embDim,
      description: 'Chatbot memory collection for AI Champion assistant',
    });

    await ensureChatIndex(this.service, {
      collectionName: this.collectionName,
      indexName: this.indexName,
      description: 'HNSW chat memory index',
    });

    await waitForIndexReady(this.service, this.collectionName, this.indexName, {
      timeoutMs: this.indexTimeoutMs,
      pollIntervalMs: this.indexPollMs,
    });

    if (this.userStore) {
      await this.userStore.connect();
      await this.userStore.ensureDefaults();
    }

    if (this.characterStore) {
      await this.characterStore.connect();
      await this.characterStore.ensureDefaults();
    }

    await this.reloadUsers();
    await this.reloadPersonas();
  }

  async reloadPersonas() {
    let personas = [];

    if (this.characterStore) {
      try {
        const characters = await this.characterStore.list();
        personas = characters.map((character) => ({
          id: character.id || character.name,
          name: character.name,
          prompt: character.prompt,
          image: character.image || '',
          voiceId: character.voiceId || '',
        }));
      } catch (err) {
        console.warn('Failed to load characters from MongoDB:', err?.message || err);
      }
    }

    if (!personas.length) {
      let fallback = (this.envPersonaConfig || []).map((p) => ({
        id: p.name,
        name: p.name,
        prompt: p.prompt,
        image: '',
        voiceId: '',
      }));

      if (!fallback.length) {
        fallback = DEFAULT_CHARACTER_CARDS.map((p) => ({
          id: p.name,
          name: p.name,
          prompt: p.prompt,
          image: p.image || '',
          voiceId: p.voiceId || '',
        }));
      }

      personas = fallback;
    }

    const unique = [];
    const seen = new Set();
    personas.forEach((persona) => {
      if (!persona?.name) return;
      const key = persona.name;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push({
        id: persona.id || persona.name,
        name: persona.name,
        prompt: persona.prompt,
        image: persona.image || '',
        voiceId: persona.voiceId || '',
      });
    });

    this.personas = unique;

    if (this.envDefaultPersona && seen.has(this.envDefaultPersona)) {
      this.defaultPersona = this.envDefaultPersona;
    } else {
      this.defaultPersona = this.personas[0]?.name || 'Champion';
    }

    return this.personas;
  }

  async reloadUsers() {
    let users = [];

    if (this.userStore) {
      try {
        const records = await this.userStore.list();
        users = records.map((record) => ({
          id: record.id || record.userId,
          userId: record.userId,
          displayName: record.displayName || record.userId,
          avatar: record.avatar || '',
        }));
      } catch (err) {
        console.warn('Failed to load users from MongoDB:', err?.message || err);
      }
    }

    if (!users.length) {
      let fallback = (this.envUsers || []).map((userId) => ({
        id: userId,
        userId,
        displayName: userId,
        avatar: '',
        label: userId,
      }));

      if (!fallback.length) {
        fallback = DEFAULT_USERS.map((user) => ({
          id: user.userId,
          userId: user.userId,
          displayName: user.displayName || user.userId,
          avatar: user.avatar || '',
          label: user.displayName || user.userId,
        }));
      }

      users = fallback;
    }

    const unique = [];
    const seen = new Set();
    users.forEach((user) => {
      const key = user?.userId || user?.name || user?.id;
      if (!key || seen.has(key)) return;
      seen.add(key);
      const displayName = user.displayName || user.name || key;
      unique.push({
        id: user.id || key,
        userId: key,
        displayName,
        avatar: user.avatar || '',
        label: displayName,
      });
    });

    this.users = unique;

    if (this.envDefaultUser && seen.has(this.envDefaultUser)) {
      this.defaultUser = this.envDefaultUser;
    } else {
      this.defaultUser = this.users[0]?.userId || 'default_user';
    }

    return this.users;
  }

  listUsers() {
    return this.users.map((user) => ({
      id: user.id || user.userId,
      userId: user.userId,
      displayName: user.displayName || user.userId,
      avatar: user.avatar || '',
      label: user.displayName || user.userId,
    }));
  }

  listPersonas() {
    return this.personas.map((p) => ({
      id: p.id || p.name,
      name: p.name,
      prompt: p.prompt,
      image: p.image || '',
      voiceId: p.voiceId || '',
    }));
  }

  getUserProfile(userId) {
    if (!this.users.length || !userId) return null;
    return this.users.find((user) => user.userId === userId)
      || null;
  }

  getPersona(identifier) {
    if (!this.personas.length) {
      const fallback = DEFAULT_CHARACTER_CARDS[0];
      return {
        id: fallback.name,
        name: fallback.name,
        prompt: fallback.prompt,
        image: fallback.image || '',
        voiceId: fallback.voiceId || '',
      };
    }
    return this.personas.find((p) => p.name === identifier || p.id === identifier)
      || this.personas[0];
  }

  addOrUpdateUser(user) {
    if (!user || !user.userId) {
      throw new Error('User profile requires a userId');
    }

    const normalized = {
      id: user.id || user.userId,
      userId: user.userId,
      displayName: user.displayName || user.userId,
      avatar: user.avatar || '',
      label: user.displayName || user.userId,
    };

    const index = this.users.findIndex((item) => item.userId === normalized.userId);
    if (index >= 0) {
      this.users[index] = normalized;
    } else {
      this.users.push(normalized);
    }

    if (!this.defaultUser) {
      this.defaultUser = normalized.userId;
    }

    return normalized;
  }

  createSession(options = {}) {
    const {
      userId,
      personaName = this.defaultPersona,
      personaPrompt,
      personaImage,
      sessionId,
      newSessionPerRun = false,
      memoryProviders = [],
    } = options;

    const personaBase = personaPrompt
      ? { id: personaName, name: personaName, prompt: personaPrompt }
      : this.getPersona(personaName);
    const resolvedImage = personaImage || personaBase?.image || '';
    const persona = {
      id: personaBase?.id || personaBase?.name || personaName || 'Champion',
      name: personaBase?.name || personaName || 'Champion',
      prompt: personaPrompt || personaBase?.prompt || DEFAULT_PERSONAS[0].prompt,
      image: resolvedImage,
      voiceId: personaBase?.voiceId || '',
    };

    let resolvedUserId = userId || this.defaultUser;
    if (!resolvedUserId) {
      resolvedUserId = this.users[0]?.userId || 'default_user';
    }

    const userProfile = this.getUserProfile(resolvedUserId) || {
      id: resolvedUserId,
      userId: resolvedUserId,
      displayName: resolvedUserId,
      avatar: '',
      label: resolvedUserId,
    };

    const baseSessionId = `${resolvedUserId}:${persona.name}`;
    let resolvedSessionId = sessionId;
    if (!resolvedSessionId || newSessionPerRun || options.forceNewSession) {
      resolvedSessionId = `${baseSessionId}-${crypto.randomUUID()}`;
    }

    const metadata = JSON.stringify({
      userId: resolvedUserId,
      userDisplayName: userProfile.displayName,
      persona: persona.name,
    });

    return new ChampionChatSession(this, {
      userId: resolvedUserId,
      userProfile,
      persona,
      sessionId: resolvedSessionId,
      messageMetadata: metadata,
      historyLimit: this.historyLimit,
      topK: this.topK,
      memoryProviders,
    });
  }
}

module.exports = {
  ChampionChatManager,
  ChampionChatSession,
  DEFAULT_PERSONAS,
  DEFAULT_CHARACTER_CARDS,
  DEFAULT_USERS,
  parseCsv,
  parseBoolean,
  parsePersonaConfig,
  ensureChatCollection,
  ensureChatIndex,
  waitForIndexReady,
};
