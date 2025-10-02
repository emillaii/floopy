#!/usr/bin/env node
// Simple retrieval test: text search against VikingDB index

const { vikingdb } = require('@volcengine/openapi');

const { loadEnv } = require('./utils/env');

loadEnv();

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

function parseArgs(argv) {
  const res = { q: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-q' || a === '--q' || a === '--query') {
      res.q = argv[++i] || '';
    } else if (a === '-k' || a === '--k' || a === '--limit') {
      res.k = parseInt(argv[++i] || '5', 10);
    } else if (a === '-i' || a === '--index') {
      res.index = argv[++i] || '';
    } else if (a === '--fields') {
      res.fields = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--partition') {
      res.partition = argv[++i] || 'default';
    }
  }
  return res;
}

async function main() {
  const args = parseArgs(process.argv);
  const {
    VIKINGDB_AK,
    VIKINGDB_SK,
    VIKINGDB_INDEX = 'viva_test_index',
    VIKINGDB_REGION = 'ap-southeast-1',
    VIKINGDB_COLLECTION = 'viva_test',
    VIKINGDB_ENDPOINT = 'api-vikingdb.mlp.ap-mya.byteplus.com',
  } = process.env;

  if (!VIKINGDB_AK || !VIKINGDB_SK) throw new Error('Missing VIKINGDB_AK or VIKINGDB_SK');
  if (!args.q || !args.q.trim()) throw new Error('Provide a query via -q "your text"');

  const service = new vikingdb.VikingdbService({ ak: VIKINGDB_AK, sk: VIKINGDB_SK, region: VIKINGDB_REGION });
  patchRegionEndpoint(service, VIKINGDB_REGION, VIKINGDB_ENDPOINT);

  const Limit = Number.isFinite(args.k) && args.k > 0 ? args.k : 5;
  const OutputFields = args.fields && args.fields.length
    ? args.fields
    : ['contentId', 'doc_id', 'title', 'description', 'genre', 'cast', 'director', 'imageLandscape'];
  const Partition = args.partition || 'default';

  const indexName = (args.index && args.index.trim()) || VIKINGDB_INDEX;
  console.log('Searching:', {
    collection: VIKINGDB_COLLECTION,
    index: indexName,
    query: args.q,
    limit: Limit,
    fields: OutputFields,
    partition: Partition,
  });

  try {
    // Optional: verify index exists to provide better error
    try {
      const list = await service.index.ListIndexes({ CollectionName: VIKINGDB_COLLECTION });
      const names = list.ListIndexes?.map?.(i => i.IndexName) || list.Infos?.map?.(i => i.IndexName) || list.data?.map?.(i => i.IndexName) || [];
      if (Array.isArray(names) && names.length && !names.includes(indexName)) {
        console.error(`Index not found: ${indexName}. Available: ${names.join(', ')}`);
        process.exit(1);
      }
    } catch (_) {
      // ignore failures; proceed to search
    }

    const resp = await service.search.SearchByText({
      CollectionName: VIKINGDB_COLLECTION,
      IndexName: indexName,
      Text: args.q,
      Limit,
      OutputFields,
      Partition,
    });
    const groups = resp.Data; // array of arrays
    const flat = groups.flat();
    if (!flat.length) {
      console.log('No results');
      return;
    }
    flat.forEach((item, idx) => {
      const f = item.Fields || {};
      const contentId = f.contentId || f.doc_id || f.id;
      const line = {
        rank: idx + 1,
        score: item.Score,
        title: f.title,
        contentId,
      };
      console.log(line);
    });
  } catch (e) {
    console.error('Search error:', e?.message || e);
    process.exit(1);
  }
}

main();
