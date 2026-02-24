#!/usr/bin/env node
/**
 * Quick test for IsoCode server: /models and /chat (Chat mode).
 * Run with: node server/scripts/test-chat.js
 * Requires: server running on PORT (default 3000), LM Studio running with a model loaded.
 */
const http = require('http');

const BASE = 'http://localhost:3000';
const MODELS_PATH = '/models';
const CHAT_PATH = '/chat';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body && (method === 'POST' || method === 'PUT')) {
      const data = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const parsed = buf ? JSON.parse(buf) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data: buf });
        }
      });
    });
    req.on('error', reject);
    if (body && (method === 'POST' || method === 'PUT')) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  console.log('IsoCode server test (Chat + Models)\n');
  let failed = 0;

  // 1. GET /models
  try {
    const { status, data } = await request('GET', MODELS_PATH);
    if (status !== 200) {
      console.log('FAIL GET /models status:', status);
      failed++;
    } else {
      const models = data.models || data.data || [];
      console.log('OK GET /models –', Array.isArray(models) ? models.length : 0, 'model(s)');
      if (data.error) console.log('  (warning:', data.error, ')');
    }
  } catch (e) {
    console.log('FAIL GET /models –', e.message || e);
    failed++;
  }

  // 2. POST /chat (Chat mode) – simple "hi"
  try {
    const { status, data } = await request('POST', CHAT_PATH, {
      message: 'Say exactly: Hello from the test.',
      autoMode: false
    });
    if (status !== 200) {
      console.log('FAIL POST /chat status:', status, data?.error || data);
      failed++;
    } else {
      const text = typeof data === 'string' ? data : (data?.response || data?.output || data?.content || '');
      const empty = /empty content|try another model/i.test(String(text));
      if (empty) {
        console.log('WARN POST /chat – response is empty-content fallback:', (String(text).slice(0, 60)) + '...');
      } else {
        console.log('OK POST /chat – got response, length:', String(text).length);
      }
    }
  } catch (e) {
    console.log('FAIL POST /chat –', e.message || e);
    failed++;
  }

  console.log('\n' + (failed ? 'Some checks failed.' : 'All checks passed.'));
  process.exit(failed ? 1 : 0);
}

main();
