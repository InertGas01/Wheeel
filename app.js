/* ============================================================
   庫存轉盤 — 應用邏輯
   純前端、無框架、無建置流程。ES2017 以內語法。
   注意：本檔案不得使用 alert / confirm / prompt，
   所有確認流程一律走頁面內的自訂對話框（openModal）。
   ============================================================ */

(function () {
  'use strict';

  /* ── 常數 ─────────────────────────────────────────── */

  var TAU = Math.PI * 2;
  var POINTER = -Math.PI / 2;          // 指針固定在正上方
  var STORAGE_KEY = 'wheel-inventory-v1';
  var MAX_HISTORY = 200;
  var MAX_NAME = 60;
  var MIN_WEIGHT = 0.01;

  var SPIN_TURNS = 10;
  var SPIN_MS = 8000;
  var REDUCED_TURNS = 0;
  var REDUCED_MS = 300;

  var INK = '#191512';
  var PAPER = '#fffdf7';
  var RULE = '#c8bba5';
  var LABEL_FONT = '"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif';

  var PALETTE = [
    '#c0392b', '#2e7d6b', '#e8a33d', '#3f6db5', '#9c4f96', '#6e9e3c',
    '#c2436b', '#4e5d8a', '#c97b2e', '#3a8fb7', '#7a52a0', '#5b7b4a'
  ];

  // 名稱, 權重, 數量, 歸零退出
  var DEFAULT_SEED = [
    ['頭獎', 1, 1, true],
    ['二獎', 3, 5, true],
    ['銘謝惠顧', 8, 0, false]
  ];

  /* ── 狀態 ─────────────────────────────────────────── */

  var state = { options: [], history: [], deduct: true };
  var memoryStore = null;   // localStorage 被封鎖時的退路
  var rotation = 0;
  var spinning = false;
  var frozen = null;        // 轉動期間鎖定的扇形清單，見 drawWheel / spin
  var seq = 0;
  var historyStamp = null;
  var view = { w: 0 };

  /* ── 小工具 ───────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function uid() {
    seq += 1;
    return 'o' + seq.toString(36) + '-' + Date.now().toString(36) +
           '-' + Math.floor(Math.random() * 1679616).toString(36);
  }

  function norm(a) {
    var v = a % TAU;
    return v < 0 ? v + TAU : v;
  }

  function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }

  // 動畫用的單一時鐘，rAF 與 setTimeout 兩條路才不會用到不同基準
  function clock() {
    return (window.performance && window.performance.now)
      ? window.performance.now()
      : Date.now();
  }

  function prefersReduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  // 亂數：優先 crypto，失敗退回 Math.random
  function rand() {
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        var buf = new Uint32Array(1);
        window.crypto.getRandomValues(buf);
        return buf[0] / 4294967296;
      }
    } catch (e) { /* 落到下一行 */ }
    return Math.random();
  }

  function clampWeight(v) {
    var n = parseFloat(v);
    if (!isFinite(n) || n < MIN_WEIGHT) return MIN_WEIGHT;
    return n;
  }

  function clampQty(v) {
    var n = parseFloat(v);
    if (!isFinite(n) || n < 0) return 0;
    return Math.round(n);
  }

  function clampName(v) {
    return String(v == null ? '' : v).slice(0, MAX_NAME);
  }

  function normHex(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(s) ? s : '';
  }

  function displayName(o) { return o.name || '未命名'; }

  function fmtTime(t) {
    var d = new Date(t);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ── 衍生規則 ─────────────────────────────────────── */

  // 選項是否留在轉盤上：不另存欄位，一律由此推導
  function isActive(o) { return !(o.qty === 0 && o.removeAtZero === true); }

  function activeOptions() { return state.options.filter(isActive); }

  function sumWeight(list) {
    var t = 0;
    for (var i = 0; i < list.length; i++) t += list[i].weight;
    return t;
  }

  /* 同名群組：名稱相同的選項共用一份庫存（qty / qty0）、顏色與「歸零退出」。
     權重仍各自獨立，所以同一個名稱可以重複貼上佔住多個扇形放大版面比例，
     但整組只有一份存貨，抽中其中任何一個扇形都只扣 1。 */

  var SHARED = ['qty', 'qty0', 'removeAtZero', 'color'];

  function groupKey(o) { return o.name.trim(); }

  function copyShared(from, to) {
    for (var i = 0; i < SHARED.length; i++) to[SHARED[i]] = from[SHARED[i]];
  }

  // 把 src 的共用欄位推給同名的其他選項
  function shareFrom(src) {
    var key = groupKey(src);
    for (var i = 0; i < state.options.length; i++) {
      var o = state.options[i];
      if (o !== src && groupKey(o) === key) copyShared(src, o);
    }
  }

  // 併入既有的同名群組：庫存、顏色與歸零退出改採該群組現有的值
  function joinGroup(o) {
    var key = groupKey(o);
    for (var i = 0; i < state.options.length; i++) {
      var other = state.options[i];
      if (other !== o && groupKey(other) === key) { copyShared(other, o); return true; }
    }
    return false;
  }

  // 舊資料可能存著同名卻不同庫存的列，一律以群組中的第一筆為準
  function normalizeGroups(list) {
    var head = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var key = list[i].name.trim();
      if (head[key] === undefined) head[key] = list[i];
      else copyShared(head[key], list[i]);
    }
  }

  // 配色以名稱為單位計數，重複貼上同一個名稱不會把調色盤算歪
  function nextColor() {
    var used = Object.create(null);
    var seen = Object.create(null);
    var i;
    for (i = 0; i < state.options.length; i++) {
      var key = groupKey(state.options[i]);
      if (seen[key]) continue;
      seen[key] = true;
      var c = state.options[i].color;
      used[c] = (used[c] || 0) + 1;
    }
    var best = PALETTE[0];
    var bestN = Infinity;
    for (i = 0; i < PALETTE.length; i++) {
      var n = used[PALETTE[i]] || 0;
      if (n < bestN) { bestN = n; best = PALETTE[i]; }
    }
    return best;
  }

  function makeOption(name, weight, qty, removeAtZero, color) {
    var q = clampQty(qty);
    return {
      id: uid(),
      name: clampName(name),
      weight: clampWeight(weight),
      qty: q,
      qty0: q,
      removeAtZero: removeAtZero !== false,
      color: normHex(color) || nextColor()
    };
  }

  function defaultOptions() {
    var out = [];
    for (var i = 0; i < DEFAULT_SEED.length; i++) {
      var row = DEFAULT_SEED[i];
      out.push({
        id: uid(),
        name: row[0],
        weight: row[1],
        qty: row[2],
        qty0: row[2],
        removeAtZero: row[3],
        color: PALETTE[i % PALETTE.length]
      });
    }
    return out;
  }

  /* ── 保存 ─────────────────────────────────────────── */

  function save() {
    var raw;
    try { raw = JSON.stringify(state); }
    catch (e) { return; }
    memoryStore = raw;
    try { window.localStorage.setItem(STORAGE_KEY, raw); }
    catch (e) { /* 被封鎖時只留在記憶體，功能不中斷 */ }
  }

  function readRaw() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      if (v != null) return v;
    } catch (e) { /* 讀不到就用記憶體 */ }
    return memoryStore;
  }

  function parseState(raw) {
    var data;
    if (!raw) return null;
    try { data = JSON.parse(raw); }
    catch (e) { return null; }
    if (!data || typeof data !== 'object' || !Array.isArray(data.options)) return null;

    var out = { options: [], history: [], deduct: data.deduct !== false };
    var seen = {};
    var i;

    for (i = 0; i < data.options.length; i++) {
      var s = data.options[i];
      if (!s || typeof s !== 'object') continue;
      var qty = clampQty(s.qty);
      var id = typeof s.id === 'string' && s.id && !seen[s.id] ? s.id : uid();
      seen[id] = true;
      out.options.push({
        id: id,
        name: clampName(s.name),
        weight: clampWeight(s.weight),
        qty: qty,
        qty0: s.qty0 === undefined || s.qty0 === null ? qty : clampQty(s.qty0),
        removeAtZero: s.removeAtZero !== false,
        color: normHex(s.color) || PALETTE[i % PALETTE.length]
      });
    }

    normalizeGroups(out.options);

    if (Array.isArray(data.history)) {
      for (i = 0; i < data.history.length && out.history.length < MAX_HISTORY; i++) {
        var h = data.history[i];
        if (!h || typeof h !== 'object') continue;
        var t = parseInt(h.t, 10);
        out.history.push({
          name: clampName(h.name),
          t: isFinite(t) ? t : Date.now()
        });
      }
    }
    return out;
  }

  /* ── DOM ──────────────────────────────────────────── */

  var stage = $('stage');
  var canvas = $('wheel');
  var ctx = canvas.getContext('2d');
  var spinBtn = $('spin');
  var emptyHint = $('emptyHint');
  var statusEl = $('status');
  var rowsBody = $('rowsBody');
  var rowsEmpty = $('rowsEmpty');
  var optionsMeta = $('optionsMeta');
  var deductBox = $('deduct');
  var resetQtyBtn = $('resetQty');
  var loadDefaultsBtn = $('loadDefaults');
  var clearAllBtn = $('clearAll');
  var clearHistoryBtn = $('clearHistory');
  var historyEl = $('history');
  var historyEmpty = $('historyEmpty');
  var addForm = $('addForm');
  var addName = $('addName');
  var addWeight = $('addWeight');
  var addQty = $('addQty');
  var addError = $('addError');
  var batchText = $('batchText');
  var exportBtn = $('exportList');
  var modalRoot = $('modalRoot');
  var app = document.querySelector('.app');

  /* ── 選項清單 ─────────────────────────────────────── */

  function miniTag(text) {
    var s = el('span', 'cell__tag');
    s.textContent = text;
    return s;
  }

  function numInput(value, label, min, step) {
    var i = document.createElement('input');
    i.type = 'number';
    i.className = 'inp inp--num';
    i.value = String(value);
    i.min = String(min);
    i.step = String(step);
    i.inputMode = step === 1 ? 'numeric' : 'decimal';
    i.setAttribute('aria-label', label);
    return i;
  }

  function buildRow(o) {
    var li = el('li', 'row');

    var cColor = el('span', 'c-color');
    var color = document.createElement('input');
    color.type = 'color';
    color.className = 'swatch';
    color.value = o.color;
    color.setAttribute('aria-label', '扇形顏色');
    cColor.appendChild(color);

    var cName = el('span', 'c-name');
    var name = document.createElement('input');
    name.type = 'text';
    name.className = 'inp inp--name';
    name.value = o.name;
    name.maxLength = MAX_NAME;
    name.autocomplete = 'off';
    name.setAttribute('aria-label', '選項名稱');
    var tag = el('span', 'tag-off');
    tag.textContent = '已用完';
    tag.hidden = true;
    cName.appendChild(name);
    cName.appendChild(tag);

    var nums = el('span', 'row__nums');

    var cW = el('span', 'c-weight');
    var weight = numInput(o.weight, '權重', MIN_WEIGHT, 0.01);
    cW.appendChild(miniTag('權重'));
    cW.appendChild(weight);

    var cQ = el('span', 'c-qty');
    var qty = numInput(o.qty, '剩餘數量', 0, 1);
    cQ.appendChild(miniTag('數量'));
    cQ.appendChild(qty);

    var cP = el('span', 'c-pct');
    var pct = el('span', 'pct');
    cP.appendChild(miniTag('機率'));
    cP.appendChild(pct);

    var cZ = el('span', 'c-zero');
    var zeroHit = el('label', 'zero-hit');
    var zero = document.createElement('input');
    zero.type = 'checkbox';
    zero.checked = o.removeAtZero;
    zeroHit.appendChild(zero);
    cZ.appendChild(miniTag('歸零退出'));
    cZ.appendChild(zeroHit);

    nums.appendChild(cW);
    nums.appendChild(cQ);
    nums.appendChild(cP);
    nums.appendChild(cZ);

    var cD = el('span', 'c-del');
    var del = el('button', 'del');
    del.type = 'button';
    del.textContent = '\u00d7';
    cD.appendChild(del);

    li.appendChild(cColor);
    li.appendChild(cName);
    li.appendChild(nums);
    li.appendChild(cD);

    /* 事件：即時寫回狀態後只做值同步，不重建整列，避免焦點跳掉 */

    color.addEventListener('input', function () {
      o.color = normHex(color.value) || o.color;
      shareFrom(o);
      refresh();
    });

    name.addEventListener('input', function () {
      o.name = clampName(name.value);
      refresh();
    });
    /* 改名要等離開欄位才決定群組。若每敲一個字就併組，打「頭獎」的途中
       會先撞上既有的「頭」再撞上「頭獎」，這一列原本的庫存就被洗掉了。 */
    name.addEventListener('change', function () {
      o.name = clampName(name.value);
      joinGroup(o);
      refresh();
    });

    weight.addEventListener('input', function () {
      o.weight = clampWeight(weight.value);
      refresh();
    });
    weight.addEventListener('change', function () {
      weight.value = String(o.weight);
    });

    qty.addEventListener('input', function () {
      o.qty = clampQty(qty.value);
      o.qty0 = o.qty;
      shareFrom(o);
      refresh();
    });
    qty.addEventListener('change', function () {
      qty.value = String(o.qty);
    });

    zero.addEventListener('change', function () {
      o.removeAtZero = zero.checked;
      shareFrom(o);
      refresh();
    });

    del.addEventListener('click', function () {
      var i = state.options.indexOf(o);
      if (i >= 0) state.options.splice(i, 1);
      var near = li.nextElementSibling || li.previousElementSibling;
      if (li.parentNode) li.parentNode.removeChild(li);
      rowsEmpty.hidden = state.options.length > 0;
      refresh();
      handOffFocus(near ? near.querySelector('.del') : null, addName);
    });

    li._refs = { o: o, color: color, name: name, tag: tag,
                 weight: weight, qty: qty, pct: pct, zero: zero, del: del };
    return li;
  }

  function renderList() {
    rowsBody.textContent = '';
    for (var i = 0; i < state.options.length; i++) {
      rowsBody.appendChild(buildRow(state.options[i]));
    }
    rowsEmpty.hidden = state.options.length > 0;
  }

  // 只把 from 之後的新選項接到清單尾端，既有列保持原狀（含焦點與游標）
  function appendRows(from) {
    for (var i = from; i < state.options.length; i++) {
      rowsBody.appendChild(buildRow(state.options[i]));
    }
    rowsEmpty.hidden = state.options.length > 0;
    refresh();
  }

  function setIfIdle(input, value) {
    if (input !== document.activeElement && input.value !== value) input.value = value;
  }

  function syncRows() {
    var total = sumWeight(activeOptions());
    var lis = rowsBody.children;
    for (var i = 0; i < lis.length; i++) {
      var r = lis[i]._refs;
      if (!r) continue;
      var o = r.o;
      var on = isActive(o);

      if (on) lis[i].classList.remove('is-off');
      else lis[i].classList.add('is-off');

      r.tag.hidden = on;
      r.pct.textContent = on && total > 0
        ? (o.weight / total * 100).toFixed(1) + '%'
        : '\u2014';

      setIfIdle(r.name, o.name);
      setIfIdle(r.weight, String(o.weight));
      setIfIdle(r.qty, String(o.qty));
      if (r.zero !== document.activeElement) r.zero.checked = o.removeAtZero;
      if (r.color !== document.activeElement) r.color.value = o.color;
      // 每列控制項都要帶出是哪個選項，否則整份清單的可及名稱完全一樣
      var who = displayName(o) + (on ? '' : '（已用完）');
      r.name.setAttribute('aria-label', '名稱：' + who);
      r.weight.setAttribute('aria-label', '權重：' + who);
      r.qty.setAttribute('aria-label', '數量：' + who);
      r.color.setAttribute('aria-label', '顏色：' + who);
      r.zero.setAttribute('aria-label', '歸零退出：' + who);
      r.del.setAttribute('aria-label', '刪除：' + who);
    }
  }

  function renderHistory() {
    var stamp = state.history.length + ':' +
                (state.history.length ? state.history[0].t : 0);
    if (stamp === historyStamp) return;
    historyStamp = stamp;

    historyEl.textContent = '';
    for (var i = 0; i < state.history.length; i++) {
      var h = state.history[i];
      var li = document.createElement('li');
      var n = el('span', 'history__name');
      n.textContent = h.name || '未命名';
      var t = el('time', 'history__time');
      t.textContent = fmtTime(h.t);
      li.appendChild(n);
      li.appendChild(t);
      historyEl.appendChild(li);
    }
    historyEmpty.hidden = state.history.length > 0;
  }

  function updateMeta() {
    var n = state.options.length;
    var a = activeOptions().length;
    optionsMeta.textContent = n === 0
      ? '尚無選項'
      : n + ' 個選項，' + a + ' 個在轉盤上';
  }

  function updateControls() {
    var a = activeOptions().length;
    spinBtn.disabled = spinning || a === 0;
    if (spinning) spinBtn.classList.add('is-spinning');
    else spinBtn.classList.remove('is-spinning');
    emptyHint.hidden = a > 0;
    canvas.setAttribute('aria-label', describeWheel());
    deductBox.checked = state.deduct;
    resetQtyBtn.disabled = state.options.length === 0;
    exportBtn.disabled = state.options.length === 0;
    loadDefaultsBtn.disabled = spinning;
    clearAllBtn.disabled = state.options.length === 0 && state.history.length === 0;
    clearHistoryBtn.disabled = state.history.length === 0;
  }

  // 控制項可能在自己的處理常式裡變成 disabled，瀏覽器會把焦點丟回 body。
  // 這裡負責把焦點接到下一個還能用的目標，鍵盤操作才不會被丟回頁首。
  function handOffFocus() {
    var args = Array.prototype.slice.call(arguments);
    if (document.activeElement && document.activeElement !== document.body) return;
    for (var i = 0; i < args.length; i++) {
      var t = args[i];
      if (t && !t.disabled && t.offsetParent !== null) { t.focus(); return; }
    }
  }

  function describeWheel() {
    var list = activeOptions();
    if (!list.length) return '抽獎轉盤：目前沒有可抽的選項';
    var total = sumWeight(list);
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      parts.push(displayName(list[i]) + ' ' + (list[i].weight / total * 100).toFixed(1) + '%');
    }
    return '抽獎轉盤，共 ' + list.length + ' 個選項：' + parts.join('、');
  }

  function setStatus(text, idle) {
    statusEl.textContent = text;
    if (idle) statusEl.setAttribute('data-idle', '1');
    else statusEl.removeAttribute('data-idle');
  }

  function refresh() {
    syncRows();
    renderHistory();
    updateMeta();
    updateControls();
    drawWheel();
    save();
  }

  function renderAll() {
    renderList();
    refresh();
  }

  /* ── 轉盤繪製 ─────────────────────────────────────── */

  function fitCanvas() {
    var rect = stage.getBoundingClientRect();
    var w = Math.max(160, rect.width);
    var dpr = window.devicePixelRatio || 1;
    view.w = w;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(w * dpr);
    ctx.setTransform(canvas.width / w, 0, 0, canvas.height / w, 0, 0);
    drawWheel();
  }

  function luminance(hex) {
    function ch(i) { return parseInt(hex.substr(i, 2), 16) / 255; }
    function lin(x) { return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
    return 0.2126 * lin(ch(1)) + 0.7152 * lin(ch(3)) + 0.0722 * lin(ch(5));
  }

  function contrast(a, b) {
    var hi = Math.max(a, b);
    var lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  // 標籤文字色取對比度較高的一邊，而不是猜一個亮度門檻
  function textOn(hex) {
    var L = luminance(hex);
    return contrast(L, luminance(INK)) >= contrast(L, luminance(PAPER)) ? INK : PAPER;
  }

  function labelText(o) {
    var qty = (o.qty === 0 && o.removeAtZero === false) ? '\u221e' : String(o.qty);
    return displayName(o) + ' \u00d7' + qty;
  }

  function ellipsize(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1) {
      s = s.slice(0, -1);
      if (ctx.measureText(s + '\u2026').width <= maxW) return s + '\u2026';
    }
    return '\u2026';
  }

  function drawLabel(o, mid, span, cx, cy, rIn, rOut) {
    var maxW = rOut - rIn;
    if (maxW < 34) return;

    var size = Math.max(11, Math.min(19, (rOut + rIn) * 0.055));
    // 扇形太窄就省略標籤，不讓文字溢出到隔壁
    if (span * (rIn + maxW * 0.45) < size * 1.15) return;

    var m = norm(mid);
    var flip = m > Math.PI / 2 && m < Math.PI * 1.5;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(flip ? mid + Math.PI : mid);
    ctx.font = '600 ' + size.toFixed(1) + 'px ' + LABEL_FONT;
    ctx.textAlign = flip ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textOn(o.color);
    ctx.fillText(ellipsize(labelText(o), maxW), flip ? -rOut : rOut, 0);
    ctx.restore();
  }

  function drawWheel() {
    var w = view.w;
    if (!w) return;

    var cx = w / 2;
    var cy = w / 2;
    var rim = Math.max(6, w * 0.022);
    var rEdge = w / 2 - 3;
    var r = rEdge - rim;
    var hubR = w * 0.158;
    // 轉動中一律畫開始轉的當下那份清單：中獎者與停止角度是那時算好的，
    // 中途改權重／刪選項若讓扇形跟著變，指針就會停在對不上的扇形上。
    var list = frozen || activeOptions();
    var i;

    ctx.clearRect(0, 0, w, w);

    // 邊界情況：沒有任何啟用中的選項 -> 虛線空圓
    if (!list.length) {
      ctx.save();
      ctx.setLineDash([10, 10]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = RULE;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
      ctx.restore();
      return;
    }

    var total = sumWeight(list);
    var a = rotation;
    var span;

    // 扇形：面積與正規化後的權重一致
    for (i = 0; i < list.length; i++) {
      span = list[i].weight / total * TAU;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a, a + span);
      ctx.closePath();
      ctx.fillStyle = list[i].color;
      ctx.fill();
      if (list.length > 1) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,253,247,.7)';
        ctx.stroke();
      }
      a += span;
    }

    // 外框
    ctx.beginPath();
    ctx.arc(cx, cy, r + rim / 2, 0, TAU);
    ctx.lineWidth = rim;
    ctx.strokeStyle = INK;
    ctx.stroke();

    // 圓心底座（實體按鈕疊在上面）
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, TAU);
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(25,21,18,.25)';
    ctx.stroke();

    // 標籤
    a = rotation;
    for (i = 0; i < list.length; i++) {
      span = list[i].weight / total * TAU;
      drawLabel(list[i], a + span / 2, span, cx, cy, hubR + 16, r - 14);
      a += span;
    }
  }

  /* ── 自訂對話框（不使用 alert / confirm / prompt）─── */

  function openModal(cfg) {
    return new Promise(function (resolve) {
      var prev = document.activeElement;
      var back = el('div', 'modal-backdrop');
      var box = el('div', 'modal');
      var titleId = 'modal-title-' + uid();
      var done = false;
      var focusTarget = null;

      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', titleId);

      if (cfg.cls) box.className += ' ' + cfg.cls;

      var title = el('p', 'modal__title');
      title.id = titleId;
      title.textContent = cfg.title;
      box.appendChild(title);

      if (cfg.content) box.appendChild(cfg.content);
      if (cfg.text) {
        var p = el('p', 'modal__text');
        p.textContent = cfg.text;
        box.appendChild(p);
      }
      var desc = box.querySelector('.modal__winner, .modal__text');
      if (desc) {
        desc.id = titleId + '-desc';
        box.setAttribute('aria-describedby', desc.id);
      }

      var acts = el('div', 'modal__actions');
      cfg.actions.forEach(function (a) {
        var b = el('button', 'btn' + (a.primary ? ' btn--primary' : '') + (a.danger ? ' btn--danger' : ''));
        b.type = 'button';
        b.textContent = a.label;
        b.disabled = a.disabled === true;
        // keepOpen 的按鈕（複製／下載）按完要留在對話框裡，才能連按第二次
        if (a.keepOpen) {
          b.addEventListener('click', function () { if (a.onClick) a.onClick(b); });
        } else {
          b.addEventListener('click', function () { close(a.value); });
        }
        acts.appendChild(b);
        if (!b.disabled && cfg.focus !== undefined && cfg.focus === a.value) focusTarget = b;
      });
      box.appendChild(acts);
      back.appendChild(box);

      function close(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        if (back.parentNode) back.parentNode.removeChild(back);
        if (app && !document.querySelector('.modal-backdrop')) {
          app.removeAttribute('inert');
          app.removeAttribute('aria-hidden');
        }
        if (!document.querySelector('.modal-backdrop')) document.body.classList.remove('has-modal');
        if (prev && typeof prev.focus === 'function') {
          try { prev.focus(); } catch (e) { /* 元素可能已被移除 */ }
        }
        resolve(value);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(cfg.escapeValue); return; }
        if (e.key !== 'Tab') return;
        var f = box.querySelectorAll(
          'button:not([disabled]), textarea:not([disabled]), input:not([disabled])');
        if (!f.length) return;
        var first = f[0];
        var last = f[f.length - 1];
        if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }

      back.addEventListener('click', function (e) { if (e.target === back) close(cfg.escapeValue); });
      document.addEventListener('keydown', onKey, true);
      modalRoot.appendChild(back);
      document.body.classList.add('has-modal');
      if (app) {
        app.setAttribute('inert', '');
        app.setAttribute('aria-hidden', 'true');
      }

      var f0 = focusTarget || box.querySelector('button:not([disabled])');
      if (f0) f0.focus();
    });
  }

  function askConfirm(title, text, label) {
    return openModal({
      title: title,
      text: text,
      escapeValue: false,
      actions: [
        { label: '取消', value: false },
        { label: label, value: true, danger: true }
      ]
    });
  }

  /* ── 匯出清單 ────────────────────────────────── */

  // 與批次貼上同一個格式：名稱, 權重, 數量。貼回批次貼上即可還原清單。
  function exportText() {
    var lines = [];
    for (var i = 0; i < state.options.length; i++) {
      var o = state.options[i];
      lines.push(displayName(o) + ', ' + o.weight + ', ' + o.qty);
    }
    return lines.join('\n');
  }

  function exportFileName() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return 'wheel-list-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes()) + '.txt';
  }

  /* 退路：選取畫面上那塊 textarea 再 execCommand。
     navigator.clipboard 在非安全來源或 sandbox iframe 會缺席或直接被拒，
     少了這條退路「複製」就只是沒反應。而且 execCommand 回報成功不代表
     真的寫進剪貼簿（沙箱會靜默丟掉），所以退路一律留著選取狀態，
     即使兩條都失效，使用者也能直接自己複製。 */
  function selectCopy(node) {
    try {
      node.focus();
      node.select();
      node.setSelectionRange(0, node.value.length);
      return document.execCommand('copy') === true;
    } catch (e) { return false; }
  }

  function copyText(text, node) {
    return new Promise(function (resolve) {
      try {
        if (window.navigator && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () { resolve(true); },
            function () { resolve(selectCopy(node)); }
          );
          return;
        }
      } catch (e) { /* 落到退路 */ }
      resolve(selectCopy(node));
    });
  }

  function downloadText(text, filename) {
    var url;
    try {
      url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    } catch (e) { return false; }
    try {
      var a = el('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
    } catch (e) {
      try { URL.revokeObjectURL(url); } catch (e2) { /* 已釋放 */ }
      return false;
    }
    // 立刻 revoke 會讓部分瀏覽器的下載中斷，延後釋放
    window.setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (e) { /* 已釋放 */ }
    }, 60000);
    return true;
  }

  function openExport() {
    if (!state.options.length) return;

    var text = exportText();
    var frag = document.createDocumentFragment();
    var timer = 0;
    var closed = false;

    var ta = document.createElement('textarea');
    ta.className = 'export__text';
    ta.readOnly = true;
    ta.spellcheck = false;
    ta.rows = Math.max(4, Math.min(12, state.options.length));
    ta.value = text;
    ta.setAttribute('aria-label', '清單內容');
    frag.appendChild(ta);

    var note = el('p', 'export__note');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    frag.appendChild(note);

    function flash(msg) {
      // 對話框可能在 clipboard 的 Promise resolve 之前就被關掉了
      if (closed) return;
      note.textContent = msg;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { note.textContent = ''; }, 2400);
    }

    openModal({
      title: '匯出清單',
      cls: 'modal--wide',
      content: frag,
      escapeValue: 'close',
      focus: 'copy',
      actions: [
        { label: '關閉', value: 'close' },
        {
          label: '下載為 TXT', value: 'download', keepOpen: true,
          onClick: function () {
            flash(downloadText(text, exportFileName())
              ? '已開始下載'
              : '這個瀏覽器擋下了下載，請改用複製');
          }
        },
        {
          label: '複製', value: 'copy', primary: true, keepOpen: true,
          onClick: function () {
            copyText(text, ta).then(function (ok) {
              flash(ok ? '已複製' : '已選取文字，請自行複製');
            });
          }
        }
      ]
    }).then(function () { closed = true; window.clearTimeout(timer); });
  }

  /* ── 結果 ───────────────────────────────────── */

  // 結果對話框只顯示中獎名稱，不出現任何庫存說明
  function showResult(o) {
    var frag = document.createDocumentFragment();
    var name = el('p', 'modal__winner');
    name.textContent = displayName(o);
    var bar = el('span', 'modal__bar');
    bar.style.background = o.color;
    frag.appendChild(name);
    frag.appendChild(bar);

    openModal({
      title: '抽中',
      content: frag,
      escapeValue: 'close',
      focus: 'close',
      actions: [
        { label: '關閉', value: 'close' },
        { label: '再轉一次', value: 'again', primary: true, disabled: activeOptions().length === 0 }
      ]
    }).then(function (v) {
      if (v === 'again') spin();
    });
  }

  /* ── 抽獎 ─────────────────────────────────────────── */

  /* 先用加權亂數決定中獎者，再反推停止角度，最後才播動畫。
     不用「先轉再看指針落在哪」，避免浮點誤差污染機率。 */
  function spin() {
    if (spinning) return;
    var list = activeOptions();
    if (!list.length) return;

    var total = sumWeight(list);
    var pick = rand() * total;
    var acc = 0;
    var idx = list.length - 1;
    var i;

    for (i = 0; i < list.length; i++) {
      acc += list[i].weight;
      if (pick < acc) { idx = i; break; }
    }

    var start = 0;
    for (i = 0; i < idx; i++) start += list[i].weight / total * TAU;
    var span = list[idx].weight / total * TAU;

    // 保留邊界 margin，指針不會壓在分隔線上
    var margin = Math.min(span * 0.2, 0.05);
    var target = start + margin + rand() * (span - margin * 2);

    var reduce = prefersReduced();
    var turns = reduce ? REDUCED_TURNS : SPIN_TURNS;
    var dur = reduce ? REDUCED_MS : SPIN_MS;
    var from = rotation;
    var to = from + turns * TAU + norm(norm(POINTER - target) - norm(from));
    frozen = list;
    var t0 = clock();
    var rafId = 0;
    var timerId = 0;
    var ended = false;

    spinning = true;
    updateControls();
    setStatus('轉動中…', true);

    /* rAF 為主，setTimeout 為備援。
       背景分頁與部分預覽沙箱不會觸發 rAF，少了備援動畫就永遠停不下來，
       轉盤會卡在「轉動中」而且按鈕一直停用。 */
    function schedule() {
      if (window.requestAnimationFrame) rafId = window.requestAnimationFrame(step);
      timerId = window.setTimeout(step, 32);
    }

    function step() {
      if (ended) return;
      if (rafId && window.cancelAnimationFrame) window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
      rafId = 0;
      timerId = 0;

      var p = dur <= 0 ? 1 : Math.min(1, (clock() - t0) / dur);
      rotation = from + (to - from) * easeOutQuart(p);
      drawWheel();

      if (p < 1) { schedule(); return; }
      ended = true;
      rotation = norm(to);
      drawWheel();
      spinning = false;
      settle(list[idx]);
    }

    schedule();
  }

  function settle(o) {
    frozen = null;

    // 「全部清空」「回到預設清單」或刪除可能在動畫途中把中獎者移出清單，
    // 這時不能扣數量、不能補紀錄，也不該跳出已經不存在的獎項。
    if (state.options.indexOf(o) < 0) {
      setStatus('', true);
      refresh();
      return;
    }

    if (state.deduct) {
      o.qty = Math.max(0, o.qty - 1);
      shareFrom(o);   // 同名共用同一份庫存，整組一起扣
    }

    state.history.unshift({ name: displayName(o), t: Date.now() });
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;

    setStatus('抽中 ' + displayName(o), false);
    refresh();
    if (document.activeElement === document.body) spinBtn.focus();
    showResult(o);
  }

  /* ── 新增 ─────────────────────────────────────────── */

  function addOne() {
    var name = clampName(addName.value).trim();
    if (!name) {
      addError.hidden = false;
      addName.setAttribute('aria-invalid', 'true');
      addName.parentNode.classList.add('is-invalid');
      addName.focus();
      return;
    }
    addError.hidden = true;
    addName.removeAttribute('aria-invalid');
    addName.parentNode.classList.remove('is-invalid');

    var at = state.options.length;
    var made = makeOption(name, addWeight.value, addQty.value, true);
    state.options.push(made);
    joinGroup(made);
    appendRows(at);

    addName.value = '';
    addWeight.value = '1';
    addQty.value = '1';
    addName.focus();
  }

  // 一行一筆：名稱, 權重, 數量（權重與數量可省略，預設 1）
  function addBatch() {
    var lines = String(batchText.value).split(/\r?\n/);
    var at = state.options.length;
    var added = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var parts = line.split(/[,\t、，]/);
      var name = clampName(parts[0]).trim();
      if (!name) continue;
      var w = parts.length > 1 && String(parts[1]).trim() !== '' ? parts[1] : 1;
      var q = parts.length > 2 && String(parts[2]).trim() !== '' ? parts[2] : 1;
      var made = makeOption(name, w, q, true);
      state.options.push(made);
      joinGroup(made);   // 同一批次裡的同名列也會併成一組
      added += 1;
    }
    if (!added) return;
    batchText.value = '';
    appendRows(at);
  }

  /* ── 事件與啟動 ───────────────────────────────────── */

  function bind() {
    spinBtn.addEventListener('click', spin);

    deductBox.addEventListener('change', function () {
      state.deduct = deductBox.checked;
      refresh();
    });

    resetQtyBtn.addEventListener('click', function () {
      for (var i = 0; i < state.options.length; i++) {
        state.options[i].qty = state.options[i].qty0;
      }
      refresh();
      handOffFocus(resetQtyBtn, spinBtn);
    });

    loadDefaultsBtn.addEventListener('click', function () {
      askConfirm('回到預設清單', '目前的選項清單會被捨棄，換成內建的預設示範選項。', '載入預設')
        .then(function (ok) {
          if (ok !== true) return;
          state.options = defaultOptions();
          renderAll();
          handOffFocus(loadDefaultsBtn, spinBtn);
        });
    });

    clearAllBtn.addEventListener('click', function () {
      askConfirm('全部清空', '所有選項與抽獎紀錄都會被刪除，這個動作無法復原。', '全部清空')
        .then(function (ok) {
          if (ok !== true) return;
          state.options = [];
          state.history = [];
          setStatus('', true);
          renderAll();
          handOffFocus(clearAllBtn, loadDefaultsBtn, addName);
        });
    });

    clearHistoryBtn.addEventListener('click', function () {
      state.history = [];
      refresh();
      handOffFocus(clearHistoryBtn, spinBtn, addName);
    });

    addForm.addEventListener('submit', function (e) {
      e.preventDefault();
      addOne();
    });
    addName.addEventListener('input', function () {
      addError.hidden = true;
      addName.removeAttribute('aria-invalid');
      addName.parentNode.classList.remove('is-invalid');
    });

    exportBtn.addEventListener('click', openExport);

    $('batchAdd').addEventListener('click', addBatch);
    $('batchClear').addEventListener('click', function () {
      batchText.value = '';
      batchText.focus();
    });

    if (window.ResizeObserver) {
      new window.ResizeObserver(fitCanvas).observe(stage);
    } else {
      window.addEventListener('resize', fitCanvas);
    }
  }

  function init() {
    var loaded = parseState(readRaw());
    if (loaded) {
      state = loaded;
    } else {
      state = { options: defaultOptions(), history: [], deduct: true };
    }
    setStatus('', true);
    bind();
    renderList();
    fitCanvas();
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
