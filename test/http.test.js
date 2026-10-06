'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/index.js');
const { CheckpointStore } = require('../server/store');
const { defaultScenario } = require('../server/engine');

let base;
let server;
let ckptFile;
let ckptDir;

function http(pathName, options) {
  return fetch(`${base}${pathName}`, options);
}

async function startStore() {
  const store = new CheckpointStore(ckptFile);
  await store.init();
  return store;
}

describe('HTTP 服务', () => {
  before(async () => {
    ckptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-http-'));
    ckptFile = path.join(ckptDir, 'checkpoint.json');
    const store = await startStore();
    await new Promise((resolve) => {
      server = createServer(store).listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(ckptDir, { recursive: true, force: true });
  });

  test('GET /healthz 返回 200 与运行信息', async () => {
    const res = await http('/healthz');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.runId);
    assert.match(body.runId, /^[0-9a-f-]{36}$/);
  });

  test('站点首页与静态资源可访问', async () => {
    const home = await http('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const html = await home.text();
    assert.match(html, /星间中继/);

    const js = await http('/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const css = await http('/styles.css');
    assert.equal(css.status, 200);

    const missing = await http('/no-such-file.txt');
    assert.equal(missing.status, 404);
  });

  test('路径穿越被拒绝', async () => {
    const res = await http('/..%2f..%2fpackage.json');
    // 规范化后落到 public 之外 → 403；服务器上也不得泄露源码
    assert.ok([403, 404].includes(res.status));
  });

  test('逐步执行 API 并在最后收敛', async () => {
    let body;
    for (let i = 0; i < defaultScenario().events.length; i += 1) {
      const res = await http('/api/step', { method: 'POST' });
      assert.equal(res.status, 200);
      body = await res.json();
      assert.equal(body.step, i + 1);
      assert.equal(body.replayConsistent, true);
    }
    assert.equal(body.done, true);
    // 场景中应出现 stale / loop 两类关键复核结果
    const kinds = body.log.flatMap((l) => l.effects.map((e) => e.kind));
    assert.ok(kinds.includes('stale'));
    assert.ok(kinds.includes('loop'));
  });

  test('重置为自定义演练：非法输入返回 400', async () => {
    const ok = await http('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          routers: [0, 1],
          adjacencies: [{ from: 0, to: 1, localPref: 90 }],
          events: [{ type: 'announce', from: 0, to: 1, prefix: 'p', asPath: [0] }, { type: 'deliver', msgId: 1 }],
        },
      }),
    });
    assert.equal(ok.status, 200);
    const snap = await ok.json();
    assert.equal(snap.step, 0);

    const bad = await http('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { routers: [9], adjacencies: [], events: [] } }),
    });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /非法路由器标识/);
  });

  test('seek 跳转与恢复：新 store 指向同一检查点文件后状态一致', async () => {
    // 当前是 2 台路由器的演练，跑到第 2 步收敛
    const done = await (await http('/api/run', { method: 'POST' })).json();
    assert.equal(done.done, true);

    await http('/api/seek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 1 }),
    });
    const at1 = await (await http('/api/state')).json();
    assert.equal(at1.step, 1);
    assert.equal(at1.routers.length, 2);

    // 模拟进程/页面重开
    const reopened = await startStore();
    assert.equal(reopened.drill.eventSeq, 1);
    const restored = reopened.snapshot();
    assert.equal(JSON.stringify(restored.best), JSON.stringify(at1.best));
    assert.equal(restored.replayConsistent, true);
  });
});
