/* QB囤 安卓版 · 前端运行时
 * 桌面版由 Python 本地服务提供 /__status /__bill /__qbill /__config /__api；
 * 安卓版没有本地服务：页面本身运行在站点同源上下文里（/__gui、/__tool 由
 * WebView 拦截返回本地 assets），因此所有 /api/* 请求直连上游、Cookie 由
 * WebView 自动携带。这里用纯 JS 复刻桌面版服务端的登录/统计/账单逻辑。
 * 站点与接口路径来自 assets/qb_config.json，经 /__api 下发。
 *
 * 账单文件（App 私有目录，经 QBAndroid Bridge 读写）：
 *   quota_log.txt  额度账单（纯文本行）
 *   qb.log         Q币账单（JSON Lines，按账号分类、serial 去重累积）
 * 两者都支持导入/导出（SAF 系统文件选择器）。
 */
(function () {
  'use strict';
  var LS = window.localStorage;
  var K_CFG = 'qb_cfg', K_BILL = 'qb_bill', K_QB = 'qb_qblog', K_BOOT = 'qb_boot_ts';
  var FALLBACK_API = {
    login: '/api/login', me: '/api/me', meta: '/api/shop/qb/meta',
    accounts: '/api/shop/qb/accounts', cardNew: '/api/shop/qb/card/new',
    quota: '/api/shop/qb/accounts/quota', tier: '/api/shop/qb/accounts/switch-tier',
    mode: '/api/shop/qb/accounts/mode', note: '/api/shop/qb/accounts/note'
  };
  var S = {
    login: 'failed', source: 'none', username: '', stats: null,
    statsAt: '', upstream: '', booted: false,
    qbCollect: { at: '', added: 0, total: 0, accounts: 0, error: '' }
  };
  var APIS = null, _ready = null, _boot = null;

  function bridge() { return window.QBAndroid || null; }
  function cfg() { try { return JSON.parse(LS.getItem(K_CFG) || '{}') || {}; } catch (e) { return {}; } }
  function saveCfg(c) { try { LS.setItem(K_CFG, JSON.stringify(c)); } catch (e) {} }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function rN(v, n) { var p = Math.pow(10, n); return Math.round(v * p) / p; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function now() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function ymd() {
    var d = new Date();
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
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

  /* ───────────── 额度账单 quota_log.txt ───────────── */
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

  /* ───────────── Q币账单 qb.log ─────────────
   * 与桌面版 server.py 完全同构：JSON Lines，两类行
   *   · 明细行：一次充值，serial 为唯一键
   *   · kind=account 占位行：该账号无任何充值记录，字段全 null
   * 网站只保留近 7 天，本地按 serial 去重永久累积（只增不删）。
   */
  function qbLines() {
    var b = bridge();
    if (b && b.readQb) {
      try {
        var t = b.readQb();
        if (t && t.trim()) return t.replace(/\r/g, '').trim().split('\n');
      } catch (e) {}
    }
    try { return JSON.parse(LS.getItem(K_QB) || '[]') || []; } catch (e) { return []; }
  }
  function qbRows() {
    var out = [];
    qbLines().forEach(function (line) {
      line = (line || '').trim();
      if (!line) return;
      try {
        var o = JSON.parse(line);
        if (o && typeof o === 'object' && o.qq) out.push(o);
      } catch (e) {}
    });
    return out;
  }
  function isPh(r) { return !!r && r.kind === 'account'; }
  function qbKey(r) {
    if (isPh(r)) return 'ACCOUNT|' + r.qq;
    var s = String(r.serial || '').trim();
    if (s) return s;
    return [r.qq, r.paidAt, r.amount, r.cost].join('|');
  }
  function appendQb(recs) {
    if (!recs.length) return;
    var text = recs.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n';
    var b = bridge();
    if (b && b.appendQb) { try { b.appendQb(text); } catch (e) {} }
    var arr = qbLines();
    recs.forEach(function (r) { arr.push(JSON.stringify(r)); });
    try { LS.setItem(K_QB, JSON.stringify(arr.slice(-20000))); } catch (e) {}
  }
  function collectQb(j) {
    var rows = qbRows(), seen = {}, knownQq = {}, detailBefore = 0;
    rows.forEach(function (r) {
      seen[qbKey(r)] = 1;
      if (r.qq) knownQq[String(r.qq)] = 1;
      if (!isPh(r)) detailBefore++;
    });
    if (!j || j.ok === false) return 0;
    var added = [], ts = now();
    (j.items || []).forEach(function (it) {
      var qq = String(it.qq || '').trim();
      if (!qq) return;
      var note = String(it.note || '').trim(), id = it.id, recs = it.records || [];
      recs.forEach(function (r) {
        if (!r || typeof r !== 'object') return;
        var rec = {
          qq: qq, id: id, note: note, paidAt: String(r.paidAt || '').trim(),
          amount: num(r.amount), cost: num(r.cost),
          serial: String(r.serial || '').trim(), savedAt: ts
        };
        var k = qbKey(rec);
        if (seen[k]) return;
        seen[k] = 1; added.push(rec);
      });
      knownQq[qq] = 1;
      if (!recs.length && !seen['ACCOUNT|' + qq]) {
        var ph = {
          kind: 'account', qq: qq, id: id, note: note,
          paidAt: null, amount: null, cost: null, serial: null, savedAt: ts
        };
        seen[qbKey(ph)] = 1; added.push(ph);
      }
    });
    appendQb(added);
    var newDetails = added.filter(function (r) { return !isPh(r); }).length;
    var total = detailBefore + newDetails;
    S.qbCollect = {
      at: ts, added: newDetails, total: total,
      accounts: Object.keys(knownQq).length, error: ''
    };
    return newDetails;
  }

  /* 按账号分组统计：Q币/能量总和、折扣=能量/Q币；无记录账号统计为 null */
  function qbStats(rows) {
    var groups = {};
    rows.forEach(function (r) {
      var qq = String(r.qq || '').trim();
      if (!qq) return;
      var g = groups[qq];
      if (!g) {
        g = groups[qq] = {
          qq: qq, id: r.id, note: '', amount: 0, cost: 0,
          count: 0, records: [], _savedAt: ''
        };
      }
      if (String(r.savedAt || '') >= g._savedAt) {
        g.note = String(r.note || ''); g.id = r.id;
        g._savedAt = String(r.savedAt || '');
      }
      if (isPh(r)) return;                 // 占位行只登记账号，不计金额/笔数
      g.amount += num(r.amount); g.cost += num(r.cost); g.count++;
      g.records.push({
        paidAt: r.paidAt || '', amount: r3(r.amount), cost: r3(r.cost),
        serial: r.serial || '', savedAt: r.savedAt || ''
      });
    });
    var accounts = Object.keys(groups).map(function (k) {
      var g = groups[k]; delete g._savedAt;
      var has = g.count > 0, a = r3(g.amount), c = r3(g.cost);
      g.amount = has ? a : null;
      g.cost = has ? c : null;
      g.hasRecords = has;
      g.discount = (has && a) ? rN(c / a, 4) : null;
      g.zhe = (g.discount !== null) ? rN(g.discount * 10, 2) : null;
      g.records.sort(function (x, y) {
        return String(y.paidAt || '').localeCompare(String(x.paidAt || ''));
      });
      return g;
    });
    // 有记录的按最近充值时间在前，无记录统一排最后
    accounts.sort(function (x, y) {
      if (x.hasRecords !== y.hasRecords) return x.hasRecords ? -1 : 1;
      var xp = (x.records[0] || {}).paidAt || '', yp = (y.records[0] || {}).paidAt || '';
      return String(yp).localeCompare(String(xp));
    });
    var withRec = accounts.filter(function (g) { return g.hasRecords; });
    var ta = 0, tc = 0;
    withRec.forEach(function (g) { ta += g.amount; tc += g.cost; });
    ta = r3(ta); tc = r3(tc);
    var disc = ta ? rN(tc / ta, 4) : 0;
    var detailCount = rows.filter(function (r) { return !isPh(r); }).length;
    return {
      accounts: accounts,
      total: {
        accountCount: accounts.length,
        recordAccountCount: withRec.length,
        noRecordCount: accounts.length - withRec.length,
        recordCount: detailCount,
        amount: ta, cost: tc, discount: disc, zhe: rN(disc * 10, 2)
      },
      file: 'qb.log',
      collect: Object.assign({}, S.qbCollect),
      window: '按账号分类累积：每次采集与 qb.log 对比，缺的才追加；网站仅留近 7 天，本地保留全部历史；无充值记录的账号记为 null'
    };
  }
  function qbill() { return qbStats(qbRows()); }

  /* 手动「立即采集」：拉一次 accounts 并按 serial 去重追加 */
  async function qcollect() {
    try {
      await ready();
      if (S.login !== 'ok') throw new Error('未登录，请先在「配置」里填账号密码');
      var a = await apis();
      var j = await call(a.accounts);
      collectQb(j);
    } catch (e) {
      S.qbCollect = {
        at: now(), added: 0, total: qbRows().filter(function (r) { return !isPh(r); }).length,
        accounts: qbill().total.accountCount,
        error: '采集失败：' + (e && e.message ? e.message : e)
      };
    }
    return qbill();
  }

  /* ───────────── 导入 / 导出 ─────────────
   * 导出：把账单原文交给 SAF 文件选择器另存为文件。
   * 导入：SAF 选文件 → Java 读文本 → onImportResult(kind, text) 回调，
   *       按「合并去重」处理（不覆盖、不删除本地已有数据）。
   * 浏览器预览（无 Bridge）时退化为 Blob 下载 / 文件 input。
   */
  function fireImported(res) {
    try {
      document.dispatchEvent(new CustomEvent('qbimported', { detail: res }));
    } catch (e) {}
    if (window.QB && typeof window.QB.onImportDone === 'function') {
      try { window.QB.onImportDone(res); } catch (e) {}
    }
  }
  function exportBill(kind) {
    var name, content;
    if (kind === 'qb') {
      name = 'qb_log_' + ymd() + '.txt';
      content = qbLines().join('\n') + '\n';
    } else {
      name = 'quota_log_' + ymd() + '.txt';
      content = billLines().join('\n') + '\n';
    }
    var b = bridge();
    if (b && b.exportText) { try { b.exportText(name, content); return true; } catch (e) {} }
    // 浏览器预览兜底
    try {
      var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      return true;
    } catch (e) { return false; }
  }
  function importPick(kind) {
    var b = bridge();
    if (b && b.importText) { try { b.importText(kind); return true; } catch (e) {} }
    // 浏览器预览兜底：用 input[type=file]
    try {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.txt,.log,text/plain';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () { onImportResult(kind, String(fr.result || '')); };
        fr.readAsText(f, 'utf-8');
      };
      inp.click();
      return true;
    } catch (e) { return false; }
  }
  /* Bridge 回调入口；返回合并结果供界面提示 */
  function onImportResult(kind, text) {
    var res = { kind: kind, added: 0, total: 0, error: '' };
    try {
      if (kind === 'qb') {
        var rows = qbRows(), seen = {}, add = [];
        rows.forEach(function (r) { seen[qbKey(r)] = 1; });
        String(text || '').replace(/\r/g, '').split('\n').forEach(function (line) {
          line = line.trim();
          if (!line) return;
          try {
            var o = JSON.parse(line);
            if (o && typeof o === 'object' && o.qq) {
              var k = qbKey(o);
              if (!seen[k]) { seen[k] = 1; add.push(o); }
            }
          } catch (e) {}
        });
        appendQb(add);
        res.added = add.length;
        res.total = qbRows().length;
      } else {
        var exist = {}, lines = billLines(), addLines = [];
        lines.forEach(function (l) { if (l && l.trim()) exist[l.trim()] = 1; });
        String(text || '').replace(/\r/g, '').split('\n').forEach(function (l) {
          l = l.trim();
          if (l && !exist[l]) { exist[l] = 1; addLines.push(l); }
        });
        if (addLines.length) {
          var b = bridge();
          if (b && b.appendBillRaw) { try { b.appendBillRaw(addLines.join('\n') + '\n'); } catch (e) {} }
          var arr = lines.concat(addLines);
          try { LS.setItem(K_BILL, JSON.stringify(arr.slice(-3000))); } catch (e) {}
        }
        res.added = addLines.length;
        res.total = lines.length + addLines.length;
      }
    } catch (e) {
      res.error = (e && e.message) ? e.message : String(e);
    }
    fireImported(res);
    return res;
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

  /* force=true 时强制用密码重新登录；note 非空时写一行账单。
   * 采集时机只有两个：打开应用（程序启动）、手动「立即采集」(QB.qcollect)。 */
  async function refresh(note, force) {
    var src;
    if (force) { _ready = null; _ready = ensureLogin(true); src = await _ready; }
    else src = await ready();
    var stats = null, accountsJson = null;
    if (S.login === 'ok') {
      try {
        accountsJson = await call((await apis()).accounts);
        stats = quotaStats(accountsJson);
      } catch (e) {}
    }
    S.stats = stats; S.statsAt = now(); S.username = cfg().username || '';
    if (note === '程序启动' && accountsJson) collectQb(accountsJson);  // 打开应用采一次
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
  function toast(msg) {
    var b = bridge();
    if (b && b.toast) { try { b.toast(msg); return; } catch (e) {} }
  }

  window.QB = {
    ready: ready, status: status, bill: bill, relogin: relogin,
    setConfig: setConfig, copy: copy, refresh: refresh, apis: apis, toast: toast,
    qbill: qbill, qcollect: qcollect,
    exportBill: exportBill, importPick: importPick,
    onImportResult: onImportResult, onImportDone: null
  };
  ready();   // 页面一加载就开始自动登录（CK → 密码兜底）
})();
