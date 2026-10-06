'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CheckpointStore } = require('../server/store');
const { defaultScenario } = require('../server/engine');

async function freshFile(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `relay-ckpt-${label}-`));
  return path.join(dir, 'checkpoint.json');
}

test('检查点落盘并重开后恢复到最后完整步骤', async () => {
  const file = await freshFile('recover');
  const store = new CheckpointStore(file);
  await store.init();
  await store.step();
  await store.step();
  const snapAt2 = store.snapshot();
  assert.equal(snapAt2.step, 2);
  assert.equal(snapAt2.replayConsistent, true);

  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.step, 2);

  // 模拟页面重开 / 进程重启：新 store 从同一文件恢复
  const reopened = new CheckpointStore(file);
  await reopened.init();
  const restored = reopened.snapshot();
  assert.equal(restored.step, 2);
  assert.equal(restored.runId, snapAt2.runId);
  assert.equal(JSON.stringify(restored.best), JSON.stringify(snapAt2.best));
  assert.equal(restored.replayConsistent, true);

  // 恢复后继续推进仍然正确
  const next = await reopened.step();
  assert.equal(next.step, 3);
});

test('恢复回放与一次跑完的收敛结果一致', async () => {
  const file = await freshFile('converge');
  const store = new CheckpointStore(file);
  await store.init();
  const done = await store.runAll();

  const reopened = new CheckpointStore(file);
  await reopened.init();
  const restored = reopened.snapshot();
  assert.equal(restored.done, true);
  assert.deepEqual(restored.best, done.best);
  assert.deepEqual(restored.inbound, done.inbound);
  assert.deepEqual(restored.pending, done.pending);
});

test('迟到的旧演练落盘不得覆盖新演练（runId + 序号防护）', async () => {
  const file = await freshFile('late');
  const store = new CheckpointStore(file);
  await store.init();
  const oldRunId = store.runId;
  const oldPrefix = oldRunId.slice(0, 8);

  // 在“旧演练 tmp 写入”处挂起，制造迟到结果：
  // writeFile 尚未返回时，新演练已经重置并完成落盘
  const origWriteFile = fs.writeFile;
  let blockOld = null;
  fs.writeFile = async (target, ...rest) => {
    if (String(target).includes(oldPrefix)) {
      await new Promise((resolve) => { blockOld = resolve; });
    }
    return origWriteFile(target, ...rest);
  };

  const oldPersist = store._persist(); // 直接发起，绕过队列以模拟迟到的在途写
  await new Promise((resolve) => {
    const timer = setInterval(() => { if (blockOld) { clearInterval(timer); resolve(); } }, 10);
  });

  const newScenario = {
    routers: [0, 1],
    adjacencies: [{ from: 0, to: 1, localPref: 100 }],
    events: [{ type: 'announce', from: 0, to: 1, prefix: 'n', asPath: [0] }],
  };
  const resetSnap = await store.reset(newScenario);
  const newRunId = store.runId;
  assert.notEqual(newRunId, oldRunId);

  // 放行旧演练的迟到写入：防护应删除其 tmp 且不 rename
  const releaser = blockOld;
  blockOld = null;
  releaser();
  await oldPersist;
  fs.writeFile = origWriteFile;

  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(onDisk.runId, newRunId);
  assert.equal(onDisk.step, 0);
  assert.equal(onDisk.input.routers.length, 2);

  // 重开后恢复的仍是新演练
  const reopened = new CheckpointStore(file);
  await reopened.init();
  assert.equal(reopened.runId, newRunId);
  assert.deepEqual(reopened.snapshot().best, resetSnap.best);
});

test('损坏的检查点回落到内置场景而不是崩溃', async () => {
  const file = await freshFile('corrupt');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{ not json', 'utf8');
  const store = new CheckpointStore(file);
  await store.init();
  assert.equal(store.drill.input.events.length, defaultScenario().events.length);
  const repaired = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(repaired.version, 1);
});
