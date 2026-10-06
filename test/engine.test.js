'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Drill, ValidationError, MAX_ROUTERS, MAX_EVENTS } = require('../server/engine');

function run(events, extra = {}) {
  const drill = new Drill({
    routers: extra.routers || [0, 1, 2, 3],
    adjacencies: extra.adjacencies || [
      { from: 0, to: 1, localPref: 100 },
      { from: 0, to: 2, localPref: 150 },
      { from: 1, to: 2, localPref: 100 },
      { from: 2, to: 3, localPref: 100 },
      { from: 3, to: 1, localPref: 100 },
      { from: 2, to: 1, localPref: 100 },
    ],
    events,
  });
  return drill;
}

test('旧纪元撤销被忽略：不会移除新纪元通告', () => {
  // msg1=通告(ep0) msg2=撤销(ep0) msg3=通告(ep2)
  const d = run([
    { type: 'announce', from: 0, to: 1, prefix: 'p', asPath: [0] },
    { type: 'deliver', msgId: 1 },
    { type: 'withdraw', from: 0, to: 1, prefix: 'p' },
    { type: 'disconnect', from: 0, to: 1 },
    { type: 'reconnect', from: 0, to: 1 },
    { type: 'announce', from: 0, to: 1, prefix: 'p', asPath: [0] },
    { type: 'deliver', msgId: 3 },
    { type: 'deliver', msgId: 2 }, // 乱序迟到：纪元 0 的撤销，当前纪元 2
  ]);
  const snap = d.runAll();
  const stale = snap.log[7].effects[0];
  assert.equal(stale.kind, 'stale');
  assert.match(stale.text, /过期消息忽略/);
  // R1 仍保留纪元 2 的通告，迟到撤销未将其移除
  assert.equal(snap.inbound.R1.length, 1);
  assert.equal(snap.inbound.R1[0].epoch, 2);
  assert.equal(snap.best.R1[0].nextHop, 'R0');
});

test('断开瞬间清理旧邻居路由，已断开邻居不参与选路', () => {
  const d = run([
    { type: 'announce', from: 2, to: 1, prefix: 'p', asPath: [0, 2] },
    { type: 'deliver', msgId: 1 },
    { type: 'disconnect', from: 2, to: 1 },
  ]);
  const snap = d.runAll();
  assert.equal(snap.inbound.R1.length, 0);
  assert.equal(snap.best.R1.length, 0);
  assert.equal(snap.adjacencies.find((a) => a.from === 'R2' && a.to === 'R1').epoch, 1);
});

test('撤销仅移除同一邻居同一前缀的对应通告', () => {
  const d = run([
    { type: 'announce', from: 0, to: 1, prefix: 'p', asPath: [0] },
    { type: 'announce', from: 2, to: 1, prefix: 'p', asPath: [0, 2] },
    { type: 'announce', from: 0, to: 1, prefix: 'q', asPath: [0] },
    { type: 'deliver', msgId: 1 },
    { type: 'deliver', msgId: 2 },
    { type: 'deliver', msgId: 3 },
    { type: 'withdraw', from: 0, to: 1, prefix: 'p' },
    { type: 'deliver', msgId: 4 },
  ]);
  const snap = d.runAll();
  const prefixes = snap.inbound.R1.map((r) => `${r.from}:${r.prefix}`).sort();
  assert.deepEqual(prefixes, ['R0:q', 'R2:p']);
});

test('乱序：撤销先于通告到达，后续通告仍可安装', () => {
  const d = run([
    { type: 'withdraw', from: 0, to: 1, prefix: 'p' },
    { type: 'announce', from: 0, to: 1, prefix: 'p', asPath: [0] },
    { type: 'deliver', msgId: 1 }, // 撤销先到：无匹配
    { type: 'deliver', msgId: 2 }, // 通告后到：正常安装
  ]);
  const snap = d.runAll();
  assert.equal(snap.log[2].effects[0].kind, 'withdrawn');
  assert.match(snap.log[2].effects[0].text, /无匹配通告/);
  assert.equal(snap.log[3].effects[0].kind, 'accepted');
  assert.equal(snap.best.R1.length, 1);
});

test('环路拒绝：含接收路由器标识的路径不安装、不参与选路', () => {
  const d = run([
    { type: 'announce', from: 3, to: 1, prefix: 'p', asPath: [1, 0, 2, 3] },
    { type: 'deliver', msgId: 1 },
  ]);
  const snap = d.runAll();
  assert.equal(snap.log[1].effects[0].kind, 'loop');
  assert.equal(snap.inbound.R1.length, 0);
  assert.equal(snap.best.R1.length, 0);
});

