'use strict';

/**
 * 检查点存储：
 *  - 所有仿真操作进入后台队列串行执行，避免并发写竞争
 *  - 检查点以“临时文件 + rename”原子落盘
 *  - 每次演练拥有 runId / 单调保存序号；过期（迟到）的写回调不会覆盖新演练
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Drill, defaultScenario } = require('./engine');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CKPT_FILE = path.join(DATA_DIR, 'checkpoint.json');

class CheckpointStore {
  constructor(file = CKPT_FILE) {
    this.file = file;
    this.drill = null;
    this.runId = null;
    this.saveSeq = 0;          // 当前演练已完成的保存序号
    this.pendingSeq = 0;       // 已发起的保存序号
    this.queue = Promise.resolve();
    this.started = false;
  }

  async init() {
    if (this.started) return;
    this.started = true;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const cp = JSON.parse(raw);
      this.drill = Drill.fromCheckpoint(cp);
      this.runId = cp.runId || crypto.randomUUID();
      this.saveSeq = cp.saveSeq || 0;
      this.pendingSeq = this.saveSeq;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 损坏的检查点不应阻断服务：回落到内置场景
        console.warn('[store] 检查点读取失败，回落默认场景:', err.message);
      }
      this.drill = new Drill(defaultScenario());
      this.runId = crypto.randomUUID();
      await this._persist();
    }
  }

  /** 将操作放到后台串行执行，并返回其完成后的快照 */
  enqueue(op) {
    const result = this.queue.then(() => op());
    // 队列自身永不抛出，拒绝由调用方通过返回的 promise 处理
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  reset(input) {
    return this.enqueue(async () => {
      this.drill = new Drill(input || defaultScenario());
      this.runId = crypto.randomUUID();
      this.saveSeq = 0;
      this.pendingSeq = 0;
      await this._persist();
      return this.snapshot();
    });
  }

  resetToDefault() {
    return this.reset(defaultScenario());
  }

  step() {
    return this.enqueue(async () => {
      this.drill.step();
      await this._persist();
      return this.snapshot();
    });
  }

  runAll() {
    return this.enqueue(async () => {
      this.drill.runAll();
      await this._persist();
      return this.snapshot();
    });
  }

  seek(step) {
    return this.enqueue(async () => {
      const target = Math.max(0, Math.min(Number(step) || 0, this.drill.input.events.length));
      this.drill = Drill.fromCheckpoint({
        version: 1,
        input: this.drill.input,
        step: target,
      });
      await this._persist();
      return this.snapshot();
    });
  }

  snapshot() {
    const snap = this.drill.snapshot();
    // 恢复一致性自检：从输入重放到当前步，应与实时推进的结果逐字节一致
    const replayed = Drill.fromCheckpoint({
      version: 1,
      input: this.drill.input,
      step: this.drill.eventSeq,
    }).snapshot();
    snap.runId = this.runId;
    snap.replayConsistent = JSON.stringify(snap.best) === JSON.stringify(replayed.best)
      && JSON.stringify(snap.inbound) === JSON.stringify(replayed.inbound)
      && JSON.stringify(snap.pending) === JSON.stringify(replayed.pending);
    snap.converged = snap.done;
    return snap;
  }

  async _persist() {
    const runId = this.runId;
    this.pendingSeq += 1;
    const seq = this.pendingSeq;
    const cp = {
      version: 1,
      runId,
      saveSeq: seq,
      savedAt: new Date().toISOString(),
      input: JSON.parse(JSON.stringify(this.drill.input)),
      step: this.drill.eventSeq,
    };
    const tmp = `${this.file}.${runId.slice(0, 8)}.${seq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cp), 'utf8');
    // 迟到结果防护：落盘回调时若演练已更换或序号更旧，则放弃 rename
    if (runId !== this.runId || seq <= this.saveSeq) {
      await fs.rm(tmp, { force: true });
      return;
    }
    await fs.rename(tmp, this.file);
    this.saveSeq = seq;
  }
}

module.exports = { CheckpointStore };
