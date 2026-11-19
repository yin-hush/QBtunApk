
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 顶部能量统计区（安卓版：数据来自同源 API，由 app.js 计算）
function todayStr(){
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
}
function r3(x){ return Math.round(x * 1000) / 1000; }
// 今/昨日到账：从 QB.qbill() 的 accounts[].records 里取今天+昨天的明细，按时间倒序（新在上）
function dateOffsetStr(offset){
  const d = new Date(); d.setDate(d.getDate() + offset);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
}
function collectTD(b){
  const td = dateOffsetStr(0), yd = dateOffsetStr(-1), rows = [];
  ((b && b.accounts) || []).forEach(a => {
    (a.records || []).forEach(r => {
      const d = String(r.paidAt || '').slice(0, 10);
      if (d === td || d === yd)
        rows.push({ paidAt: r.paidAt || '', note: a.note || '', qq: a.qq || '',
                    amount: Number(r.amount) || 0, cost: Number(r.cost) || 0, day: d });
    });
  });
  rows.sort((x, y) => (x.paidAt < y.paidAt ? 1 : x.paidAt > y.paidAt ? -1 : 0)); // 新→旧
  return rows;
}
// 顶部「今日 X币·X笔 昨日 X币·X笔」统计
function renderTodayTotals(rows){
  const el = document.getElementById('todayTotals');
  if (!el) return;
  const td = dateOffsetStr(0), yd = dateOffsetStr(-1), acc = {td:{a:0,n:0}, yd:{a:0,n:0}};
  rows.forEach(r => {
    const k = r.day === td ? 'td' : (r.day === yd ? 'yd' : null);
    if (k){ acc[k].a += r.amount; acc[k].n++; }
  });
  el.innerHTML = '今日 <b>' + r3(acc.td.a) + '</b>币·<b>' + acc.td.n + '</b>笔　'
               + '昨日 <b>' + r3(acc.yd.a) + '</b>币·<b>' + acc.yd.n + '</b>笔';
}
// 七日已充：qq → 「60币·3笔」（严格 7×24 小时窗口，精确到秒）
let QB7 = null;
function loadQb7(){
  try {
    const b = (QB.qbill && QB.qbill()) || {};
    const now = Date.now(), cut = now - 7 * 24 * 3600 * 1000, m = {};
    ((b && b.accounts) || []).forEach(a => {
      let amt = 0, n = 0;
      (a.records || []).forEach(r => {
        const ts = Date.parse(String(r.paidAt || '').replace(' ', 'T'));
        if (!isNaN(ts) && ts >= cut && ts <= now){ amt += Number(r.amount) || 0; n++; }
      });
      if (n) m[String(a.qq || '')] = r3(amt) + '币·' + n + '笔';
    });
    QB7 = m;
  } catch(e){ QB7 = null; }
}
function renderToday(rows){
  const body = document.getElementById('todayBody');
  const meta = document.getElementById('todayMeta');
  if (!rows.length){
    body.innerHTML = '<tr><td colspan="5" class="hint">无</td></tr>';
    meta.textContent = '今/昨日暂无充值到账';
    return;
  }
  body.innerHTML = rows.map(r =>
    '<tr><td>' + r.paidAt + '</td><td>' + r.note + '</td><td>' + r.qq + '</td>'
    + '<td>' + r.amount + '</td><td>' + r.cost + '</td></tr>'
  ).join('');
  meta.textContent = '今/昨日（' + dateOffsetStr(-1) + ' ~ ' + todayStr() + '）共 ' + rows.length + ' 笔';
}
async function loadQuota(){
  const meta = document.getElementById('qMeta');
  try {
    const s = await QB.status();
    const q = s.stats;
    if (q){
      document.getElementById('qTotal').textContent = q.total;
      document.getElementById('qHist').textContent  = q.historical;
      document.getElementById('qAlloc').textContent = q.allocated;
      document.getElementById('qFree').textContent  = q.free;
      document.getElementById('qUsed').textContent  = q.used;
    }
    // Q币总和 / 平均折扣 来自 Q币账单（qb.log）统计；今日充 / 今日折扣 / 今日到账按当天明细现算
    try {
      const b = (QB.qbill && QB.qbill()) || {};
      const t = b.total;
      if (t && t.recordCount > 0){
        document.getElementById('qQb').textContent  = t.amount;
        document.getElementById('qZhe').textContent = t.zhe ? (t.zhe + ' 折') : '—';
      }
      const td = dateOffsetStr(0), recent = collectTD(b);
      const todayRows = recent.filter(r => r.day === td);
      let amt = 0, cost = 0;
      todayRows.forEach(r => { amt += r.amount; cost += r.cost; });
      document.getElementById('qToday').textContent    = String(r3(amt)); // 今日无到账写 0
      document.getElementById('qZheToday').textContent = amt ? ((cost / amt * 10).toFixed(2) + ' 折') : '—';
      renderTodayTotals(recent);
      renderToday(recent);
    } catch(e){}
    // 还能充 / 已充（合计）：原网页汇总表的 overview.total，服务端算好直接取
    try {
      const a = await api.accounts();
      const t = a && a.overview && a.overview.total;
      document.getElementById('qLeft').textContent =
        (t && typeof t.left === 'number') ? String(t.left) : '—';
      document.getElementById('qCharged').textContent =
        (t && typeof t.used === 'number') ? String(t.used) : '—';
    } catch(e){}
    meta.textContent = '账号数 ' + (q ? q.accounts : '—')
      + ' · 统计时间 ' + (s.statsAt || '—')
      + ' · 能量账单：quota_log.txt（App 私有文件）';
  } catch(e){ meta.textContent = '能量统计读取失败：' + e.message; }
}
let ITEMS = [];