test('最优路径裁决：本地偏好 > 路径长度 > 下一跳标识', () => {
  // R2 同时收到 R0（偏好150，短）与 R1（偏好100，长）→ R0 胜
  let d = run([
    { type: 'announce', from: 0, to: 2, prefix: 'p', asPath: [0] },
    { type: 'announce', from: 1, to: 2, prefix: 'p', asPath: [0, 1] },
    { type: 'deliver', msgId: 1 },
    { type: 'deliver', msgId: 2 },
  ]);
  assert.equal(d.runAll().best.R2[0].nextHop, 'R0');

  // 同偏好：短路径胜（R0 长度1 vs R3 长度2）
  d = run([
    { type: 'announce', from: 0, to: 1, prefix: 'p', asPath: [0] },
    { type: 'announce', from: 3, to: 1, prefix: 'p', asPath: [0, 2, 3] },
    { type: 'deliver', msgId: 1 },
    { type: 'deliver', msgId: 2 },
  ], {
    routers: [0, 1, 2, 3],
    adjacencies: [
      { from: 0, to: 1, localPref: 100 },
      { from: 3, to: 1, localPref: 100 },
      { from: 2, to: 3, localPref: 100 },
    ],
  });
  assert.equal(d.runAll().best.R1[0].nextHop, 'R0');

  // 同偏好同长度：下一跳标识小者胜（R2 vs R3）
  d = run([
    { type: 'announce', from: 2, to: 1, prefix: 'p', asPath: [0, 2] },
    { type: 'announce', from: 3, to: 1, prefix: 'p', asPath: [0, 3] },
    { type: 'deliver', msgId: 1 },
    { type: 'deliver', msgId: 2 },
  ], {
    routers: [0, 1, 2, 3],
    adjacencies: [
      { from: 2, to: 1, localPref: 100 },
      { from: 3, to: 1, localPref: 100 },
    ],
  });
  assert.equal(d.runAll().best.R1[0].nextHop, 'R2');
});

test('同邻居同前缀的新通告替换旧通告', () => {
  const d = run([
    { type: 'announce', from: 0, to: 1, prefix: 'p', asPath: [0] },
    { type: 'deliver', msgId: 1 },
    { type: 'announce', from: 0, to: 1, prefix: 'p', asPath: [5, 0] },
    { type: 'deliver', msgId: 2 },
  ]);
  const snap = d.runAll();
  assert.equal(snap.inbound.R1.length, 1);
  assert.deepEqual(snap.inbound.R1[0].asPath, ['R5', 'R0']);
});

test('逐步推进、runAll 与检查点重放，在每一步结果完全一致', () => {
  const scenario = require('../server/engine').defaultScenario();
  const oneByOne = new Drill(scenario);
  for (let i = 0; i < scenario.events.length; i += 1) {
    oneByOne.step();
    const replayed = Drill.fromCheckpoint({ version: 1, input: scenario, step: i + 1 }).snapshot();
    const live = oneByOne.snapshot();
    assert.equal(JSON.stringify(live.best), JSON.stringify(replayed.best), `step ${i + 1} best 不一致`);
    assert.equal(JSON.stringify(live.inbound), JSON.stringify(replayed.inbound), `step ${i + 1} inbound 不一致`);
    assert.equal(JSON.stringify(live.pending), JSON.stringify(replayed.pending), `step ${i + 1} pending 不一致`);
  }
  const allAtOnce = new Drill(scenario).runAll();
  const end = oneByOne.snapshot();
  assert.equal(JSON.stringify(allAtOnce.best), JSON.stringify(end.best));
});

test('输入校验：路由器数量、事件数量、重复邻接、未知邻接均被拒绝', () => {
  assert.throws(() => new Drill({ routers: [0, 1, 2, 3, 4, 5, 6, 7, 8], adjacencies: [], events: [] }), ValidationError);
  assert.throws(() => new Drill({ routers: [], adjacencies: [], events: [] }), ValidationError);
  assert.throws(() => new Drill({
    routers: [0, 1],
    adjacencies: [{ from: 0, to: 1, localPref: 100 }, { from: 0, to: 1, localPref: 200 }],
    events: [],
  }), ValidationError);
  assert.throws(() => new Drill({
    routers: [0, 1],
    adjacencies: [{ from: 0, to: 1, localPref: 100 }],
    events: [{ type: 'announce', from: 1, to: 0, prefix: 'p', asPath: [1] }],
  }), ValidationError);
  assert.throws(() => new Drill({
    routers: [0, 1],
    adjacencies: [{ from: 0, to: 1, localPref: 100 }],
    events: new Array(MAX_EVENTS + 1).fill({ type: 'deliver', msgId: 999 }),
  }), ValidationError);
  assert.equal(MAX_ROUTERS, 8);
  assert.equal(MAX_EVENTS, 64);
});

test('投递不存在的消息记录错误但不破坏状态', () => {
  const d = run([{ type: 'deliver', msgId: 42 }]);
  const snap = d.runAll();
  assert.equal(snap.log[0].effects[0].kind, 'error');
  assert.equal(snap.step, 1);
});
