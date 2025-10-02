const fs = require('fs');
const path = require('path');

let loaded = false;

function parseAndApplyEnv(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, 'utf-8');
  raw.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) return;
    const key = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
  return true;
}

function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    // Prefer dotenv if available to support .env.local or other variants automatically.
    require('dotenv').config();
    return;
  } catch (err) {
    if (!err || (err.code !== 'MODULE_NOT_FOUND' && !/Cannot find module/.test(err.message || ''))) {
      // dotenv exists but failed to load; surface the error for visibility.
      throw err;
    }
  }

  const candidatePaths = [
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
  ];

  for (const candidate of candidatePaths) {
    if (parseAndApplyEnv(candidate)) {
      return;
    }
  }
}

module.exports = {
  loadEnv,
};
