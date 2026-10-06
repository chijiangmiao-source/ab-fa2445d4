'use strict';

/**
 * 仿真引擎：BGP 风格的星间中继路由演练
 *
 * 核心概念：
 *  - 路由器(Router)：至多 8 台，标识为 R0..R7
 *  - 有向邻接 (u -> v)：带本地偏好 localPref 与链路纪元 epoch
 *  - 通告 (announce)：邻居把某前缀的一条路径发给本端，带发送纪元
 *  - 撤销 (withdraw)：仅移除同一邻居、同一前缀的对应通告
 *  - 断开 (disconnect)：递增该有向邻接的当前纪元，旧纪元消息一律忽略
 *  - 重连 (reconnect)：再次递增纪元（不恢复任何旧通告）
 *  消息必须先 enter 再 deliver：enter 表示消息已生成（在途），
 *  deliver 表示接收端处理；投递前核验接收端邻接“当前纪元 === 消息纪元”。
 *
 * 选路裁决（逐路由器、逐前缀）：
 *  1. 有效候选：邻接当前仍处于消息发送纪元，且路径不含本端标识（无环）
 *  2. 本地偏好高者优先（以接收端该入站邻接的 localPref 为准）
 *  3. 路径长度短者优先
 *  4. 下一跳标识小者优先（稳定裁决）
 *  5. 再以通告序号兜底，保证完全确定
 *
 * 仅依赖 Node 内置模块。
 */

