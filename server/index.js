'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { CheckpointStore } = require('./store');
const { defaultScenario, ValidationError } = require('./engine');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new ValidationError('请求体过大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function createServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
    const p = url.pathname;

    if (p === '/healthz') {
      const ready = !!(store && store.drill);
      sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ok' : 'initializing',
        runId: store && store.runId ? store.runId : null,
        step: store && store.drill ? store.drill.eventSeq : 0,
        uptime: Math.round(process.uptime()),
      });
      return;
    }

    if (p === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, store.snapshot());
      return;
    }

    if (p === '/api/default-scenario' && req.method === 'GET') {
      sendJson(res, 200, defaultScenario());
      return;
    }

    if (p === '/api/step' && req.method === 'POST') {
      try {
        sendJson(res, 200, await store.step());
      } catch (err) {
        sendJson(res, err instanceof ValidationError ? 400 : 500, { error: err.message });
      }
      return;
    }

    if (p === '/api/run' && req.method === 'POST') {
      try {
        sendJson(res, 200, await store.runAll());
      } catch (err) {
        sendJson(res, err instanceof ValidationError ? 400 : 500, { error: err.message });
      }
      return;
    }

    if (p === '/api/seek' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, await store.seek(body.step));
      } catch (err) {
        sendJson(res, err instanceof ValidationError ? 400 : 500, { error: err.message });
      }
      return;
    }

    if (p === '/api/reset' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, await store.reset(body.input || defaultScenario()));
      } catch (err) {
        sendJson(res, err instanceof ValidationError ? 400 : 500, { error: err.message });
      }
      return;
    }

    if (p.startsWith('/api/')) {
      sendJson(res, 404, { error: '未知接口' });
      return;
    }

    await serveStatic(req, res, p);
  });
}

if (require.main === module) {
  const store = new CheckpointStore();
  store.init()
    .then(() => {
      const server = createServer(store);
      server.listen(PORT, HOST, () => {
        console.log(`[web] 星间中继路由演练 http://${HOST}:${PORT} (runId=${store.runId}, step=${store.drill.eventSeq})`);
      });
    })
    .catch((err) => {
      console.error('[web] 启动失败:', err);
      process.exit(1);
    });
}

module.exports = { createServer };
