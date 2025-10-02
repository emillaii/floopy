#!/usr/bin/env node
// Create a VikingDB collection for VivaOne metadata (Node.js)

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

async function main() {
  const {
    VIKINGDB_AK,
    VIKINGDB_SK,
    VIKINGDB_REGION = 'ap-southeast-1',
    VIKINGDB_COLLECTION = 'vivaone_metadata_embed_demo',
    VIKINGDB_ENDPOINT = 'api-vikingdb.mlp.ap-mya.byteplus.com',
    VIKINGDB_EMB_MODEL = 'bge-visualized-m3',
    VIKINGDB_EMB_DIM = '1024',
  } = process.env;

  if (!VIKINGDB_AK || !VIKINGDB_SK) {
    throw new Error('Missing VIKINGDB_AK or VIKINGDB_SK');
  }

  const service = new vikingdb.VikingdbService({ ak: VIKINGDB_AK, sk: VIKINGDB_SK, region: VIKINGDB_REGION });
  patchRegionEndpoint(service, VIKINGDB_REGION, VIKINGDB_ENDPOINT);

  const Fields = [
    { FieldName: 'doc_id', FieldType: vikingdb.FieldType.String, IsPrimary: true },
    { FieldName: 'contentId', FieldType: vikingdb.FieldType.String },
    { FieldName: 'contentType', FieldType: vikingdb.FieldType.String },
    { FieldName: 'title', FieldType: vikingdb.FieldType.String },
    { FieldName: 'cast', FieldType: vikingdb.FieldType.ListString },
    { FieldName: 'director', FieldType: vikingdb.FieldType.ListString },
    { FieldName: 'genre', FieldType: vikingdb.FieldType.ListString },
    { FieldName: 'description', FieldType: vikingdb.FieldType.String },
    { FieldName: 'lang', FieldType: vikingdb.FieldType.String },
    { FieldName: 'rating', FieldType: vikingdb.FieldType.String },
    { FieldName: 'imageLandscape', FieldType: vikingdb.FieldType.String },
    { FieldName: 'imagePortrait', FieldType: vikingdb.FieldType.String },
    // Text field to be vectorized
    { FieldName: 'text_embed', FieldType: vikingdb.FieldType.Text },
  ];

  const Vectorize = [{
    dense: {
      text_field: 'text_embed',
      model_name: VIKINGDB_EMB_MODEL,
      dim: parseInt(String(VIKINGDB_EMB_DIM), 10) || 1024,
    },
  }];

  const Description = 'VivaOne metadata collection with server-side text embedding on text_embed';

  try {
    const res = await service.collection.CreateCollection({
      CollectionName: VIKINGDB_COLLECTION,
      Description,
      Fields,
      Vectorize,
    });
    console.log('CreateCollection OK. LogId:', res.LogId);
  } catch (e) {
    if (e && e.Code && e.Message) {
      // If already exists, surface a friendly message
      if (String(e.Code) === '1000004') {
        console.log(`Collection ${VIKINGDB_COLLECTION} already exists.`);
        return;
      }
      console.error(`CreateCollection error [${e.Code}]: ${e.Message}`);
    } else {
      console.error('CreateCollection error:', e?.message || String(e));
    }
    process.exit(1);
  }
}

main();

