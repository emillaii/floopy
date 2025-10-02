#!/usr/bin/env node
// Node.js version of vectorDB/demo_3.py for VikingDB ingestion
// Reads a VivaOne-style metadata JSON and upserts into a VikingDB collection.

/*
Required env vars:
  - VIKINGDB_AK: Access Key ID
  - VIKINGDB_SK: Secret Access Key (base64-encoded, same as Python SDK expects)
  - VIKINGDB_REGION: Region string (e.g., "ap-southeast-1")
  - VIKINGDB_COLLECTION: Target collection name
Optional env vars:
  - VIKINGDB_ENDPOINT: Override API host (e.g., "api-vikingdb.mlp.ap-mya.byteplus.com")
  - BATCH_SIZE: Upsert batch size (default: 100)
Usage:
  node middleware/ingest_vivaone.js --file ../vivaone_metadata/metadata.json
*/

const fs = require('fs/promises');
const path = require('path');
const { vikingdb } = require('@volcengine/openapi');

const { loadEnv } = require('./utils/env');

loadEnv();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') {
      args.file = argv[++i];
    } else if (a.includes('=')) {
      const [k, v] = a.split('=');
      args[k.replace(/^--?/, '')] = v;
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = true;
    }
  }
  return args;
}

function ensureHttpPrefix(endpoint) {
  if (!endpoint) return endpoint;
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
  return `https://${endpoint}`;
}

function patchRegionEndpoint(service, region, endpoint) {
  if (!endpoint) return;
  const url = ensureHttpPrefix(endpoint);
  // Patch all sub-services to know the custom region baseURL
  ['collection', 'index', 'data', 'search', 'embedding', 'custom', 'task'].forEach((k) => {
    if (service[k] && service[k].region2Url) {
      service[k].region2Url[region] = url;
    }
  });
}

async function loadJson(filePath) {
  const abs = path.resolve(__dirname, filePath);
  const raw = await fs.readFile(abs, 'utf-8');
  return JSON.parse(raw);
}

function buildFields(items) {
  const fields = [];
  for (const item of items) {
    const contentId = item?.contentId ?? '';
    const contentType = item?.contentType ?? '';
    const metadata = (item?.metadata ?? [{}])[0] ?? {};

    const title = metadata?.title ?? '';
    const description = metadata?.description ?? '';
    const cast = metadata?.cast ?? [];
    const director = metadata?.director ?? [];
    const genre = metadata?.genre ?? [];
    const lang = metadata?.lang ?? '';
    const rating = item?.rating ?? '';
    const imageLandscape = item?.imageLandscape ?? '';
    const imagePortrait = item?.imagePortrait ?? '';

    const text_embed_parts = [description]
      .concat(Array.isArray(genre) ? genre : [genre])
      .concat(Array.isArray(cast) ? cast : [cast])
      .concat(Array.isArray(director) ? director : [director]);
    const text_embed = text_embed_parts
      .filter((p) => p != null && `${p}`.trim() !== '')
      .map(String)
      .join(' ');

    const field = {
      doc_id: contentId,
      contentId,
      contentType,
      title,
      cast,
      director,
      genre,
      description,
      lang,
      rating,
      imageLandscape,
      imagePortrait,
      text_embed,
    };

    fields.push(field);
  }
  return fields;
}

async function batchUpsert(service, collectionName, fields, batchSize = 100) {
  for (let i = 0; i < fields.length; i += batchSize) {
    const batch = fields.slice(i, i + batchSize);
    try {
      await service.data.UpsertData({
        CollectionName: collectionName,
        Fields: batch,
        Async: false,
      });
      console.log(`Inserted batch ${Math.floor(i / batchSize) + 1} (${batch.length} entries)`);
    } catch (err) {
      const msg = err?.message || err?.toString?.() || 'Unknown error';
      console.error(`Error in batch ${Math.floor(i / batchSize) + 1}: ${msg}`);
      // backoff a bit in case of rate limiting
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const {
    VIKINGDB_AK,
    VIKINGDB_SK,
    VIKINGDB_REGION = 'ap-southeast-1',
    VIKINGDB_COLLECTION = 'vivaone_metadata_embed_demo',
    VIKINGDB_ENDPOINT,
    BATCH_SIZE = '100',
  } = process.env;

  if (!VIKINGDB_AK || !VIKINGDB_SK) {
    throw new Error('Missing VIKINGDB_AK or VIKINGDB_SK environment variables');
  }
  if (!args.file) {
    throw new Error('Missing --file <path-to-json> argument');
  }

  const service = new vikingdb.VikingdbService({ ak: VIKINGDB_AK, sk: VIKINGDB_SK, region: VIKINGDB_REGION });
  patchRegionEndpoint(service, VIKINGDB_REGION, VIKINGDB_ENDPOINT || 'api-vikingdb.mlp.ap-mya.byteplus.com');

  const items = await loadJson(args.file);
  const fields = buildFields(items);
  const batchSize = Number.parseInt(String(BATCH_SIZE), 10) || 100;

  await batchUpsert(service, VIKINGDB_COLLECTION, fields, batchSize);
  console.log(`All ${fields.length} documents ingested.`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
