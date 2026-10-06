'use strict';

/* 星间中继路由演练台 · 前端逻辑（零依赖） */

const $ = (id) => document.getElementById(id);

const state = { snap: null };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, body) {
  const opts = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const EFFECT_LABELS = {
  accepted: '通告接受',
  stale: '过期消息忽略',
  loop: '环路拒绝',
  withdrawn: '撤销生效',
  link: '链路变化',
  queued: '消息入队',
  error: '错误',
};

function emptyRow(cols) {
  return `<tr><td colspan="${cols}" class="empty">空</td></tr>`;
}

function render() {
  const s = state.snap;
  if (!s) return;

  $('runBadge').textContent = `run ${String(s.runId).slice(0, 8)}`;
  $('stepBadge').textContent = `步骤 ${s.step}/${s.totalEvents}`;
  const rb = $('replayBadge');
  rb.textContent = s.replayConsistent ? '回放一致 ✓' : '回放不一致 ✗';
  rb.className = 'badge ' + (s.replayConsistent ? 'ok' : 'bad');
  $('convergeBadge').textContent = s.done ? '已收敛（全部事件执行完毕）' : '进行中';
  $('convergeBadge').className = 'badge ' + (s.done ? 'ok' : '');

  $('btnStep').disabled = s.done;
  $('seekRange').max = String(s.totalEvents);
  $('seekRange').value = String(s.step);
  $('seekLabel').textContent = String(s.step);

  renderAdj(s);
  renderPending(s);
  renderBest(s);
  renderInbound(s);
  renderLog(s);
}

function renderAdj(s) {
  const rows = s.adjacencies.map((a) => `
    <tr>
      <td>${esc(a.from)} → ${esc(a.to)}</td>
      <td>偏好 ${a.localPref}</td>
      <td>纪元 ${a.epoch}</td>
    </tr>`).join('');
  $('adjTable').innerHTML =
    `<thead><tr><th>有向邻接</th><th>本地偏好</th><th>当前纪元</th></tr></thead>`
    + `<tbody>${rows || emptyRow(3)}</tbody>`;
}

function renderPending(s) {
  const rows = s.pending.map((m) => `
    <tr class="${m.stale ? 'stale' : ''}">
      <td>#${m.id}</td>
      <td>${m.kind}</td>
      <td>${esc(m.from)} → ${esc(m.to)}</td>
      <td>${esc(m.prefix)}</td>
      <td>[${m.asPath.map(esc).join(',')}]</td>
      <td>纪元 ${m.epoch}</td>
    </tr>`).join('');
  $('pendingTable').innerHTML =
    `<thead><tr><th>编号</th><th>类型</th><th>链路</th><th>前缀</th><th>路径</th><th>发送纪元</th></tr></thead>`
    + `<tbody>${rows || emptyRow(6)}</tbody>`;
}

function renderBest(s) {
  $('bestTables').innerHTML = s.routers.map((r) => {
    const rows = (s.best[r] || []).map((x) => `
      <div class="route-row">
        <span>${esc(x.prefix)}</span>
        <span class="meta">
          <span class="path-pill">${x.asPath.map(esc).join(' → ')}</span>
          偏好${x.localPref} · 长度${x.pathLength} · 经${esc(x.nextHop)}
        </span>
      </div>`).join('');
    return `<div class="mini-card">
      <h4>🎯 ${esc(r)} 的最优路径</h4>
      ${rows || '<div class="empty">暂无有效路径</div>'}
    </div>`;
  }).join('');
}

function renderInbound(s) {
  $('inboundTables').innerHTML = s.routers.map((r) => {
    const rows = (s.inbound[r] || []).map((x) => `
      <div class="route-row">
        <span>${esc(x.prefix)} <small class="meta">来自 ${esc(x.from)}</small></span>
        <span class="meta">
          <span class="path-pill">${x.asPath.map(esc).join(' → ')}</span>
          偏好${x.localPref} · 纪元${x.epoch}
        </span>
      </div>`).join('');
    return `<div class="mini-card">
      <h4>📥 ${esc(r)} 的入站路由</h4>
      ${rows || '<div class="empty">暂无入站路由</div>'}
    </div>`;
  }).join('');
}

function renderLog(s) {
  const html = s.log.map((l) => {
    const effects = l.effects.map((e) =>
      `<div class="log-effect kind-${e.kind}">`
      + `<span class="tag ${e.kind}">${esc(EFFECT_LABELS[e.kind] || e.kind)}</span>${esc(e.text)}`
      + `</div>`
    ).join('');
    return `<div class="log-entry">
      <div class="log-head">${l.step}. ${esc(l.summary)}${l.label ? ` · <span class="meta">${esc(l.label)}</span>` : ''}</div>
      <div class="log-effects">${effects}</div>
    </div>`;
  }).join('');
  $('eventLog').innerHTML = html || '<div class="empty" style="padding:10px">尚未执行任何事件</div>';
  // 自动滚动到最新一步
  const box = $('eventLog');
  box.scrollTop = box.scrollHeight;
}

async function withBusy(fn) {
  try {
    state.snap = await fn();
    render();
  } catch (err) {
    alert('操作失败：' + err.message);
  }
}

function init() {
  $('btnStep').addEventListener('click', () => withBusy(() => api('/api/step', {})));
  $('btnRun').addEventListener('click', () => withBusy(() => api('/api/run', {})));
  $('btnSeek').addEventListener('click', () => {
    const step = Number($('seekRange').value);
    withBusy(() => api('/api/seek', { step }));
  });
  $('seekRange').addEventListener('input', () => { $('seekLabel').textContent = $('seekRange').value; });
  $('btnResetDefault').addEventListener('click', () => withBusy(() => api('/api/reset', {})));

  $('btnLoadConfig').addEventListener('click', async () => {
    const msg = $('configMsg');
    try {
      const input = JSON.parse($('configInput').value);
      state.snap = await api('/api/reset', { input });
      msg.textContent = '配置已加载，新演练已开始';
      msg.className = 'config-msg ok';
      render();
    } catch (err) {
      msg.textContent = '加载失败：' + err.message;
      msg.className = 'config-msg error';
    }
  });

  $('btnValidate').addEventListener('click', () => {
    const msg = $('configMsg');
    try {
      JSON.parse($('configInput').value);
      msg.textContent = 'JSON 语法正确（完整规则校验将在加载时执行）';
      msg.className = 'config-msg ok';
    } catch (err) {
      msg.textContent = 'JSON 语法错误：' + err.message;
      msg.className = 'config-msg error';
    }
  });

  $('btnDefault').addEventListener('click', async () => {
    const scen = await api('/api/default-scenario');
    $('configInput').value = JSON.stringify(scen, null, 2);
    $('configMsg').textContent = '已填入内置示例';
    $('configMsg').className = 'config-msg';
  });

  // 页面重开：GET /api/state 即最后完整步骤（服务端从检查点恢复）
  api('/api/state').then((s) => {
    state.snap = s;
    render();
    const note = $('restoreNote');
    note.classList.remove('hidden');
    note.innerHTML = `📌 已从检查点恢复至第 <b>${s.step}</b> 步（run ${esc(String(s.runId).slice(0, 8))}）。`
      + `恢复回放与不中断回放的收敛结果一致：<b>${s.replayConsistent ? '是 ✓' : '否 ✗'}</b>。`;
  }).catch((err) => {
    $('configMsg').textContent = '无法连接服务：' + err.message;
    $('configMsg').className = 'config-msg error';
  });

  api('/api/default-scenario').then((scen) => {
    if (!$('configInput').value.trim()) $('configInput').value = JSON.stringify(scen, null, 2);
  }).catch(() => {});
}

init();
