'use strict';

/**
 * 页面构建检查（无打包器，纯静态站点）：
 *  1. public 下必需资源存在
 *  2. 前端 JS 语法通过 node --check
 *  3. HTML 引用的本地资源全部存在，且包含三大复核要素的展示位
 *  4. 内置示例场景可被引擎完整执行并产生 stale / loop / accepted 结果
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Drill, defaultScenario } = require('../server/engine');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('▶ 页面构建检查');

check('必需静态文件存在', () => {
  for (const f of ['index.html', 'app.js', 'styles.css']) {
    assert(fs.existsSync(path.join(PUBLIC, f)), `缺少 public/${f}`);
  }
});

check('前端脚本通过 node --check 语法校验', () => {
  const r = spawnSync(process.execPath, ['--check', path.join(PUBLIC, 'app.js')]);
  assert(r.status === 0, r.stderr ? r.stderr.toString() : '语法错误');
});

check('服务端脚本通过 node --check 语法校验', () => {
  for (const f of ['server/index.js', 'server/engine.js', 'server/store.js', 'scripts/verify.js']) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)]);
    assert(r.status === 0, `${f} 语法错误`);
  }
});

check('HTML 引用的本地资源均可解析', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  assert(refs.includes('/app.js'), '未引用 /app.js');
  assert(refs.includes('/styles.css'), '未引用 /styles.css');
  for (const ref of refs) {
    const file = path.join(PUBLIC, ref.replace(/^\//, ''));
    assert(fs.existsSync(file), `${ref} 在磁盘上不存在`);
  }
});

check('页面明确包含过期忽略 / 环路拒绝 / 恢复一致性展示位', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert(html.includes('过期消息忽略'), '缺少“过期消息忽略”展示');
  assert(html.includes('环路拒绝'), '缺少“环路拒绝”展示');
  assert(html.includes('回放'), '缺少恢复回放一致性展示');
  const js = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert(js.includes('stale') && js.includes('loop') && js.includes('replayConsistent'), '前端未渲染关键复核字段');
});

check('内置示例场景可完整执行，覆盖 stale/loop/accepted 且回放一致', () => {
  const snap = new Drill(defaultScenario()).runAll();
  const kinds = snap.log.flatMap((l) => l.effects.map((e) => e.kind));
  assert(kinds.includes('stale'), '示例未演示旧纪元消息忽略');
  assert(kinds.includes('loop'), '示例未演示环路拒绝');
  assert(kinds.includes('accepted'), '示例未演示通告接受');
  const replayed = Drill.fromCheckpoint({ version: 1, input: defaultScenario(), step: defaultScenario().events.length }).snapshot();
  assert(JSON.stringify(snap.best) === JSON.stringify(replayed.best), '恢复回放与连续执行结果不一致');
});

if (failures.length > 0) {
  console.error(`\n构建检查失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('构建检查全部通过\n');
