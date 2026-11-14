/* QB囤 安卓版 · 前端运行时
 * 桌面版由 Python 本地服务提供 /__status /__bill /__config /__api；
 * 安卓版没有本地服务：页面本身运行在站点同源上下文里（/__gui、/__tool 由
 * WebView 拦截返回本地 assets），因此所有 /api/* 请求直连上游、Cookie 由
 * WebView 自动携带。这里用纯 JS 复刻桌面版服务端的登录/统计/账单逻辑。
 * 站点与接口路径来自 assets/qb_config.json，经 /__api 下发。
 */
(function () {
  'use strict';
  var LS = window.localStorage;
  var K_CFG = 'qb_cfg', K_BILL = 'qb_bill', K_BOOT = 'qb_boot_ts';
  var FALLBACK_API = {
    login: '/api/login', me: '/api/me', meta: '/api/shop/qb/meta',
    accounts: '/api/shop/qb/accounts', cardNew: '/api/shop/qb/card/new',
    quota: '/api/shop/qb/accounts/quota', tier: '/api/shop/qb/accounts/switch-tier',
    mode: '/api/shop/qb/accounts/mode', note: '/api/shop/qb/accounts/note'
  };
  var S = {
    login: 'failed', source: 'none', username: '', stats: null,
    statsAt: '', upstream: '', booted: false
  };
  var APIS = null, _ready = null, _boot = null;

  function bridge() { return window.QBAndroid || null; }
  function cfg() { try { return JSON.parse(LS.getItem(K_CFG) || '{}') || {}; } catch (e) { return {}; } }
  function saveCfg(c) { try { LS.setItem(K_CFG, JSON.stringify(c)); } catch (e) {} }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function now() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  async function apis() {
    if (APIS) return APIS;
    var d = {};
    try { d = await (await fetch('/__api', { cache: 'no-store' })).json(); } catch (e) {}
    APIS = Object.assign({}, FALLBACK_API, d.api || {});
    S.upstream = d.site || location.origin;
    return APIS;
  }

  async function call(path, body) {
    var opt = {
      credentials: 'same-origin',
      headers: { 'Accept': '*/*', 'Content-Type': 'application/json' }
    };
    if (body !== undefined) { opt.method = 'POST'; opt.body = JSON.stringify(body); }
    var r = await fetch(path, opt);
    var j = null;
    try { j = await r.json(); } catch (e) {}
    if (!r.ok || (j && j.ok === false)) {
      throw new Error((j && (j.message || j.code)) || ('HTTP ' + r.status));
    }
    return j || {};
  }

  /* CK 有效直接复用；失效则自动用已保存的账号密码登录，WebView 会写入新 Cookie */
  async function ensureLogin(force) {
    var a = await apis(), c = cfg();
    if (!force) {
      try { await call(a.me); S.login = 'ok'; S.source = 'cookie'; return 'cookie'; }
      catch (e) {}
    }
    if (c.username && c.password) {
      try {
        await call(a.login, { username: c.username, password: c.password });
        S.login = 'ok'; S.source = 'password';
        var b = bridge();
        if (b && b.flushCookies) { try { b.flushCookies(); } catch (e) {} }
        return 'password';
      } catch (e) {}
    }
    S.login = 'failed'; S.source = 'none'; return 'none';
  }
  function ready() { if (!_ready) _ready = ensureLogin(false); return _ready; }

  function pick(d, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = d[keys[i]];
      if (v !== undefined && v !== null && v !== '') return num(v);
    }
    return 0;
  }
  /* 与桌面版 server.py:quota_stats 完全一致（含历史总额度 = 剩余 + 已用） */
  function quotaStats(j) {
    if (!j || j.ok === false) return null;
    var items = j.items || [], s = j.summary || {};
    var allocated = 0, used = 0;
    items.forEach(function (it) { allocated += num(it.quota); used += num(it.used); });
    var total = pick(s, ['balance', 'total', 'totalQuota', 'energy', 'remain']);
    var free = pick(s, ['free', 'unallocated', 'available', 'canAllocate']);
    if (!total) total = allocated + free;
    if (!free && total) free = total - allocated;
    return {
      total: r3(total), allocated: r3(allocated), free: r3(free),
      used: r3(used), historical: r3(total + used), accounts: items.length
    };
  }

  /* 账单：优先读 App 私有 quota_log.txt（JS bridge），浏览器预览时退化为 localStorage */
  function billLines() {
    var b = bridge();
    if (b && b.readBill) {
      try {
        var t = b.readBill();
        if (t && t.trim()) return t.replace(/\r/g, '').trim().split('\n');
      } catch (e) {}
    }
    try { return JSON.parse(LS.getItem(K_BILL) || '[]') || []; } catch (e) { return []; }
  }
  /* 2 小时内最多一条日志：最后一行（含无效行）在 2h 内就跳过写入，避免账单爆满 */
  function lastBillLineTime() {
    var arr = billLines(), last = '';
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].trim()) { last = arr[i].trim(); break; }
    }
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(last);
    if (!m) return 0;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  function appendBill(line) {
    var last = lastBillLineTime();
    if (last && Date.now() >= last && Date.now() - last < 2 * 3600 * 1000) return false;
    var b = bridge();
    if (b && b.appendBill) { try { b.appendBill(line); } catch (e) {} }
    var arr = billLines(); arr.push(line);
    try { LS.setItem(K_BILL, JSON.stringify(arr.slice(-3000))); } catch (e) {}
    return true;
  }
  function billLine(stats, source, note) {
    if (!stats) {
      return now() + ' | 未登录或读取失败，无法记录额度 | CK来源=' + source + ' | ' + note;
    }
    return now() + ' | 剩余总额度=' + stats.total
      + ' | 已分配=' + stats.allocated
      + ' | 未分配=' + stats.free
      + ' | 已用额度=' + stats.used
      + ' | 历史总额度=' + stats.historical
      + ' | 账号数=' + stats.accounts
      + ' | CK来源=' + source + ' | ' + note;
  }
  var BILL_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \| 剩余总额度=([\d.]+) \| 已分配=([\d.-]+) \| 未分配=([\d.-]+) \| 已用额度=([\d.-]+)(?: \| 历史总额度=([\d.]+))?/;
  function bill() {
    var rows = [];
    billLines().forEach(function (line) {
      var m = BILL_RE.exec(line.trim());
      if (!m) return;                       // 只展示有效数据，未登录行被过滤
      var total = +m[3], allocated = +m[4], free = +m[5], used = +m[6];
      var hist = m[7] ? +m[7] : r3(total + used);   // 旧格式补算历史总额度
      rows.push({
        date: m[1], ts: m[1] + ' ' + m[2], total: total, allocated: allocated,
        free: free, used: used, historical: hist,
        display: m[1] + ' ' + m[2] + ' | 剩余总额度=' + total
          + ' | 已分配=' + allocated + ' | 未分配=' + free
          + ' | 已用额度=' + used + ' | 历史总额度=' + hist
      });
    });
    var last = {};
    rows.forEach(function (r, i) { last[r.date] = i; });
    var keep = {};
    Object.keys(last).forEach(function (k) { keep[last[k]] = 1; });
    var prev = null;
    rows.forEach(function (r, i) {
      if (prev !== null && r.historical !== prev) {
        keep[i] = 1; if (i > 0) keep[i - 1] = 1;   // 总额度变动点 + 变动前一条
      }
      prev = r.historical;
    });
    var idx = Object.keys(keep).map(Number).sort(function (a, b) { return a - b; });
    return { all: rows, compact: idx.map(function (i) { return rows[i]; }), lines: billLines() };
  }

  function payload() {
    var c = cfg();
    return {
      login: S.login, source: S.source, username: S.username || c.username || '',
      stats: S.stats, statsAt: S.statsAt, upstream: S.upstream, site: S.upstream,
      config: {
        username: c.username || '', hasPassword: !!c.password,
        hasCookie: !!c.cookie || S.login === 'ok',
        cookiePreview: c.cookie ? c.cookie.slice(0, 24) + '...'
          : (S.login === 'ok' ? '由 WebView 保存' : ''),
        proxy: '', port: '', site: S.upstream
      },
      bill: billLines().slice(-12)
    };
  }

  /* force=true 时强制用密码重新登录；note 非空时写一行账单 */
  async function refresh(note, force) {
    var src;
    if (force) { _ready = null; _ready = ensureLogin(true); src = await _ready; }
    else src = await ready();
    var stats = null;
    if (S.login === 'ok') {
      try { stats = quotaStats(await call((await apis()).accounts)); } catch (e) {}
    }
    S.stats = stats; S.statsAt = now(); S.username = cfg().username || '';
    if (note) {
      var t = Date.now(), last = +(LS.getItem(K_BOOT) || 0), write = true;
      if (note === '程序启动' && t - last < 45000) write = false;  // 主页面与 iframe 同启只记一次
      if (write) { LS.setItem(K_BOOT, String(t)); appendBill(billLine(stats, src, note)); }
    }
    S.booted = true;
    return payload();
  }

  function status() {
    if (!S.booted) {
      if (!_boot) _boot = refresh('程序启动', false).then(
        function (r) { _boot = null; return r; },
        function (e) { _boot = null; throw e; });
      return _boot;
    }
    return Promise.resolve(payload());
  }
  function relogin() { _boot = null; return refresh('重新登录', true); }
  function setConfig(body) {
    var c = cfg(), next = Object.assign({}, c);
    if (body.username) next.username = body.username;
    if (body.password) next.password = body.password;      // 留空 = 不修改
    if (body.cookie) {
      next.cookie = body.cookie;
      var b = bridge();
      if (b && b.setCookie) { try { b.setCookie(body.cookie); } catch (e) {} }
    }
    if (body.site && body.site.replace(/\/+$/, '') !== S.upstream.replace(/\/+$/, '')) {
      next.site = body.site; saveCfg(next);
      var bb = bridge();
      if (bb && bb.setSite) {
        setTimeout(function () { try { bb.setSite(body.site); } catch (e) {} }, 700);
      }
      return Promise.resolve(payload());
    }
    saveCfg(next);
    _boot = null;
    return refresh('配置变更', true);
  }
  function copy(text) {
    var b = bridge();
    if (b && b.copy) { try { b.copy(text); return; } catch (e) {} }
    if (navigator.clipboard) navigator.clipboard.writeText(text);
  }

  window.QB = {
    ready: ready, status: status, bill: bill, relogin: relogin,
    setConfig: setConfig, copy: copy, refresh: refresh, apis: apis
  };
  ready();   // 页面一加载就开始自动登录（CK → 密码兜底）
})();