const MAX_ROUTERS = 8;
const MAX_EVENTS = 64;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function assertId(id) {
  if (!Number.isInteger(id) || id < 0 || id >= MAX_ROUTERS) {
    throw new ValidationError(`非法路由器标识: ${String(id)}（允许 0..${MAX_ROUTERS - 1}）`);
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 稳定比较器：下一跳标识，其次发送端、再通告序号 */
function tieBreak(a, b) {
  if (a.nextHop !== b.nextHop) return a.nextHop < b.nextHop ? -1 : 1;
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  return a.announceSeq - b.announceSeq;
}

/**
 * Drill：一次完整演练。所有输入在构造时校验，事件逐步执行。
 * input:
 *   { routers:[0..], adjacencies:[{from,to,localPref}], events:[...] }
 */
class Drill {
  constructor(input) {
    this.input = Drill.validateInput(input);
    // 有向邻接表：from -> to -> { localPref, epoch }
    this.adj = new Map();
    for (const id of this.input.routers) {
      this.adj.set(id, new Map());
    }
    for (const a of this.input.adjacencies) {
      const map = this.adj.get(a.from);
      // 重复邻接：保留最后一条配置（构造时已拒绝完全重复，这里防御）
      map.set(a.to, { localPref: a.localPref, epoch: 0 });
    }
    // 每个路由器的入站 RIB：router -> prefix -> [route, ...]
    this.routes = new Map();
    for (const id of this.input.routers) {
      this.routes.set(id, new Map());
    }
    // 在途消息队列：[{ id, kind, from, to, prefix, asPath, epoch, seq, note }]
    this.pending = [];
    this.eventSeq = 0;      // 已执行事件数
    this.announceSeq = 0;   // 全局通告序号（稳定兜底）
    this.log = [];
    this.lastError = null;
  }

  static validateInput(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('演练配置为空');
    }
    const routers = Array.isArray(input.routers) ? input.routers.slice() : [];
    if (routers.length === 0) throw new ValidationError('至少需要 1 台路由器');
    if (routers.length > MAX_ROUTERS) {
      throw new ValidationError(`路由器至多 ${MAX_ROUTERS} 台`);
    }
    const seen = new Set();
    for (const id of routers) {
      assertId(id);
      if (seen.has(id)) throw new ValidationError(`路由器 R${id} 重复定义`);
      seen.add(id);
    }
    routers.sort((a, b) => a - b);

    const adjacencies = Array.isArray(input.adjacencies) ? input.adjacencies : [];
    const normAdj = [];
    const adjSeen = new Set();
    for (const a of adjacencies) {
      if (!a || typeof a !== 'object') throw new ValidationError('邻接格式非法');
      const from = Number(a.from);
      const to = Number(a.to);
      assertId(from);
      assertId(to);
      if (!seen.has(from) || !seen.has(to)) {
        throw new ValidationError(`邻接 R${from}->R${to} 引用了不存在的路由器`);
      }
      if (from === to) throw new ValidationError('不允许自环邻接');
      const key = `${from}->${to}`;
      if (adjSeen.has(key)) throw new ValidationError(`邻接 ${key} 重复定义`);
      adjSeen.add(key);
      const localPref = Number.isFinite(a.localPref) ? Math.trunc(a.localPref) : 100;
      normAdj.push({ from, to, localPref });
    }

    const events = Array.isArray(input.events) ? input.events : [];
    if (events.length > MAX_EVENTS) {
      throw new ValidationError(`事件至多 ${MAX_EVENTS} 项`);
    }
    const normEvents = [];
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (!e || typeof e !== 'object') throw new ValidationError(`事件 #${i + 1} 格式非法`);
      normEvents.push(Drill.validateEvent(e, i, seen, adjSeen));
    }
    return { routers, adjacencies: normAdj, events: normEvents };
  }

  static validateEvent(e, index, routerSet, adjSet) {
    const pos = `事件 #${index + 1}`;
    const requireInt = (v, name) => {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new ValidationError(`${pos}: ${name} 必须为整数`);
      return n;
    };
    const kind = String(e.type || e.kind || '').toLowerCase();
    const base = { type: kind, label: e.label ? String(e.label) : '' };

    switch (kind) {
      case 'announce': {
        const from = requireInt(e.from, 'from');
        const to = requireInt(e.to, 'to');
        assertId(from);
        assertId(to);
        if (!routerSet.has(from) || !routerSet.has(to)) {
          throw new ValidationError(`${pos}: 引用了不存在的路由器`);
        }
        if (!adjSet.has(`${from}->${to}`)) {
          throw new ValidationError(`${pos}: 通告 R${from}->R${to} 依赖的邻接不存在`);
        }
        const prefix = String(e.prefix || '').trim();
        if (!prefix) throw new ValidationError(`${pos}: 缺少前缀 prefix`);
        let asPath = Array.isArray(e.asPath) ? e.asPath.map(requireInt) : [];
        for (const x of asPath) assertId(x);
        // 规范化路径：去重不做，保持原样用于环路检测；但移除相邻重复 AS 预处理由用户负责
        if (asPath.length === 0) asPath = [from];
        if (asPath[asPath.length - 1] !== from) {
          throw new ValidationError(`${pos}: AS 路径末跳必须为发送端 R${from}`);
        }
        return { ...base, from, to, prefix, asPath };
      }
      case 'withdraw': {
        const from = requireInt(e.from, 'from');
        const to = requireInt(e.to, 'to');
        assertId(from);
        assertId(to);
        const prefix = String(e.prefix || '').trim();
        if (!prefix) throw new ValidationError(`${pos}: 缺少前缀 prefix`);
        if (!adjSet.has(`${from}->${to}`)) {
          throw new ValidationError(`${pos}: 撤销 R${from}->R${to} 依赖的邻接不存在`);
        }
        return { ...base, from, to, prefix };
      }
      case 'disconnect':
      case 'reconnect': {
        const from = requireInt(e.from, 'from');
        const to = requireInt(e.to, 'to');
        assertId(from);
        assertId(to);
        if (!adjSet.has(`${from}->${to}`)) {
          throw new ValidationError(`${pos}: 链路操作 R${from}->R${to} 依赖的邻接不存在`);
        }
        return { ...base, from, to };
      }
      case 'deliver': {
        const msgId = requireInt(e.msgId ?? e.messageId, 'msgId');
        return { ...base, msgId };
      }
      default:
        throw new ValidationError(`${pos}: 未知事件类型 "${e.type}"`);
    }
  }

  /** 执行下一个事件，返回该事件产生的状态快照 */
  step() {
    if (this.done) return this.snapshot();
    const ev = this.input.events[this.eventSeq];
    this.eventSeq += 1;
    this.lastError = null;
    let effects = [];
    switch (ev.type) {
      case 'announce':
        effects = this.handleAnnounce(ev);
        break;
      case 'withdraw':
        effects = this.handleWithdraw(ev);
        break;
      case 'disconnect':
        effects = this.handleLink(ev, '断开');
        break;
      case 'reconnect':
        effects = this.handleLink(ev, '重连');
        break;
      case 'deliver':
        effects = this.handleDeliver(ev);
        break;
      default:
        effects = [];
    }
    this.log.push({ step: this.eventSeq, event: ev, effects });
    return this.snapshot();
  }

  /** 一次执行到末尾（恢复回放 / 测试使用） */
  runAll() {
    while (!this.done) this.step();
    return this.snapshot();
  }

  get done() {
    return this.eventSeq >= this.input.events.length;
  }

  currentEpoch(from, to) {
    const m = this.adj.get(from);
    const a = m ? m.get(to) : null;
    return a ? a.epoch : null;
  }

  handleAnnounce(ev) {
    const epoch = this.currentEpoch(ev.from, ev.to);
    this.announceSeq += 1;
    const msg = {
      id: this.announceSeq,
      kind: 'announce',
      from: ev.from,
      to: ev.to,
      prefix: ev.prefix,
      asPath: ev.asPath.slice(),
      epoch,
      label: ev.label,
    };
    this.pending.push(msg);
    return [{ kind: 'queued', message: msg, text: `通告进入在途队列：R${ev.from} → R${ev.to}，前缀 ${ev.prefix}，路径 [${ev.asPath.join(',')}]，纪元 ${epoch}` }];
  }

  handleWithdraw(ev) {
    const epoch = this.currentEpoch(ev.from, ev.to);
    this.announceSeq += 1;
    const msg = {
      id: this.announceSeq,
      kind: 'withdraw',
      from: ev.from,
      to: ev.to,
      prefix: ev.prefix,
      asPath: [],
      epoch,
      label: ev.label,
    };
    this.pending.push(msg);
    return [{ kind: 'queued', message: msg, text: `撤销进入在途队列：R${ev.from} → R${ev.to}，前缀 ${ev.prefix}，纪元 ${epoch}` }];
  }

  handleLink(ev, verb) {
    const a = this.adj.get(ev.from).get(ev.to);
    a.epoch += 1;
    // 清除该接收端上来自该邻居的全部入站路由：已断开邻居不得继续参与选路
    const rib = this.routes.get(ev.to);
    let removed = 0;
    for (const [prefix, list] of rib.entries()) {
      const kept = list.filter((r) => !(r.from === ev.from && r.epoch < a.epoch));
      if (kept.length !== list.length) {
        removed += list.length - kept.length;
        if (kept.length === 0) rib.delete(prefix);
        else rib.set(prefix, kept);
      }
    }
    // 在途消息不主动删除：交付时以纪元核验自然过期（并可在页面上展示“过期忽略”）
    return [{
      kind: 'link',
      from: ev.from,
      to: ev.to,
      epoch: a.epoch,
      removed,
      text: `邻接 R${ev.from} → R${ev.to} ${verb}，纪元推进为 ${a.epoch}；清理来自 R${ev.from} 的旧纪元入站路由 ${removed} 条`,
    }];
  }

  handleDeliver(ev) {
    const idx = this.pending.findIndex((m) => m.id === ev.msgId);
    if (idx === -1) {
      this.lastError = `待投递消息 #${ev.msgId} 不存在（可能已投递）`;
      return [{ kind: 'error', text: this.lastError }];
    }
    const [msg] = this.pending.splice(idx, 1);
    const adj = this.adj.get(msg.from) && this.adj.get(msg.from).get(msg.to);

    // 1) 纪元核验：接收端邻接必须仍处于消息的发送纪元
    if (!adj || adj.epoch !== msg.epoch) {
      return [{
        kind: 'stale',
        message: msg,
        currentEpoch: adj ? adj.epoch : null,
        text: `过期消息忽略：#${msg.id}（${msg.kind} R${msg.from}→R${msg.to}，前缀 ${msg.prefix}）发送纪元 ${msg.epoch}，当前纪元 ${adj ? adj.epoch : '邻接缺失'}`,
      }];
    }

    if (msg.kind === 'withdraw') {
      // 2) 撤销：仅移除同一邻居、同一前缀的对应通告
      const rib = this.routes.get(msg.to);
      const list = rib.get(msg.prefix) || [];
      const kept = list.filter((r) => !(r.from === msg.from && r.prefix === msg.prefix));
      const removed = list.length - kept.length;
      if (kept.length === 0) rib.delete(msg.prefix);
      else rib.set(msg.prefix, kept);
      return [{
        kind: 'withdrawn',
        message: msg,
        removed,
        text: removed > 0
          ? `撤销生效：R${msg.to} 移除来自 R${msg.from} 的 ${removed} 条 ${msg.prefix} 通告`
          : `撤销到达但无匹配通告：R${msg.to} 上没有来自 R${msg.from} 的 ${msg.prefix}`,
      }];
    }

    // 3) 环路拒绝：含接收路由器标识的路径必须拒绝传播
    if (msg.asPath.includes(msg.to)) {
      return [{
        kind: 'loop',
        message: msg,
        text: `环路拒绝：R${msg.to} 拒绝 R${msg.from} 关于 ${msg.prefix} 的通告，路径 [${msg.asPath.join(',')}] 含本端标识 R${msg.to}`,
      }];
    }

    // 4) 安装入站路由（同邻居同前缀：新通告替换旧通告，以最新一次为准）
    const rib = this.routes.get(msg.to);
    const list = rib.get(msg.prefix) || [];
    const filtered = list.filter((r) => r.from !== msg.from);
    const route = {
      prefix: msg.prefix,
      from: msg.from,
      to: msg.to,
      nextHop: msg.from,
      asPath: msg.asPath.slice(),
      localPref: adj.localPref,
      epoch: msg.epoch,
      announceSeq: msg.id,
    };
    filtered.push(route);
    rib.set(msg.prefix, filtered);
    return [{
      kind: 'accepted',
      route,
      message: msg,
      text: `通告接受：R${msg.to} 安装来自 R${msg.from} 的 ${msg.prefix}，本地偏好 ${adj.localPref}，路径 [${msg.asPath.join(',')}]，纪元 ${msg.epoch}`,
    }];
  }

  /** 计算某路由器某前缀的最优路径 */
  bestRoute(routerId, prefix) {
    const list = (this.routes.get(routerId).get(prefix) || []).slice();
    if (list.length === 0) return null;
    list.sort((a, b) => {
      if (a.localPref !== b.localPref) return b.localPref - a.localPref; // 偏好高者优先
      if (a.asPath.length !== b.asPath.length) {
        return a.asPath.length - b.asPath.length; // 路径短者优先
      }
      return tieBreak(a, b); // 下一跳标识小者优先（稳定）
    });
    return list[0];
  }

  /** 逐路由器逐前缀的当前最优路径表 */
  bestTable() {
    const table = {};
    for (const id of this.input.routers) {
      const prefixes = [...this.routes.get(id).keys()].sort();
      table[`R${id}`] = prefixes.map((p) => {
        const r = this.bestRoute(id, p);
        return {
          prefix: p,
          nextHop: `R${r.nextHop}`,
          localPref: r.localPref,
          asPath: r.asPath.map((x) => `R${x}`),
          pathLength: r.asPath.length,
          announceSeq: r.announceSeq,
        };
      });
    }
    return table;
  }

  inboundView() {
    const view = {};
    for (const id of this.input.routers) {
      const rows = [];
      for (const [prefix, list] of this.routes.get(id).entries()) {
        for (const r of list) {
          rows.push({
            prefix,
            from: `R${r.from}`,
            localPref: r.localPref,
            asPath: r.asPath.map((x) => `R${x}`),
            epoch: r.epoch,
            announceSeq: r.announceSeq,
          });
        }
      }
      rows.sort((a, b) => (a.prefix === b.prefix
        ? a.announceSeq - b.announceSeq
        : a.prefix < b.prefix ? -1 : 1));
      view[`R${id}`] = rows;
    }
    return view;
  }

  pendingView() {
    return this.pending.map((m) => ({
      id: m.id,
      kind: m.kind === 'announce' ? '通告' : '撤销',
      from: `R${m.from}`,
      to: `R${m.to}`,
      prefix: m.prefix,
      asPath: m.asPath.map((x) => `R${x}`),
      epoch: m.epoch,
      stale: (() => {
        const a = this.adj.get(m.from) && this.adj.get(m.from).get(m.to);
        return !a || a.epoch !== m.epoch;
      })(),
    }));
  }

  adjacencyView() {
    const rows = [];
    for (const from of this.input.routers) {
      for (const [to, a] of this.adj.get(from).entries()) {
        rows.push({ from: `R${from}`, to: `R${to}`, localPref: a.localPref, epoch: a.epoch });
      }
    }
    return rows;
  }

  snapshot() {
    return {
      step: this.eventSeq,
      done: this.done,
      totalEvents: this.input.events.length,
      routers: this.input.routers.map((id) => `R${id}`),
      adjacencies: this.adjacencyView(),
      pending: this.pendingView(),
      inbound: this.inboundView(),
      best: this.bestTable(),
      lastEffects: (this.log[this.log.length - 1] || {}).effects || [],
      log: this.log.map((l) => ({
        step: l.step,
        type: l.event.type,
        label: l.event.label || '',
        summary: describeEvent(l.event),
        effects: l.effects.map((x) => ({ kind: x.kind, text: x.text })),
      })),
    };
  }

  /** 检查点：输入 + 已执行步数，重开后据此重放 */
  checkpoint() {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      input: deepClone(this.input),
      step: this.eventSeq,
    };
  }

  static fromCheckpoint(cp) {
    if (!cp || cp.version !== 1 || !cp.input) {
      throw new ValidationError('检查点格式不受支持');
    }
    const drill = new Drill(cp.input);
    const target = Math.min(Number(cp.step) || 0, drill.input.events.length);
    while (drill.eventSeq < target) drill.step();
    return drill;
  }
}

