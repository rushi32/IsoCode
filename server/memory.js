// server/memory.js - Persistent key-value store for agent (survives LM Studio restarts)
const fs = require('fs');
const path = require('path');

const MEMORY_PATH = path.join(process.cwd(), '.isocode', 'agent-memory.json');
const MAX_KEYS = 200;
const MAX_VALUE_LENGTH = 8000;

function ensureDir() {
  const dir = path.dirname(MEMORY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadMemory() {
  try {
    ensureDir();
    const raw = fs.readFileSync(MEMORY_PATH, 'utf8');
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? data : {};
  } catch {
    return {};
  }
}

function saveMemory(obj) {
  ensureDir();
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

function memoryRead(key) {
  const mem = loadMemory();
  const value = mem[key];
  return value != null ? String(value) : null;
}

function memoryWrite(key, value) {
  const mem = loadMemory();
  const keys = Object.keys(mem);
  if (keys.length >= MAX_KEYS && !(key in mem)) {
    const oldest = keys[0];
    delete mem[oldest];
  }
  const str = value != null ? String(value).slice(0, MAX_VALUE_LENGTH) : '';
  mem[key] = str;
  saveMemory(mem);
  return { ok: true, key };
}

function memoryList() {
  const mem = loadMemory();
  return { keys: Object.keys(mem) };
}

module.exports = { memoryRead, memoryWrite, memoryList };
