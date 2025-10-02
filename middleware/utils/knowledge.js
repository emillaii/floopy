const path = require('path');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { parse: parseCsv } = require('csv-parse/sync');

const DEFAULT_CHUNK_SIZE = Number.parseInt(process.env.FLOPPY_CHUNK_SIZE || '900', 10);
const DEFAULT_MIN_CHUNK_SIZE = Number.parseInt(process.env.FLOPPY_MIN_CHUNK_SIZE || '280', 10);
const MAX_TEXT_LENGTH = Number.parseInt(process.env.FLOPPY_MAX_TEXT_LENGTH || '120000', 10);

function normalizeWhitespace(input) {
  if (!input) return '';
  return String(input)
    .replace(/\u0000/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkText(text, options = {}) {
  const chunkSize = Number.parseInt(options.chunkSize, 10) || DEFAULT_CHUNK_SIZE;
  const minChunkSize = Number.parseInt(options.minChunkSize, 10) || DEFAULT_MIN_CHUNK_SIZE;
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const words = normalized.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const chunks = [];
  let current = [];
  let currentLength = 0;

  const pushCurrent = () => {
    if (!current.length) return;
    const joined = current.join(' ').trim();
    if (joined) {
      chunks.push(joined);
    }
    current = [];
    currentLength = 0;
  };

  for (const word of words) {
    const addition = word.length + (currentLength ? 1 : 0);
    if (currentLength + addition > chunkSize && current.length) {
      pushCurrent();
    }
    current.push(word);
    currentLength += addition;
  }
  pushCurrent();

  if (chunks.length > 1 && chunks[chunks.length - 1].length < minChunkSize) {
    const tail = chunks.pop();
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${tail}`.trim();
  }

  return chunks;
}

function buildChunkObjects(text, source, options = {}) {
  const providedSegments = Array.isArray(options.segments) ? options.segments.filter(Boolean) : null;
  const segments = providedSegments && providedSegments.length
    ? providedSegments.map((segment) => normalizeWhitespace(segment)).filter(Boolean)
    : chunkText(text, options);
  const baseId = options.baseId || source.id;
  const useStableIds = Boolean(options.useStableIds);
  return segments.map((segment, index) => ({
    id: useStableIds
      ? `${baseId}:${index + 1}`
      : `${baseId}:${index + 1}:${crypto.randomUUID()}`,
    text: segment,
    sourceId: source.id,
    sourceType: source.type,
    sourceName: source.name,
    metadata: {
      ...source.metadata,
      chunkIndex: index,
      chunkCount: segments.length,
    },
  }));
}

function prepareCsvContent(records, options = {}) {
  if (!records?.length) {
    return {
      fullText: '',
      segments: [],
    };
  }

  const { chunkSize: overrideChunkSize } = options;
  const chunkSize = Number.isFinite(Number(overrideChunkSize))
    ? Number(overrideChunkSize)
    : DEFAULT_CHUNK_SIZE;

  const [rawHeader = [], ...dataRows] = records;
  const headers = (Array.isArray(rawHeader) ? rawHeader : [])
    .map((value, index) => {
      const header = String(value ?? '').trim();
      return header || `Column ${index + 1}`;
    });

  const rowLines = dataRows.map((row, rowIndex) => {
    const cells = Array.isArray(row) ? row : [];
    const pairs = headers.length
      ? headers.map((header, index) => {
          const cellValue = String(cells[index] ?? '').trim();
          return `${header}: ${cellValue}`;
        })
      : cells.map((value, index) => `Column ${index + 1}: ${String(value ?? '').trim()}`);

    return pairs.length ? `Row ${rowIndex + 1}: ${pairs.join(' | ')}` : '';
  }).filter(Boolean);

  const segments = [];
  if (!rowLines.length) {
    return {
      fullText: '',
      segments,
    };
  }
  let currentLines = [];
  let currentLength = 0;

  const pushCurrent = () => {
    if (currentLines.length) {
      segments.push(currentLines.join('\n'));
    }
    currentLines = [];
    currentLength = 0;
  };

  rowLines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const addition = (currentLines.length ? 1 : 0) + trimmed.length;
    if (currentLines.length
      && chunkSize > 0
      && currentLength + addition > chunkSize) {
      pushCurrent();
    }
    currentLines.push(trimmed);
    currentLength += addition;
  });

  if (currentLines.length) {
    segments.push(currentLines.join('\n'));
  }

  if (!segments.length) {
    segments.push(rowLines.join('\n'));
  }

  return {
    fullText: rowLines.join('\n'),
    segments,
  };
}

function stringifyCsv(records) {
  return prepareCsvContent(records).fullText;
}

async function extractFromCsv(buffer) {
  const text = buffer.toString('utf-8');
  const records = parseCsv(text, {
    skip_empty_lines: true,
    bom: true,
  });
  return prepareCsvContent(records);
}

async function extractFromPdf(buffer) {
  const { text } = await pdfParse(buffer);
  return text || '';
}

async function extractFromDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value || '';
}

async function extractTextFromFile(file) {
  if (!file?.buffer) {
    throw new Error('File buffer missing');
  }
  const { buffer, mimetype = '', originalname = '' } = file;
  const ext = path.extname(originalname).toLowerCase();
  const type = mimetype.toLowerCase();

  let text = '';
  if (type.includes('csv') || ext === '.csv') {
    const csvContent = await extractFromCsv(buffer);
    text = csvContent.fullText;
    file.__csvSegments = csvContent.segments;
  } else if (type === 'application/pdf' || ext === '.pdf') {
    text = await extractFromPdf(buffer);
  } else if (ext === '.docx'
    || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    text = await extractFromDocx(buffer);
  } else if (type.startsWith('text/') || ext === '.txt') {
    text = buffer.toString('utf-8');
  } else if (ext === '.doc') {
    throw new Error('Legacy .doc files are not supported. Convert the document to .docx and try again.');
  } else {
    throw new Error(`Unsupported file type: ${originalname || mimetype}`);
  }

  const normalized = normalizeWhitespace(text);
  if (normalized.length > MAX_TEXT_LENGTH) {
    return normalized.slice(0, MAX_TEXT_LENGTH);
  }
  return normalized;
}

module.exports = {
  normalizeWhitespace,
  chunkText,
  buildChunkObjects,
  extractTextFromFile,
  prepareCsvContent,
};