function describeEvent(ev) {
  switch (ev.type) {
    case 'announce':
      return `通告 R${ev.from}→R${ev.to} ${ev.prefix} 路径[${ev.asPath.join(',')}]`;
    case 'withdraw':
      return `撤销 R${ev.from}→R${ev.to} ${ev.prefix}`;
    case 'disconnect':
      return `断开 R${ev.from}→R${ev.to}`;
    case 'reconnect':
      return `重连 R${ev.from}→R${ev.to}`;
    case 'deliver':
      return `投递 #${ev.msgId}`;
    default:
      return ev.type;
  }
}

/** 内置示例场景：覆盖旧纪元撤销、环路拒绝与恢复收敛 */
function defaultScenario() {
  return {
    routers: [0, 1, 2, 3],
    adjacencies: [
      { from: 0, to: 1, localPref: 100 },
      { from: 0, to: 2, localPref: 150 },
      { from: 1, to: 2, localPref: 100 },
      { from: 2, to: 3, localPref: 100 },
      { from: 3, to: 1, localPref: 100 },
    ],
    events: [
      { type: 'announce', from: 0, to: 1, prefix: '10.0.0.0/24', asPath: [0], label: 'A: R0 向 R1 通告' },
      { type: 'announce', from: 0, to: 2, prefix: '10.0.0.0/24', asPath: [0], label: 'A: R0 向 R2 通告（高偏好）' },
      { type: 'deliver', msgId: 1, label: '投递 R1 通告' },
      { type: 'deliver', msgId: 2, label: '投递 R2 通告' },
      { type: 'announce', from: 1, to: 2, prefix: '10.0.0.0/24', asPath: [0, 1], label: 'R1 转发给 R2（长路径低偏好）' },
      { type: 'deliver', msgId: 3, label: '投递转发通告' },
      { type: 'announce', from: 2, to: 3, prefix: '10.0.0.0/24', asPath: [0, 2], label: 'R2 向 R3 通告' },
      { type: 'deliver', msgId: 4, label: '投递至 R3' },
      { type: 'announce', from: 3, to: 1, prefix: '10.0.0.0/24', asPath: [1, 0, 2, 3], label: '环路消息：路径已含接收端 R1' },
      { type: 'deliver', msgId: 5, label: '投递环路消息（应拒绝）' },
      // 旧纪元撤销场景：先断开 0->1，再投递旧纪元的撤销，应被忽略
      { type: 'withdraw', from: 0, to: 1, prefix: '10.0.0.0/24', label: 'R0 撤销 R1（在途）' },
      { type: 'disconnect', from: 0, to: 1, label: '断开 R0→R1（纪元 +1）' },
      { type: 'deliver', msgId: 6, label: '投递旧纪元撤销（应忽略）' },
      { type: 'reconnect', from: 0, to: 1, label: '重连 R0→R1（纪元再 +1）' },
      { type: 'announce', from: 0, to: 1, prefix: '10.0.0.0/24', asPath: [0], label: '新纪元重新通告' },
      { type: 'deliver', msgId: 7, label: '投递新纪元通告（应接受）' },
      { type: 'withdraw', from: 0, to: 1, prefix: '10.0.0.0/24', label: '新纪元撤销（在途）' },
      { type: 'deliver', msgId: 8, label: '投递同纪元撤销（应生效，仅移除 R0 的该前缀）' },
    ],
  };
}

module.exports = {
  Drill,
  ValidationError,
  defaultScenario,
  MAX_ROUTERS,
  MAX_EVENTS,
};
