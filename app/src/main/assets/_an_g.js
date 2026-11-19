
const $ = s => document.querySelector(s);
let originLoaded = false;

// 能量账单 / Q币账单：精简 | 全部 | 按日精简 | q 四种展示
let BILL_MODE = 'compact';
let BILL_DATA = {all:[], compact:[], daily:[]};
let Q_DATA = null;

function escHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function fmtNum(v){ return (v === undefined || v === null || v === '') ? '—' : String(v); }
function fmt(v, n){
  const s = Number(v || 0).toFixed(n === undefined ? 3 : n);
  return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
function card(label, val, sub){
  return '<div class="q"><span>' + label + '</span><b>' + escHtml(val) + '</b>'
    + (sub ? '<em>' + escHtml(sub) + '</em>' : '') + '</div>';
}

function loadBill(){
  try { BILL_DATA = QB.bill(); renderBill(); }
  catch(e){
    $('#billBody').innerHTML = '<tr><td colspan="6" class="empty">账单读取失败：' + escHtml(e.message) + '</td></tr>';
  }
}
function renderBill(){
  const rows = BILL_DATA[BILL_MODE] || [];
  const tb = $('#billBody');
  if (!rows.length){ tb.innerHTML = '<tr><td colspan="6" class="empty">（暂无有效记录）</td></tr>'; return; }
  tb.innerHTML = rows.map(r => '<tr>'
    + '<td>' + escHtml(r.ts || r.display || '') + '</td>'
    + '<td>' + fmtNum(r.total) + '</td>'
    + '<td>' + fmtNum(r.allocated) + '</td>'
    + '<td>' + fmtNum(r.free) + '</td>'
    + '<td>' + fmtNum(r.used) + '</td>'
    + '<td>' + fmtNum(r.historical) + '</td>'
    + '</tr>').join('');
}

// ───────── Q币账单 ─────────
function renderQ(){
  if (!Q_DATA){ $('#qAccounts').innerHTML = '<div class="qempty">读取中…</div>'; return; }
  const t = Q_DATA.total || {}, c = Q_DATA.collect || {};
  $('#qCollectInfo').textContent = c.error ? c.error : (c.at
    ? ('最近采集 ' + c.at + ' · 本次新增 ' + c.added + ' 条 · 累计 ' + c.total + ' 条')
    : '尚未采集');
  $('#qSum').innerHTML =
      '<div class="qgroup">'
    + card('账号总数', t.accountCount, t.noRecordCount + ' 个无记录')
    + card('充值笔数', t.recordCount) + '</div>'
    + '<div class="qgroup">'
    + card('Q币总和', fmt(t.amount)) + card('能量总和', fmt(t.cost))
    + card('平均折扣', fmt(t.discount, 4), fmt(t.zhe, 2) + ' 折') + '</div>';
  const groups = Q_DATA.accounts || [];
  if (!groups.length){
    $('#qAccounts').innerHTML = '<div class="qempty">qb.log 里还没有任何账号，点「立即采集」抓取一次，或用「导入」恢复备份。</div>';
    return;
  }
  $('#qAccounts').innerHTML = groups.map(g => {
    const label = (g.note ? escHtml(g.note) + ' · ' : '') + escHtml(g.qq);
    if (!g.hasRecords){
      return '<div class="qacc none"><div class="ah"><b>' + label + '</b>'
        + '<span class="qq">id ' + escHtml(g.id) + '</span>'
        + '<span class="mini"><span class="tag-none">无记录</span></span></div>'
        + '<div class="none-tip">该账号暂无任何充值记录（qb.log 中记为 null）</div></div>';
    }
    const mini = '<span>笔数 <i>' + g.count + '</i></span>'
      + '<span>Q币 <i>' + fmt(g.amount) + '</i></span>'
      + '<span>能量 <i>' + fmt(g.cost) + '</i></span>'
      + '<span>折扣 <i>' + fmt(g.discount, 4) + '</i>（' + fmt(g.zhe, 2) + ' 折）</span>';
    const rows = (g.records || []).map(r => '<tr>'
      + '<td>' + escHtml(r.paidAt || '—') + '</td>'
      + '<td>' + fmt(r.amount) + '</td>'
      + '<td>' + fmt(r.cost) + '</td>'
      + '<td>' + fmt(r.amount ? r.cost / r.amount : 0, 4) + '</td>'
      + '<td title="' + escHtml(r.serial) + '">' + escHtml(r.serial || '—') + '</td>'
      + '</tr>').join('');
    return '<div class="qacc"><div class="ah"><b>' + label + '</b>'
      + '<span class="qq">id ' + escHtml(g.id) + '</span>'
      + '<span class="mini">' + mini + '</span></div>'
      + '<div class="qtable-wrap"><table class="qtable"><thead><tr><th>充值时间</th><th>Q币</th><th>能量</th>'
      + '<th>折扣</th><th>流水号</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }).join('');
}

async function loadQ(collect){
  const btn = $('#qRefresh');
  if (collect){ btn.disabled = true; btn.textContent = '采集中…'; }
  try {
    Q_DATA = collect ? await QB.qcollect() : QB.qbill();
    if (BILL_MODE === 'q') renderQ();
  } catch(e){
    if (BILL_MODE === 'q') $('#qAccounts').innerHTML =
      '<div class="qempty">Q币账单读取失败：' + escHtml(e.message) + '</div>';
  } finally {
    if (collect){ btn.disabled = false; btn.textContent = '立即采集'; }
  }
}

function currentKind(){ return BILL_MODE === 'q' ? 'qb' : 'quota'; }

const BILL_NOTES = {
  compact: 'quota_log.txt · 精简 = 每天最后一条 + 总能量变动点',
  all:     'quota_log.txt · 全部有效记录',
  q:       'qb.log · 按账号分类累积，导入为合并去重（不覆盖）'
};
function setBillMode(mode){
  BILL_MODE = mode;
  const isQ = mode === 'q';
  $('#billEnergy').className = isQ ? '' : 'on';
  $('#billQ').className      = isQ ? 'on' : '';
  $('#billModeLbl').textContent = mode === 'all' ? '全部' : '精简';
  $('#billTableWrap').style.display = isQ ? 'none' : '';
  $('#qWrap').className = isQ ? 'qwrap on' : 'qwrap';
  $('#billNote').style.display = isQ ? 'none' : '';
  $('#billNote').textContent = BILL_NOTES[mode] || '';
  if (isQ) loadQ(false); else renderBill();
}
// 点「能量账单」在精简/全部之间切换（像全选/取消全选）
$('#billEnergy').onclick = () => setBillMode(BILL_MODE === 'compact' ? 'all' : 'compact');
$('#billQ').onclick       = () => setBillMode('q');
$('#qRefresh').onclick    = () => loadQ(true);

// 导入 / 导出：作用于当前视图对应的账单文件
$('#billImport').onclick = () => { QB.importPick(currentKind()); };
$('#billExport').onclick = () => { QB.exportBill(currentKind()); };

// SAF 导入完成后的回调（app.js 通过 QB.onImportDone 触发）
QB.onImportDone = function(res){
  if (res.error){ QB.toast('导入失败：' + res.error); return; }
  if (BILL_MODE === 'q') loadQ(false); else loadBill();
  QB.toast('导入完成：新增 ' + res.added + ' 条，共 ' + res.total + ' 条（已去重合并）');
};

async function refresh(){
  try {
    const s = await QB.status();
    const b = $('#badge');
    if (s.login === 'ok'){
      const src = {cookie:'复用 CK', password:'密码登录并更新 CK'}[s.source] || s.source;
      b.textContent = '已登录 · ' + src; b.className = 'badge ok';
    } else {
      b.textContent = '未登录（点「配置」填账号密码）'; b.className = 'badge';
    }
    $('#addr').textContent = '安卓版 · 同源直连 → ' + s.upstream;
    $('#cfgUser').value = s.config.username || '';
    $('#cfgProxy').value = s.config.proxy || '';
    $('#cfgSite').value = s.config.site || s.upstream || '';
    $('#cfgCk').placeholder = s.config.hasCookie ? ('当前：' + s.config.cookiePreview) : '（无 CK）';
    if (BILL_MODE === 'q') await loadQ(false); else loadBill();
  } catch(e){
    $('#badge').textContent = '状态读取失败：' + e.message;
  }
}

function tab(which){
  curTab = which;
  const bill = which === 'bill';
  $('#tabTool').className   = which === 'tool'   ? 'on' : '';
  $('#tabOrigin').className = which === 'origin' ? 'on' : '';
  $('#tabBill').className   = bill ? 'on' : '';
  $('#framesBox').style.display  = bill ? 'none' : 'block';
  $('#billPanel').style.display  = bill ? 'flex' : 'none';
  $('#frameTool').style.display   = which === 'tool'   ? 'block' : 'none';
  $('#frameOrigin').style.display = which === 'origin' ? 'block' : 'none';
  if (which === 'origin' && !originLoaded){ $('#frameOrigin').src = '/'; originLoaded = true; }
  if (bill){ if (BILL_MODE === 'q') loadQ(false); else loadBill(); }
}

// 返回/前进：作用于当前显示的 iframe（同源，可直接操作其 history）
let curTab = 'tool';
function navFrame(dir){
  const f = document.getElementById(curTab === 'origin' ? 'frameOrigin' : 'frameTool');
  try {
    const w = f && f.contentWindow;
    if (w) { if (dir < 0) w.history.back(); else w.history.forward(); }
  } catch(e){}
}
$('#tabBack').onclick = () => navFrame(-1);
$('#tabFwd').onclick  = () => navFrame(1);

$('#tabTool').onclick   = () => tab('tool');
$('#tabOrigin').onclick = () => tab('origin');
$('#tabBill').onclick   = () => tab('bill');
$('#btnCfg').onclick = () => {
  const p = $('#cfgPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
};
$('#btnRelogin').onclick = async () => {
  $('#cfgMsg').textContent = '正在重新登录…';
  try { await QB.relogin(); await refresh(); reloadFrames(); $('#cfgMsg').textContent = '已重新登录'; }
  catch(e){ $('#cfgMsg').textContent = '失败：' + e.message; }
};
$('#btnSave').onclick = async () => {
  const body = {
    username: $('#cfgUser').value.trim(),
    password: $('#cfgPass').value,
    cookie:   $('#cfgCk').value.trim(),
    proxy:    $('#cfgProxy').value.trim(),
    site:     $('#cfgSite').value.trim()
  };
  if (!body.username && !body.password && !body.cookie){
    $('#cfgMsg').textContent = '请至少填写用户名 / 密码 / CK 中的一项'; return;
  }
  $('#cfgMsg').textContent = '保存并登录中…';
  try {
    const s = await QB.setConfig(body);
    $('#cfgPass').value = ''; $('#cfgCk').value = '';
    await refresh(); reloadFrames();
    $('#cfgMsg').textContent = s.login === 'ok'
      ? '保存成功，' + ({cookie:'CK 有效已复用', password:'已用密码登录并更新 CK'}[s.source] || '登录成功')
      : '保存了，但登录失败：请检查账号密码 / 代理';
  } catch(e){ $('#cfgMsg').textContent = '失败：' + e.message; }
};

function reloadFrames(){
  try { $('#frameTool').contentWindow.location.reload(); } catch(e){}
  if (originLoaded){ try { $('#frameOrigin').contentWindow.location.reload(); } catch(e){} }
}

refresh();
setInterval(refresh, 60000);