function log(msg){
  const el = $('#log');
  if (el.textContent === '等待操作…') el.textContent = '';
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

async function call(path, body){
  const opt = {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: { 'Accept': '*/*', 'Content-Type': 'application/json' }
  };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(path, opt);
  let j = null;
  try { j = await r.json(); } catch(e) { throw new Error('响应不是 JSON，HTTP ' + r.status); }
  if (!r.ok || (j && j.ok === false)) {
    throw new Error((j && (j.message || j.code)) || ('HTTP ' + r.status));
  }
  return j;
}

// 接口路径从 config.json 读取（由本地服务 /__api 下发），换站点只改配置不改代码
let APIS = {
  login:'/api/login', me:'/api/me', meta:'/api/shop/qb/meta',
  accounts:'/api/shop/qb/accounts', cardNew:'/api/shop/qb/card/new',
  quota:'/api/shop/qb/accounts/quota', tier:'/api/shop/qb/accounts/switch-tier',
  mode:'/api/shop/qb/accounts/mode', note:'/api/shop/qb/accounts/note',
  delete:'/api/shop/qb/accounts/delete'
};
async function loadApis(){
  try {
    const d = await (await fetch('/__api', {cache:'no-store'})).json();
    if (d && d.api) APIS = Object.assign({}, APIS, d.api);
  } catch(e){ /* 用兜底路径 */ }
}
const api = {
  login:   (u,p) => call(APIS.login, {username:u, password:p}),
  me:      ()     => call(APIS.me),
  meta:    ()     => call(APIS.meta),
  accounts:()     => call(APIS.accounts),
  card:    b      => call(APIS.cardNew, b),
  quota:   (id,v) => call(APIS.quota, {id, quota:String(v)}),
  tier:    (id,t) => call(APIS.tier, {id, tier:String(t)}),
  mode:    (id,m) => call(APIS.mode, {id, mode:m}),
  note:    (id,n) => call(APIS.note, {id, note:n}),
  del:     (id)   => call(APIS.delete, {id})
};

function setBadge(text, ok){
  const b = $('#authBadge');
  b.textContent = text;
  b.className = 'badge' + (ok ? ' ok' : '');
}

async function checkMe(){
  try { const m = await api.me(); setBadge('已登录 · ' + (m.username || m.name || 'OK'), true); return true; }
  catch(e){ setBadge('未登录 · 请在主面板「配置」里填账号密码', false); return false; }
}

async function loadMeta(){
  try {
    const m = await api.meta();
    const tiers = m.tiers || [];
    const modes = m.modes || [{value:'auto',label:'本期充满'},{value:'loop',label:'循环充值'}];
    const fill = (sel, list, valKey, labelKey, fallback, suffix) => {
      const el = $(sel), old = el.value;
      el.innerHTML = '';
      (list.length ? list : fallback).forEach(x => {
        const o = document.createElement('option');
        const extra = suffix ? (suffix(x) || '') : '';
        o.value = String(x[valKey]);
        o.textContent = String(x[labelKey] || x[valKey]) + (extra ? '（' + extra + '）' : '');
        el.appendChild(o);
      });
      if (old) el.value = old;
    };
    // 档位折扣每天会变，从 /qb/meta 的 rates 里动态读取（text 是上游算好的最终折扣文本）
    const rateOf = k => (m.rates && m.rates[String(k)] && m.rates[String(k)].text) || '';
    fill('#cardTier', tiers, 'key', 'label', [{key:'1',label:'1起'}], x => rateOf(x.key));
    fill('#tierVal',  tiers, 'key', 'label', [{key:'1',label:'1起'}], x => rateOf(x.key));
    fill('#cardMode', modes, 'value', 'label', [{value:'auto',label:'本期充满'},{value:'loop',label:'循环充值'}]);
    fill('#modeVal',  modes, 'value', 'label', [{value:'auto',label:'本期充满'},{value:'loop',label:'循环充值'}]);
    log('已加载档位 ' + tiers.length + ' 个、模式 ' + modes.length + ' 个');
  } catch(e){ log('读取档位失败：' + e.message); }
}

function render(items){
  ITEMS = items || [];
  const tb = $('#tbody');
  tb.innerHTML = '';
  if (!ITEMS.length){ tb.innerHTML = '<tr><td colspan="10" class="hint">暂无账号</td></tr>'; }
  ITEMS.forEach(it => {
    const tr = document.createElement('tr');
    const cell = v => '<td>' + (v === undefined || v === null || v === '' ? '—' : String(v)) + '</td>';
    tr.innerHTML = '<td><input type="checkbox" class="pick" value="' + it.id + '"></td>'
      + cell(it.id) + cell(it.qq) + cell(it.note)
      + cell(it.tierLabel || it.tier) + cell(QB7 && QB7[String(it.qq)] || '')
      + cell(it.modeText || it.mode)
      + cell(it.quota) + cell(it.used)
      + '<td><span class="tag">' + (it.status || '—') + '</span></td>';
    tb.appendChild(tr);
  });
  updateSel();
  log('账号列表：' + ITEMS.length + ' 条');
}

function updateSel(){
  const boxes = document.querySelectorAll('.pick');
  const n = document.querySelectorAll('.pick:checked').length;
  $('#selInfo').textContent = '已选 ' + n + ' / ' + ITEMS.length;
  $('#btnToggleAll').textContent = (boxes.length && n === boxes.length) ? '取消全选' : '全选';
}

function picked(){
  return Array.from(document.querySelectorAll('.pick:checked')).map(x => Number(x.value));
}

function confirmRun(label, ids, param){
  return confirm('将对 ' + ids.length + ' 个账号执行「' + label + '」\n参数：' + param
    + '\n\n这会真实修改服务端数据，确定继续？');
}

async function runBatch(ids, fn, label){
  const delay = Math.max(0, parseFloat($('#delay').value) || 0);
  const stop = $('#stopOnErr').checked;
  let ok = 0, fail = 0;
  for (let i = 0; i < ids.length; i++){
    log('[' + (i+1) + '/' + ids.length + '] ' + label + ' id=' + ids[i] + ' …');
    try { const r = await fn(ids[i]); ok++; log('   ✓ ' + (r && r.url ? r.url : 'OK')); }
    catch(e){ fail++; log('   ✗ ' + e.message); if (stop) break; }
    if (i < ids.length - 1 && delay) await sleep(delay * 1000);
  }
  log('完成：成功 ' + ok + '，失败 ' + fail);
  return {ok, fail};
}

async function refresh(){
  loadQb7();
  try { const r = await api.accounts(); render(r.items || []); }
  catch(e){ log('读取账号失败：' + e.message); }
}

// 立即刷新：重新检测登录态 + 重载档位 + 刷新账号列表 + 刷新能量统计
async function refreshAll(){
  const ok = await checkMe();
  try { await loadMeta(); } catch(e){}
  await refresh();
  await QB.refresh('', false);
  await loadQuota();
  return ok;
}
$('#btnRefresh').onclick = async () => { await refresh(); await QB.refresh('', false); await loadQuota(); };
$('#btnForceRefresh').onclick = async () => {
  const btn = $('#btnForceRefresh');
  const old = btn.textContent; btn.disabled = true; btn.textContent = '刷新中…';
  try { const ok = await refreshAll(); log('已立即刷新（登录 ' + (ok ? 'OK' : '未登录') + '）'); }
  catch(e){ log('刷新失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
};
$('#btnToggleAll').onclick = () => {
  const boxes = document.querySelectorAll('.pick');
  const allOn = boxes.length && document.querySelectorAll('.pick:checked').length === boxes.length;
  boxes.forEach(x => x.checked = !allOn);
  updateSel();
};
$('#btnDelSel').onclick = async () => {
  const ids = picked();
  if (!ids.length){ alert('请先勾选要删除的账号'); return; }
  if (!confirm('将删除选中的 ' + ids.length + ' 个账号。\n删除前服务端会先结算该号最新充值，删除后下一轮巡检同步清理。\n\n此操作不可恢复，确定继续？')) return;
  await runBatch(ids, id => api.del(id), '删除账号');
  await refresh();
  await QB.refresh('', false);
  await loadQuota();
};
$('#tbody').addEventListener('change', updateSel);

$('#btnCard').onclick = async () => {
  const n = Math.min(50, Math.max(1, parseInt($('#cardN').value, 10) || 1));
  const body = {
    tier: $('#cardTier').value,
    quota: $('#cardQuota').value,
    note: $('#cardNote').value,
    mode: $('#cardMode').value
  };
  if (!confirm('将生成 ' + n + ' 张卡密，每张能量 ' + body.quota
      + '。\n发卡会占用账户能量并触发上游登录，确定继续？')) return;
  const urls = [];
  const delay = Math.max(0, parseFloat($('#delay').value) || 0);
  for (let i = 0; i < n; i++){
    log('[发卡 ' + (i+1) + '/' + n + '] …');
    try {
      const r = await api.card(body);
      urls.push(r.url);
      log('   ✓ ' + r.url + '   card ' + (r.card || ''));
    } catch(e){ log('   ✗ ' + e.message); if ($('#stopOnErr').checked) break; }
    if (i < n - 1 && delay) await sleep(delay * 1000);
  }
  const old = $('#cardResults').value.trim();
  $('#cardResults').value = (old ? old + '\n' : '') + urls.join('\n');
  $('#cardCount').textContent = '本次新增 ' + urls.length + ' 条';
  log('发卡完成，共 ' + urls.length + ' 条链接');
};

$('#btnQuota').onclick = async () => {
  const ids = picked(); const v = $('#quotaVal').value.trim();
  if (!ids.length || v === ''){ alert('请勾选账号并填写能量'); return; }
  if (!confirmRun('改能量', ids, 'quota=' + v)) return;
  await runBatch(ids, id => api.quota(id, v), '改能量 → ' + v);
  await refresh();
};

$('#btnTier').onclick = async () => {
  const ids = picked(); const t = $('#tierVal').value;
  if (!ids.length){ alert('请勾选账号'); return; }
  if (!confirmRun('换档位', ids, 'tier=' + t)) return;
  await runBatch(ids, id => api.tier(id, t), '换档位 → ' + t);
  await refresh();
};

$('#btnMode').onclick = async () => {
  const ids = picked(); const m = $('#modeVal').value;
  if (!ids.length){ alert('请勾选账号'); return; }
  if (!confirmRun('改模式', ids, 'mode=' + m)) return;
  await runBatch(ids, id => api.mode(id, m), '改模式 → ' + m);
  await refresh();
};

$('#btnNote').onclick = async () => {
  const ids = picked(); const n = $('#noteVal').value;
  if (!ids.length){ alert('请勾选账号'); return; }
  if (!confirmRun('改昵称', ids, 'note=' + (n || '(清空)') + '（所有选中项设为同一值）')) return;
  await runBatch(ids, id => api.note(id, n), '改昵称');
  await refresh();
};

$('#btnClear').onclick = () => { $('#log').textContent = '等待操作…'; };
$('#btnCopy').onclick = async () => {
  const t = $('#cardResults');
  if (!t.value.trim()){ alert('还没有结果'); return; }
  try { await navigator.clipboard.writeText(t.value); log('已复制全部链接'); }
  catch(e){ t.select(); document.execCommand('copy'); log('已复制（兼容模式）'); }
};

(async function init(){
  await QB.ready();          // 等自动登录完成（CK 复用 / 密码兜底）
  await loadApis();
  const ok = await checkMe();
  if (ok){ await loadMeta(); await refresh(); }
  else { await loadMeta().catch(()=>{}); }
  await loadQuota();
})();
