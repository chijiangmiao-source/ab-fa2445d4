'use strict';

/**
 * verify 服务入口（docker compose run verify）：
 *  1. 代码测试：node --test（旧纪元撤销、环路拒绝、恢复收敛等）
 *  2. 页面构建检查：node scripts/build.js
 *  3. HTTP 冒烟：启动真实服务，检查 / 与静态资源、/healthz、/api/state
 * 任一步失败即以非零退出码报告验收结果，全部通过退出 0。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let failed = false;

function run(cmd, args, label) {
  return new Promise((resolve) => {
    console.log(`\n=== ${label} ===`);
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('exit', (code) => {
      if (code !== 0) {
        failed = true;
        console.error(`✗ ${label} 失败，退出码 ${code}`);
      } else {
        console.log(`✓ ${label} 通过`);
      }
      resolve(code === 0);
    });
  });
}

async function waitFor(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 503) return res;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待 ${url} 超时: ${lastErr ? lastErr.message : 'no response'}`);
}

async function httpSmoke() {
  console.log('\n=== HTTP 冒烟测试（真实起服）===');
  const port = Number(process.env.SMOKE_PORT) || 18080;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-verify-data-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => process.stdout.write(`[server] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));

  const checks = [];
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/healthz`);

    const expect = async (name, pathName, { status = 200, match } = {}) => {
      const res = await fetch(`${base}${pathName}`);
      const body = await res.text();
      let ok = res.status === status;
      if (match) ok = ok && match.test(body);
      checks.push({ name, ok, detail: `HTTP ${res.status}` });
      console.log(`  ${ok ? '✓' : '✗'} ${name} -> HTTP ${res.status}`);
      return { res, body, ok };
    };

    const h = await expect('健康检查 /healthz', '/healthz', { match: /"status":"ok"/ });
    const health = JSON.parse(h.body);
    if (!health.runId) { checks.push({ name: '/healthz 含 runId', ok: false }); console.log('  ✗ /healthz 缺少 runId'); }

    await expect('站点首页 /', '/', { match: /星间中继/ });
    await expect('前端脚本 /app.js', '/app.js', { match: /api\/step/ });
    await expect('样式 /styles.css', '/styles.css', { match: /route-row/ });

    // 接口冒烟：从检查点恢复的初始状态
    let state = await (await fetch(`${base}/api/state`)).json();
    if (state.replayConsistent !== true) throw new Error('初始状态回放不一致');
    console.log('  ✓ /api/state 回放一致性=true');

    // 逐步推进至收敛，确认关键复核结果在真实 HTTP 链路上可见
    let kinds = [];
    while (!state.done) {
      const res = await fetch(`${base}/api/step`, { method: 'POST' });
      if (res.status !== 200) throw new Error(`/api/step 返回 ${res.status}`);
      state = await res.json();
    }
    kinds = state.log.flatMap((l) => l.effects.map((e) => e.kind));
    for (const k of ['stale', 'loop', 'accepted', 'withdrawn']) {
      const ok = kinds.includes(k);
      checks.push({ name: `场景含 ${k} 复核结果`, ok });
      console.log(`  ${ok ? '✓' : '✗'} 收敛场景含 ${k}`);
    }
    if (!state.done) throw new Error('未收敛');
    console.log('  ✓ 全部事件执行完毕并收敛');

    // 检查点已落盘
    const ckpt = JSON.parse(fs.readFileSync(path.join(dataDir, 'checkpoint.json'), 'utf8'));
    const okCkpt = ckpt.step === state.totalEvents && ckpt.runId === state.runId;
    checks.push({ name: '检查点落盘到最后一步', ok: okCkpt });
    console.log(`  ${okCkpt ? '✓' : '✗'} 检查点 step=${ckpt.step}, runId=${String(ckpt.runId).slice(0, 8)}`);
  } catch (err) {
    checks.push({ name: 'HTTP 冒烟异常', ok: false, detail: err.message });
    console.error('  ✗ HTTP 冒烟异常:', err.message);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (checks.some((c) => !c.ok)) {
    failed = true;
    console.error('✗ HTTP 冒烟存在失败项');
  } else {
    console.log('✓ HTTP 冒烟全部通过');
  }
}

(async () => {
  await run(process.execPath, ['--test', 'test/'], '代码测试（旧纪元撤销 / 环路拒绝 / 恢复收敛等）');
  await run(process.execPath, ['scripts/build.js'], '页面构建检查');
  await httpSmoke();

  console.log('\n================ 验收汇总 ================');
  if (failed) {
    console.error('结果：失败 ✗（详见上方各项输出）');
    process.exit(1);
  }
  console.log('结果：全部通过 ✓');
  process.exit(0);
})();
