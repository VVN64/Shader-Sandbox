/* ShaderSandbox — generic 2D function grapher for shaping functions.
 * Exposes NS.createGraphWidget(container, options) -> { resize(), destroy(), setProbes(probes), invalidate() }
 * Layout: toolbar / [graph + horizontal scrollbar | splitter | sidebar (equations, shader values, table)].
 * State (equations, view preset, step, sidebar width) persists in localStorage "shadersandbox.graph"
 * unless options.persist === false.
 * Also exposes NS._compileExpr(src) for testing the safe expression compiler.
 */
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) {
  'use strict';

  /* ======================================================================
   * Expression compiler (GLSL-like subset -> JS function)
   * The user's text is tokenized and parsed against a whitelist; only the
   * generated, validated JS string is handed to `new Function`.
   * ==================================================================== */

  function fract(v) { return v - Math.floor(v); }
  function clampN(v, a, b) { return Math.min(Math.max(v, a), b); }

  var HELPERS = Object.freeze({
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos,
    atan: function (y, x) { return x === undefined ? Math.atan(y) : Math.atan2(y, x); },
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    pow: Math.pow, exp: Math.exp,
    exp2: function (v) { return Math.pow(2, v); },
    log: Math.log, log2: Math.log2, sqrt: Math.sqrt,
    inversesqrt: function (v) { return 1 / Math.sqrt(v); },
    abs: Math.abs, sign: Math.sign, floor: Math.floor, ceil: Math.ceil,
    fract: fract,
    mod: function (a, b) { return a - b * Math.floor(a / b); },
    min: Math.min, max: Math.max,
    clamp: clampN,
    mix: function (a, b, k) { return a * (1 - k) + b * k; },
    step: function (edge, v) { return v < edge ? 0 : 1; },
    smoothstep: function (e0, e1, v) {
      var k = clampN((v - e0) / (e1 - e0), 0, 1);
      return k * k * (3 - 2 * k);
    },
    round: function (v) { return Math.sign(v) * Math.floor(Math.abs(v) + 0.5); },
    trunc: Math.trunc,
    rand: function (v) { return fract(Math.sin(v * 12.9898) * 43758.5453); },
    radians: function (v) { return v * Math.PI / 180; },
    degrees: function (v) { return v * 180 / Math.PI; }
  });

  // [minArgs, maxArgs]
  var ARITY = {
    sin: [1, 1], cos: [1, 1], tan: [1, 1], asin: [1, 1], acos: [1, 1], atan: [1, 2],
    sinh: [1, 1], cosh: [1, 1], tanh: [1, 1],
    pow: [2, 2], exp: [1, 1], exp2: [1, 1], log: [1, 1], log2: [1, 1],
    sqrt: [1, 1], inversesqrt: [1, 1],
    abs: [1, 1], sign: [1, 1], floor: [1, 1], ceil: [1, 1], fract: [1, 1],
    mod: [2, 2], min: [2, 2], max: [2, 2], clamp: [3, 3], mix: [3, 3],
    step: [2, 2], smoothstep: [3, 3], round: [1, 1], trunc: [1, 1], rand: [1, 1],
    radians: [1, 1], degrees: [1, 1]
  };

  var CONSTS = {
    PI: Math.PI, TWO_PI: Math.PI * 2, HALF_PI: Math.PI / 2, E: Math.E
  };

  // identifier -> generated JS variable name
  var VARS = { x: 'x', t: 't', u_time: 't' };

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function ExprError(message, pos) {
    this.message = message;
    this.pos = pos;
  }

  var NUM_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
  var REF_RE = /^y(\d{1,3})$/;   // y1, y2, ... = another equation's value at the same x and t
  var MAX_REF = 16;
  var IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

  function tokenize(src) {
    var toks = [];
    var i = 0, n = src.length;
    while (i < n) {
      var c = src.charAt(i);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      var rest = src.slice(i);
      var m = NUM_RE.exec(rest);
      if (m) {
        toks.push({ type: 'num', value: parseFloat(m[0]), text: m[0], pos: i });
        i += m[0].length;
        continue;
      }
      m = IDENT_RE.exec(rest);
      if (m) {
        toks.push({ type: 'ident', value: m[0], text: m[0], pos: i });
        i += m[0].length;
        continue;
      }
      if ('+-*/^(),'.indexOf(c) >= 0) {
        toks.push({ type: 'op', value: c, text: c, pos: i });
        i++;
        continue;
      }
      throw new ExprError("Unexpected character '" + c + "'", i);
    }
    toks.push({ type: 'eof', value: '', text: 'end of input', pos: n });
    return toks;
  }

  function Parser(toks) {
    this.toks = toks;
    this.i = 0;
    this.usesT = false;
    this.refs = {};          // 0-based indices of other equations referenced (y1 -> 0)
  }
  Parser.prototype.peek = function () { return this.toks[this.i]; };
  Parser.prototype.next = function () { return this.toks[this.i++]; };
  Parser.prototype.isOp = function (v) {
    var tk = this.toks[this.i];
    return tk.type === 'op' && tk.value === v;
  };
  Parser.prototype.fail = function (tk, msg) {
    if (!msg) {
      msg = tk.type === 'eof' ? 'Unexpected end of expression' : "Unexpected '" + tk.text + "'";
      var prev = this.toks[this.i - 1];
      if (prev && tk.type !== 'eof' && tk.type !== 'op' &&
          (prev.type === 'num' || prev.type === 'ident' || (prev.type === 'op' && prev.value === ')'))) {
        msg += ' (missing operator?)';
      }
    }
    throw new ExprError(msg, tk.pos);
  };
  Parser.prototype.expectOp = function (v) {
    var tk = this.peek();
    if (tk.type === 'op' && tk.value === v) { this.i++; return tk; }
    this.fail(tk, "Expected '" + v + "' but found " +
      (tk.type === 'eof' ? 'end of input' : "'" + tk.text + "'"));
  };
  Parser.prototype.parseExpr = function () { return this.parseAdd(); };
  Parser.prototype.parseAdd = function () {
    var left = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      var op = this.next().value;
      var right = this.parseMul();
      left = '(' + left + op + right + ')';
    }
    return left;
  };
  Parser.prototype.parseMul = function () {
    var left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/')) {
      var op = this.next().value;
      var right = this.parseUnary();
      left = '(' + left + op + right + ')';
    }
    return left;
  };
  Parser.prototype.parseUnary = function () {
    if (this.isOp('-')) { this.next(); return '(-' + this.parseUnary() + ')'; }
    if (this.isOp('+')) { this.next(); return this.parseUnary(); }
    return this.parsePow();
  };
  Parser.prototype.parsePow = function () {
    var base = this.parsePrimary();
    if (this.isOp('^')) {
      this.next();
      var ex = this.parseUnary(); // right-associative, allows 2^-1
      return 'F.pow(' + base + ',' + ex + ')';
    }
    return base;
  };
  Parser.prototype.parsePrimary = function () {
    var tk = this.peek();
    if (tk.type === 'num') {
      this.next();
      return isFinite(tk.value) ? '(' + String(tk.value) + ')' : '(1/0)';
    }
    if (tk.type === 'ident') {
      this.next();
      var name = tk.value;
      if (this.isOp('(')) {
        if (!has(ARITY, name)) this.fail(tk, "Unknown function '" + name + "'");
        this.next();
        var args = [];
        if (!this.isOp(')')) {
          args.push(this.parseExpr());
          while (this.isOp(',')) { this.next(); args.push(this.parseExpr()); }
        }
        this.expectOp(')');
        var ar = ARITY[name];
        if (args.length < ar[0] || args.length > ar[1]) {
          var want = ar[0] === ar[1] ? String(ar[0]) : ar[0] + '-' + ar[1];
          this.fail(tk, name + '() takes ' + want + ' argument' + (want === '1' ? '' : 's') +
            ', got ' + args.length);
        }
        return 'F.' + name + '(' + args.join(',') + ')';
      }
      if (has(VARS, name)) {
        if (VARS[name] === 't') this.usesT = true;
        return VARS[name];
      }
      var ref = REF_RE.exec(name);
      if (ref) {
        var k = parseInt(ref[1], 10);
        if (k < 1 || k > MAX_REF) this.fail(tk, "There is no equation '" + name + "' (use y1-y" + MAX_REF + ")");
        this.refs[k - 1] = true;
        return 'Y(' + (k - 1) + ',x,t)';   /* k is a validated integer */
      }
      if (has(CONSTS, name)) return '(' + String(CONSTS[name]) + ')';
      if (has(ARITY, name)) this.fail(tk, "'" + name + "' is a function, use " + name + '(...)');
      this.fail(tk, "Unknown identifier '" + name + "'");
    }
    if (tk.type === 'op' && tk.value === '(') {
      this.next();
      var e = this.parseExpr();
      this.expectOp(')');
      return '(' + e + ')';
    }
    this.fail(tk);
  };

  /** Compile a user expression.
   *  Returns { ok:true, fn:(x,t,Y)=>number|null, usesT, refs:number[], empty } or { ok:false, error, pos }.
   *  Y(k, x, t) evaluates equation k (0-based) and is supplied by the widget. */
  function compileExpr(src) {
    src = String(src == null ? '' : src);
    var offset = 0;
    var pre = /^\s*y\d*\s*=(?!=)/.exec(src); // tolerate a leading "y =" or "y2 ="
    if (pre) { offset = pre[0].length; src = src.slice(offset); }
    if (/^\s*$/.test(src)) return { ok: true, fn: null, usesT: false, refs: [], empty: true };
    try {
      var toks = tokenize(src);
      var p = new Parser(toks);
      var js = p.parseExpr();
      if (p.peek().type !== 'eof') p.fail(p.peek());
      /* js consists only of: numeric literals, x, t, F.<whitelisted name>, Y(<int>,x,t), + - * / ( ) , */
      var factory = new Function('F', '"use strict"; return function (x, t, Y) { return ' + js + '; };');
      var refs = Object.keys(p.refs).map(Number).sort(function (a, b) { return a - b; });
      return { ok: true, fn: factory(HELPERS), usesT: p.usesT, refs: refs, empty: false, js: js };
    } catch (err) {
      if (err instanceof ExprError) {
        var col = err.pos + offset + 1;
        return { ok: false, error: err.message + ' (col ' + col + ')', pos: err.pos + offset };
      }
      return { ok: false, error: 'Invalid expression', pos: 0 };
    }
  }

  NS._compileExpr = compileExpr;

  /* ======================================================================
   * Widget
   * ==================================================================== */

  var PALETTE = ['#6cb6ff', '#ff7b72', '#5fd38d', '#f2cc60', '#c792ea', '#ff9e64', '#4dd0e1', '#f48fb1'];
  var DEFAULT_EXPRS = [
    'x',
    'smoothstep(0.0, 1.0, x)',
    'pow(x, 5.0)',
    'sin(x*PI)',
    'step(0.5, x)',
    'fract(x*3.0)',
    'abs(sin(x*PI*2.0+t))',
    '1.0 - pow(abs(x), 0.5)'
  ];
  var MAX_EQS = 16;
  var DEFAULT_EQ_COUNT = 2;
  var MAX_ROWS = 401;
  var PRESETS = {
    '01': { domain: [0, 1], view: { xmin: -0.05, xmax: 1.05, ymin: -0.1, ymax: 1.1 } },
    '11': { domain: [-1, 1], view: { xmin: -1.1, xmax: 1.1, ymin: -1.1, ymax: 1.1 } }
  };
  var NARROW_PX = 520;
  var SIDE_MIN = 220, SIDE_DEFAULT = 300, SIDE_MAX_FRAC = 0.6;
  var SCROLL_PAD = 10;               // scroll extent = preset domain ± 10 domain widths
  var STORE_KEY = 'shadersandbox.graph';
  var COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
  var HELP_TITLE = 'Wheel: zoom · Shift+wheel or the scrollbar: scroll horizontally · Drag: pan · ' +
    'Double-click: reset\nCtrl+wheel: zoom x only · Alt+wheel: zoom y only · ←/→: scroll · Home: reset';
  var HELP_ROWS_TOUCH = [
    ['Drag', 'pan'],
    ['Pinch', 'zoom'],
    ['Double-tap', 'reset view'],
    ['Touch & hold', 'read values'],
    ['y1, y2, …', 'use another line, e.g. step(y3, 1.0)']
  ];
  var HELP_ROWS = [
    ['Wheel', 'zoom around the cursor'],
    ['Shift+wheel / scrollbar', 'scroll horizontally'],
    ['Drag', 'pan'],
    ['Double-click / Home', 'reset view'],
    ['Ctrl / Alt + wheel', 'zoom x / y only'],
    ['← →', 'scroll (graph focused)'],
    ['y1, y2, …', 'use another line, e.g. step(y3, 1.0)']
  ];

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (var k in attrs) if (has(attrs, k)) e.setAttribute(k, attrs[k]);
    return e;
  }
  function spanText(cls, text) { var s = el('span', cls); s.textContent = text; return s; }
  function focusQuiet(e) { try { e.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }

  function loadStore() {
    try {
      var s = window.localStorage.getItem(STORE_KEY);
      if (!s) return null;
      var o = JSON.parse(s);
      return o && typeof o === 'object' ? o : null;
    } catch (e) { return null; }
  }
  function saveStore(o) {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
  }

  function niceCeil(v) {
    if (!(v > 0) || !isFinite(v)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / p;
    var r = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    return r * p;
  }
  function nextNice(v) { return niceCeil(v * 1.01); }
  function mantissa(v) { return Math.round(v / Math.pow(10, Math.floor(Math.log10(v) + 1e-9))); }
  function stepDecimals(step) {
    if (!(step > 0)) return 0;
    var d = -Math.floor(Math.log10(step) + 1e-9);
    return Math.max(0, d);
  }
  function decimalsOf(step) {
    // decimals needed to represent the step exactly (e.g. 0.25 -> 2, 0.001 -> 3)
    var s = String(step);
    var m = /e-(\d+)$/.exec(s);
    if (m) {
      var mant = s.split('e')[0];
      var md = mant.indexOf('.') >= 0 ? mant.split('.')[1].length : 0;
      return Math.min(12, parseInt(m[1], 10) + md);
    }
    var dot = s.indexOf('.');
    return dot < 0 ? 0 : Math.min(12, s.length - dot - 1);
  }
  function fmtLabel(v, decimals) {
    var s = v.toFixed(decimals);
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
    return s;
  }
  function fmtVal(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    if (Math.abs(v) < 5e-5) v = 0;
    return v.toFixed(4);
  }

  /** options: { onRemoveProbe?(id), persist?: boolean (default true; false = don't read/write
   *  localStorage), expressions?: string[], lines?: number, view?: '01'|'-11', step?: number,
   *  playing?: boolean }. Persisted state (if any) wins over expressions/lines/view/step. */
  NS.createGraphWidget = function (container, options) {
    options = options || {};
    var persist = options.persist !== false;
    var saved = persist ? loadStore() : null;

    /* ---------------- state ---------------- */
    var presetKey = (function () {
      var v = saved && saved.view != null ? saved.view : options.view;
      return v === '-11' || v === '11' ? '11' : '01';
    })();
    var view = Object.assign({}, PRESETS[presetKey].view);
    var step = (function () {
      var s = saved && +saved.step >= 0.001 ? +saved.step : (options.step > 0 ? +options.step : 0.1);
      return Math.max(0.001, s);
    })();
    var sideW = saved && isFinite(saved.sidebarWidth) && saved.sidebarWidth > 0 ? +saved.sidebarWidth : null; // null = auto
    var playing = options.playing !== false;
    var clockBase = 0;                 // accumulated seconds while paused
    var clockStart = performance.now(); // when the clock was last resumed

    var eqs = [];
    var eqSeq = 0;

    function makeEq(expr, color, visible) {
      var c = compileExpr(expr);
      return {
        id: ++eqSeq,
        expr: expr,
        color: color,
        visible: visible !== false,
        fn: c.ok ? c.fn : null,
        usesT: c.ok ? c.usesT : false,
        refs: c.ok ? c.refs : [],
        usesTEff: false,        // usesT, including through referenced equations
        refError: null,         // missing / circular reference (set by resolveRefs)
        error: c.ok ? null : c.error,
        stale: false,
        rowEl: null, inputEl: null, labEl: null, cbEl: null, rmEl: null
      };
    }
    /** Least-used palette colour (earliest wins), so colours cycle once all 8 are taken. */
    function nextColor() {
      var counts = PALETTE.map(function () { return 0; });
      eqs.forEach(function (L) {
        var i = PALETTE.indexOf(String(L.color).toLowerCase());
        if (i >= 0) counts[i]++;
      });
      var best = 0;
      for (var i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
      return PALETTE[best];
    }
    function nextExpr() {
      var used = {};
      eqs.forEach(function (L) { used[String(L.expr).trim()] = true; });
      for (var i = 0; i < DEFAULT_EXPRS.length; i++) if (!has(used, DEFAULT_EXPRS[i])) return DEFAULT_EXPRS[i];
      return '';
    }

    if (saved && Array.isArray(saved.equations)) {
      saved.equations.slice(0, MAX_EQS).forEach(function (q) {
        if (!q || typeof q !== 'object') return;
        var color = typeof q.color === 'string' && COLOR_RE.test(q.color) ? q.color : nextColor();
        eqs.push(makeEq(typeof q.expr === 'string' ? q.expr : '', color, q.visible !== false));
      });
    } else if (Array.isArray(options.expressions)) {
      options.expressions.slice(0, MAX_EQS).forEach(function (s) {
        eqs.push(makeEq(String(s == null ? '' : s), nextColor(), true));
      });
    } else {
      var n0 = options.lines != null ? parseInt(options.lines, 10) : DEFAULT_EQ_COUNT;
      n0 = clampN(isFinite(n0) ? n0 : DEFAULT_EQ_COUNT, 0, MAX_EQS);
      for (var e0 = 0; e0 < n0; e0++) eqs.push(makeEq(nextExpr(), nextColor(), true));
    }

    var hover = null;          // { x: worldX, src: 'canvas'|'table', cx, cy, row }
    var drag = null;           // canvas pan drag
    var sbDrag = null;         // scrollbar thumb drag
    var splitDrag = null;      // sidebar splitter drag
    var frameId = 0;
    var tableDirty = true;
    var lastTableAt = 0;
    var dpr = 1;
    var theme = {};
    var destroyed = false;
    var tableRowsX = [];
    var tableCells = [];       // [row][col] -> td
    var tableHeads = [];       // th per equation column (title kept in sync with the expression)
    var tableSig = '';
    var hlRowEl = null;

    // shader probes (values sampled from the GPU by the app)
    var probes = [];           // internal probe records, see setProbes()
    var probeVis = {};         // id -> [bool per component]; survives setProbes() calls
    var probeGen = 0;          // bumped by invalidate()/setProbes(): sampled data is out of date
    var probeSig = '';         // structure signature of the probe UI
    var rowY = 0.5;
    var lastProbeTableAt = -1e9;
    var trailTimer = 0;
    var tableXKey = '';        // x grid of the table currently shown

    /* ---------------- DOM ---------------- */
    var root = el('div', 'sgw-root');

    // toolbar
    var toolbar = el('div', 'sgw-toolbar');

    var gView = el('div', 'sgw-group');
    gView.appendChild(spanText('sgw-lbl', 'View'));
    var seg = el('div', 'sgw-seg', { role: 'group', 'aria-label': 'View preset' });
    var btn01 = el('button', '', { type: 'button', title: 'x and y from 0 to 1' });
    btn01.textContent = '0 → 1';
    var btn11 = el('button', '', { type: 'button', title: 'x and y from -1 to 1' });
    btn11.textContent = '−1 → 1';
    seg.appendChild(btn01); seg.appendChild(btn11);
    gView.appendChild(seg);
    var resetBtn = el('button', 'sgw-btn', { type: 'button', title: 'Reset zoom/pan to the selected view (or double-click the graph / press Home)' });
    resetBtn.textContent = 'Reset';
    gView.appendChild(resetBtn);
    toolbar.appendChild(gView);

    var gStep = el('label', 'sgw-group');
    gStep.appendChild(spanText('sgw-lbl', 'Step'));
    var stepInput = el('input', 'sgw-num sgw-step', { type: 'number', inputmode: 'decimal', min: '0.001', step: '0.01', title: 'Table x interval (min 0.001)' });
    stepInput.value = String(step);
    gStep.appendChild(stepInput);
    toolbar.appendChild(gStep);

    var gT = el('div', 'sgw-group sgw-tgroup');
    var playBtn = el('button', 'sgw-btn sgw-play', { type: 'button' });
    var tLabel = el('span', 'sgw-tval', { title: 'Time t in seconds (click to reset to 0)' });
    gT.appendChild(playBtn); gT.appendChild(tLabel);
    toolbar.appendChild(gT);

    var helpBtn = el('button', 'sgw-btn sgw-helpbtn', { type: 'button', title: HELP_TITLE, 'aria-label': 'Graph controls', 'aria-expanded': 'false' });
    helpBtn.textContent = '?';
    toolbar.appendChild(helpBtn);
    root.appendChild(toolbar);

    // main: graph column | splitter | sidebar
    var main = el('div', 'sgw-main');

    var gcol = el('div', 'sgw-gcol');
    var plot = el('div', 'sgw-plot', { title: HELP_TITLE });
    var canvas = el('canvas', 'sgw-canvas', {
      tabindex: '0', role: 'img',
      'aria-label': 'Function graph. Left/right arrows scroll horizontally, Home resets the view.'
    });
    var readout = el('div', 'sgw-readout');
    var helpPop = el('div', 'sgw-helppop');
    helpPop.hidden = true;
    HELP_ROWS_TOUCH.forEach(function (r) {
      var d = el('div', 'sgw-helprow sgw-help-touch');
      d.appendChild(spanText('sgw-helpkey', r[0]));
      d.appendChild(spanText('', r[1]));
      helpPop.appendChild(d);
    });
    HELP_ROWS.forEach(function (r) {
      var d = el('div', 'sgw-helprow sgw-help-desk');
      d.appendChild(spanText('sgw-helpkey', r[0]));
      d.appendChild(spanText('', r[1]));
      helpPop.appendChild(d);
    });
    plot.appendChild(canvas);
    plot.appendChild(readout);
    plot.appendChild(helpPop);
    var hbar = el('div', 'sgw-hbar', {
      role: 'scrollbar', 'aria-orientation': 'horizontal', 'aria-label': 'Scroll graph horizontally',
      'aria-valuemin': '0', 'aria-valuemax': '100', title: 'Scroll the graph horizontally (drag, click or wheel)'
    });
    var thumb = el('div', 'sgw-hthumb');
    hbar.appendChild(thumb);
    gcol.appendChild(plot);
    gcol.appendChild(hbar);

    var split = el('div', 'sgw-split', {
      role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',
      'aria-label': 'Resize sidebar', title: 'Drag to resize the sidebar · double-click to reset'
    });

    var side = el('div', 'sgw-side');
    var list = el('div', 'sgw-list');

    // equations section
    var eqSec = el('div', 'sgw-sec');
    var eqHead = el('div', 'sgw-shead');
    eqHead.appendChild(spanText('sgw-stitle', 'Equations'));
    var eqCount = el('span', 'sgw-count');
    eqHead.appendChild(eqCount);
    var addTop = el('button', 'sgw-iconbtn sgw-addtop', { type: 'button', title: 'Add equation', 'aria-label': 'Add equation' });
    addTop.textContent = '+';
    eqHead.appendChild(addTop);
    eqSec.appendChild(eqHead);
    var eqRows = el('div', 'sgw-eqrows');
    eqSec.appendChild(eqRows);
    var eqHint = el('div', 'sgw-hint');
    eqHint.textContent = 'No equations — add one';
    eqSec.appendChild(eqHint);
    var addBtn = el('button', 'sgw-addbtn', { type: 'button' });
    addBtn.textContent = '+ Add equation';
    eqSec.appendChild(addBtn);
    list.appendChild(eqSec);

    // shader values section
    var ROWY_TIP = 'Probes sample the shader along gl_FragCoord.y = rowY × u_resolution.y; graph x = gl_FragCoord.x / u_resolution.x';
    var probeSec = el('div', 'sgw-sec sgw-probes');
    probeSec.style.display = 'none';
    var probeHead = el('div', 'sgw-shead');
    probeHead.appendChild(spanText('sgw-stitle', 'Shader values'));
    var gRowY = el('label', 'sgw-group sgw-rowyg', { title: ROWY_TIP });
    gRowY.appendChild(spanText('sgw-lbl', 'row y'));
    var rowYInput = el('input', 'sgw-num sgw-rowy', { type: 'number', inputmode: 'decimal', min: '0', max: '1', step: '0.01', title: ROWY_TIP, 'aria-label': 'Probe row y (0 to 1)' });
    rowYInput.value = String(rowY);
    gRowY.appendChild(rowYInput);
    probeHead.appendChild(gRowY);
    probeSec.appendChild(probeHead);
    var probeBody = el('div', 'sgw-pbody');
    probeSec.appendChild(probeBody);
    list.appendChild(probeSec);

    // table
    var tableWrap = el('div', 'sgw-tablewrap');
    var table = el('table', 'sgw-table');
    var thead = el('thead');
    var tbody = el('tbody');
    table.appendChild(thead); table.appendChild(tbody);
    tableWrap.appendChild(table);

    var tableBar = el('div', 'sgw-tbar');
    side.appendChild(list);
    side.appendChild(tableBar);
    side.appendChild(tableWrap);
    var ctabs = el('div', 'sgw-ctabs', { role: 'tablist', 'aria-label': 'Graph panel' });
    var ctEq = el('button', 'sgw-on', { type: 'button', role: 'tab', 'aria-selected': 'true' });
    ctEq.textContent = 'Equations';
    var ctTable = el('button', '', { type: 'button', role: 'tab', 'aria-selected': 'false' });
    ctTable.textContent = 'Table';
    ctabs.appendChild(ctEq); ctabs.appendChild(ctTable);
    main.appendChild(gcol);
    main.appendChild(ctabs);
    main.appendChild(split);
    main.appendChild(side);
    root.appendChild(main);

    container.appendChild(root);
    var ctx = canvas.getContext('2d');

    /* ---------------- persistence ---------------- */
    function save() {
      if (!persist || destroyed) return;
      saveStore({
        v: 1,
        equations: eqs.map(function (L) { return { expr: L.expr, visible: L.visible, color: L.color }; }),
        view: presetKey === '11' ? '-11' : '01',
        step: step,
        sidebarWidth: sideW
      });
    }

    /* ---------------- equation rows ---------------- */
    function buildEqRow(L) {
      var row = el('div', 'sgw-eq', { 'data-id': String(L.id) });
      var sw = el('span', 'sgw-swatch');
      sw.style.background = L.color;
      var lab = el('span', 'sgw-ylab');
      lab.style.color = L.color;
      var inp = el('input', 'sgw-expr', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
      inp.value = L.expr;
      var cb = el('input', 'sgw-vis', { type: 'checkbox' });
      cb.checked = L.visible;
      cb.style.accentColor = L.color;
      cb.style.setProperty('--c', L.color);
      var rm = el('button', 'sgw-rm', { type: 'button' });
      rm.textContent = '✕';
      row.appendChild(sw); row.appendChild(lab); row.appendChild(inp); row.appendChild(cb); row.appendChild(rm);
      row.classList.toggle('sgw-hidden', !L.visible);
      L.rowEl = row; L.inputEl = inp; L.labEl = lab; L.cbEl = cb; L.rmEl = rm;
      applyLineError(L);
      return row;
    }

    function applyLineError(L) {
      if (!L.inputEl) return;
      var err = L.error || L.refError;
      L.inputEl.classList.toggle('sgw-invalid', !!err);
      L.inputEl.title = L.error ? L.error + (L.stale ? ' — showing last valid version' : '') :
        L.refError ? L.refError :
        'GLSL-like expression in x and t; use y1, y2, … to reuse other lines, e.g. step(y3, 1.0)';
    }

    /** Validate cross-references (missing / circular) and propagate t-usage through them. */
    function resolveRefs() {
      var n = eqs.length, state = new Array(n), path = [];
      eqs.forEach(function (L) { L.refError = null; L.usesTEff = !!(L.fn && L.usesT); });
      eqs.forEach(function (L) {
        for (var r = 0; r < L.refs.length; r++) {
          if (L.refs[r] >= n) { L.refError = 'y' + (L.refs[r] + 1) + " doesn't exist"; break; }
        }
      });
      function visit(i) {              // returns true if a cycle runs through i's dependencies
        if (state[i] === 2) return eqs[i].cyclic;
        if (state[i] === 1) {          // back edge -> cycle: mark everything on it
          var cyc = path.slice(path.indexOf(i)).concat(i);
          var msg = 'Circular reference: ' + cyc.map(function (k) { return 'y' + (k + 1); }).join(' → ');
          cyc.forEach(function (k) { if (!eqs[k].refError) eqs[k].refError = msg; eqs[k].cyclic = true; });
          return true;
        }
        state[i] = 1; path.push(i);
        var L = eqs[i], bad = false;
        for (var r = 0; r < L.refs.length; r++) {
          var k = L.refs[r];
          if (k >= n) continue;
          if (visit(k)) bad = true;
          if (eqs[k].usesTEff) L.usesTEff = true;
        }
        path.pop(); state[i] = 2;
        return bad || !!L.cyclic;
      }
      eqs.forEach(function (L) { L.cyclic = false; });
      for (var i = 0; i < n; i++) if (!state[i]) visit(i);
      eqs.forEach(function (L) {
        // depends on a broken line -> say which one
        if (!L.refError) {
          for (var r = 0; r < L.refs.length; r++) {
            var D = eqs[L.refs[r]];
            if (D && (D.refError || (!D.fn && !D.error))) {
              L.refError = D.refError ? 'Uses y' + (L.refs[r] + 1) + ', which has an error: ' + D.refError
                                      : 'Uses y' + (L.refs[r] + 1) + ', which is empty';
              break;
            }
          }
        }
        applyLineError(L);
      });
    }

    /** Rewrite yN references after equation #removed (0-based) is deleted: higher numbers shift
     *  down; references to the removed line are replaced by its expression in parentheses. */
    function shiftRefs(str, removed, inlineExpr) {
      return String(str).replace(/(^|[^A-Za-z0-9_.])y(\d{1,3})(?![A-Za-z0-9_])/g, function (m, pre, num) {
        var k = parseInt(num, 10) - 1;
        if (k < removed) return m;
        if (k > removed) return pre + 'y' + k;
        return pre + (inlineExpr != null ? '(' + inlineExpr + ')' : 'removed_y' + (k + 1));
      });
    }

    /** Labels y1..yN follow the list order; colours stay with their equation. */
    function renumber() {
      for (var i = 0; i < eqs.length; i++) {
        var L = eqs[i], n = 'y' + (i + 1);
        L.labEl.textContent = n + ' =';
        L.inputEl.setAttribute('aria-label', 'Expression ' + n);
        L.cbEl.title = 'Show ' + n;
        L.rmEl.title = 'Remove ' + n;
        L.rmEl.setAttribute('aria-label', 'Remove equation ' + n);
      }
      eqCount.textContent = String(eqs.length);
      eqCount.title = eqs.length + ' of max ' + MAX_EQS;
      eqHint.style.display = eqs.length ? 'none' : '';
      var full = eqs.length >= MAX_EQS;
      addBtn.disabled = full;
      addTop.disabled = full;
      addBtn.title = addTop.title = full ? 'Maximum of ' + MAX_EQS + ' equations' : 'Add equation';
    }

    function rebuildEqRows() {
      eqRows.textContent = '';
      for (var i = 0; i < eqs.length; i++) eqRows.appendChild(eqs[i].rowEl || buildEqRow(eqs[i]));
      renumber();
    }

    function eqFromEl(node) {
      var row = node && node.closest ? node.closest('.sgw-eq') : null;
      if (!row) return null;
      var id = parseInt(row.getAttribute('data-id'), 10);
      for (var i = 0; i < eqs.length; i++) if (eqs[i].id === id) return eqs[i];
      return null;
    }

    function revealInList(node) {
      var lr = list.getBoundingClientRect(), er = node.getBoundingClientRect();
      if (er.bottom > lr.bottom) list.scrollTop += er.bottom - lr.bottom + 2;
      else if (er.top < lr.top) list.scrollTop -= lr.top - er.top + 2;
    }

    function addEquation() {
      if (destroyed || eqs.length >= MAX_EQS) return null;
      var L = makeEq(nextExpr(), nextColor(), true);
      eqs.push(L);
      eqRows.appendChild(buildEqRow(L));
      resolveRefs();
      renumber();
      tableDirty = true;
      save();
      requestRender();
      focusQuiet(L.inputEl);
      revealInList(addBtn.disabled ? L.rowEl : addBtn);
      return L;
    }

    function removeEquation(L) {
      var i = eqs.indexOf(L);
      if (i < 0) return;
      var hadFocus = L.rowEl.contains(document.activeElement);
      eqs.splice(i, 1);
      if (L.rowEl.parentNode) L.rowEl.parentNode.removeChild(L.rowEl);
      var body = String(L.expr).replace(/^\s*y\d*\s*=(?!=)/, '').trim();
      var inline = body ? shiftRefs(body, i, null) : null;
      eqs.forEach(function (M) {
        var nx = shiftRefs(M.expr, i, inline);
        if (nx !== M.expr) { M.expr = nx; if (M.inputEl) M.inputEl.value = nx; recompileEq(M); }
      });
      resolveRefs();
      renumber();
      tableDirty = true;
      save();
      requestRender();
      if (hadFocus) {
        var nb = eqs[i] || eqs[i - 1];
        focusQuiet(nb ? nb.rmEl : addBtn);
      }
    }

    /* ---------------- probe UI ---------------- */
    function shortMsg(s) {
      s = String(s).replace(/\s+/g, ' ').trim();
      return s.length > 80 ? s.slice(0, 77) + '…' : s;
    }

    function buildProbeGroup(p) {
      var g = el('div', 'sgw-pgroup' + (p.error ? ' sgw-perr' : ''));
      var hd = el('div', 'sgw-phdr', {
        title: p.error ? p.error + (p.curve ? ' — showing last good values' : '') :
          p.label + (p.type ? ' (' + p.type + ')' : '') + ' — sampled from the shader'
      });
      var ex = el('span', 'sgw-pexpr');
      ex.textContent = p.label;
      hd.appendChild(ex);
      if (p.type) hd.appendChild(spanText('sgw-ptype', p.type));
      var rm = el('button', 'sgw-rm sgw-prm', {
        type: 'button', title: 'Remove from graph', 'aria-label': 'Remove ' + p.label + ' from graph', 'data-pid': p.id
      });
      rm.textContent = '✕';
      hd.appendChild(rm);
      g.appendChild(hd);

      if (p.error) {
        var msg = el('div', 'sgw-pmsg', { title: p.error });
        msg.textContent = shortMsg(p.error);
        g.appendChild(msg);
      }

      p.comps.forEach(function (c, i) {
        var lab = el('label', 'sgw-pcomp', { title: 'Show ' + c.label });
        var sw = el('span', 'sgw-swatch');
        sw.style.background = c.color;
        var nm = el('span', 'sgw-pname');
        nm.textContent = c.label;
        nm.style.color = c.color;
        var cb = el('input', 'sgw-vis', { type: 'checkbox', 'data-pid': p.id, 'data-ci': String(i) });
        cb.checked = p.vis[i];
        cb.style.accentColor = c.color;
        cb.style.setProperty('--c', c.color);
        lab.appendChild(sw); lab.appendChild(nm); lab.appendChild(cb);
        lab.appendChild(el('span', 'sgw-rmgap'));
        lab.classList.toggle('sgw-hidden', !p.vis[i]);
        g.appendChild(lab);
      });
      return g;
    }

    function rebuildProbeUI() {
      probeBody.textContent = '';
      probeSec.style.display = probes.length ? '' : 'none';
      for (var i = 0; i < probes.length; i++) probeBody.appendChild(buildProbeGroup(probes[i]));
    }

    /* ---------------- probe sampling ---------------- */
    function probeShown(p) {
      for (var i = 0; i < p.comps.length; i++) if (p.vis[i]) return true;
      return false;
    }
    function probeStale(p) { return !!p.error || !!p.failed; }

    /** Calls p.sample and copies the result into our own buffers (the caller may
     *  reuse its arrays). Returns Float32Array[] or null. `reuse` buffers are only
     *  overwritten once the whole result has been validated. */
    function runSample(p, xmin, xmax, n, reuse) {
      if (!p.sample || !p.comps.length) return null;
      var res;
      try { res = p.sample(xmin, xmax, n, rowY); } catch (e) { return null; }
      if (!res || !(res.length >= p.comps.length)) return null;
      var c, i;
      for (c = 0; c < p.comps.length; c++) if (!res[c] || !(res[c].length >= n)) return null;
      var out = [];
      for (c = 0; c < p.comps.length; c++) {
        var src = res[c];
        var buf = reuse && reuse[c] && reuse[c].length === n ? reuse[c] : new Float32Array(n);
        for (i = 0; i < n; i++) buf[i] = src[i];
        out.push(buf);
      }
      return out;
    }

    function sampleProbeCurves() {
      if (!probes.length) return;
      var W = canvas.width;
      if (!W) return;
      var n = Math.max(2, Math.min(2048, W));
      var key = view.xmin + '|' + view.xmax + '|' + n + '|' + rowY;
      for (var k = 0; k < probes.length; k++) {
        var p = probes[k];
        if (!probeShown(p)) continue;
        if (p.curveGen === probeGen && p.curveKey === key) continue;
        p.curveGen = probeGen; p.curveKey = key;
        var reuse = p.curve && p.curve.n === n ? p.curve.data : null;
        var d = runSample(p, view.xmin, view.xmax, n, reuse);
        if (d) p.curve = { xmin: view.xmin, xmax: view.xmax, n: n, data: d };
        p.failed = !d;  // keep the last good curve, drawn as stale
      }
    }

    function probeTablePending() {
      for (var k = 0; k < probes.length; k++) {
        var p = probes[k];
        if (probeShown(p) && p.tabGen !== probeGen) return true;
      }
      return false;
    }

    // trailing table refresh for throttled probe updates (no rAF loop)
    function scheduleTrailing() {
      if (trailTimer || destroyed) return;
      var wait = Math.max(0, 100 - (performance.now() - lastProbeTableAt)) + 4;
      trailTimer = setTimeout(function () { trailTimer = 0; requestRender(); }, wait);
    }

    function curveValueAt(cv, c, x) {
      if (!cv) return NaN;
      var d = cv.data[c], n = cv.n;
      if (!d) return NaN;
      var span = cv.xmax - cv.xmin;
      if (n < 2 || !(span !== 0)) return n >= 1 && Math.abs(x - cv.xmin) < 1e-12 ? d[0] : NaN;
      var f = (x - cv.xmin) / span * (n - 1);
      if (!(f >= -0.5 && f <= n - 0.5)) return NaN;
      var i0 = clampN(Math.floor(f), 0, n - 1), i1 = Math.min(n - 1, i0 + 1);
      var a = d[i0], b = d[i1], k = clampN(f - i0, 0, 1);
      if (isFinite(a) && isFinite(b)) return a + (b - a) * k;
      return d[clampN(Math.round(f), 0, n - 1)];
    }

    /** Value of probe component at the hover position (exact table value when
     *  hovering a table row, otherwise interpolated from the curve samples). */
    function probeValueAt(p, c, h) {
      if (h.src === 'table' && h.row != null && p.tab && p.tab.xkey === tableXKey) {
        var v = p.tab.data[c] ? p.tab.data[c][h.row] : NaN;
        if (v !== undefined) return v;
      }
      return curveValueAt(p.curve, c, h.x);
    }

    /* ---------------- helpers ---------------- */
    function currentT() {
      return playing ? clockBase + (performance.now() - clockStart) / 1000 : clockBase;
    }
    function activeLines() {
      var out = [];
      for (var i = 0; i < eqs.length; i++) if (eqs[i].visible) out.push(i);
      return out;
    }
    function anyUsesT() {
      for (var i = 0; i < eqs.length; i++) if (eqs[i].visible && eqs[i].fn && eqs[i].usesTEff) return true;
      return false;
    }
    var refDepth = 0;
    /** Y(k, x, t): value of equation k at (x, t) — what yN compiles to. */
    function evalRef(k, x, t) {
      var D = eqs[k];
      if (!D || !D.fn || D.cyclic || refDepth > 32) return NaN;
      refDepth++;
      try { var y = D.fn(x, t, evalRef); } catch (e) { y = NaN; } finally { refDepth--; }
      return typeof y === 'number' ? y : NaN;
    }
    function animating() { return playing && anyUsesT(); }
    function evalLine(L, x, t) {
      if (!L.fn || L.cyclic) return NaN;
      var y;
      refDepth = 0;
      try { y = L.fn(x, t, evalRef); } catch (e) { y = NaN; }
      return typeof y === 'number' ? y : NaN;
    }
    function updatePlayUI() {
      playBtn.textContent = playing ? '❚❚' : '▶';
      playBtn.title = (playing ? 'Pause' : 'Play') + ' t' + (anyUsesT() ? '' : ' (no visible equation uses t)');
      playBtn.classList.toggle('sgw-on', playing);
      gT.classList.toggle('sgw-idle', !anyUsesT());
    }
    function updateViewUI() {
      btn01.classList.toggle('sgw-on', presetKey === '01');
      btn11.classList.toggle('sgw-on', presetKey === '11');
      btn01.setAttribute('aria-pressed', String(presetKey === '01'));
      btn11.setAttribute('aria-pressed', String(presetKey === '11'));
    }
    function readTheme() {
      var cs = getComputedStyle(root);
      function v(name, fb) { var s = cs.getPropertyValue(name).trim(); return s || fb; }
      theme = {
        panel: v('--panel', '#161a21'),
        panel2: v('--panel-2', '#1d222b'),
        border: v('--border', '#2a313c'),
        text: v('--text', '#d7dce4'),
        dim: v('--text-dim', '#8a93a3'),
        mono: v('--mono', 'ui-monospace, monospace')
      };
    }

    /* ---------------- view + horizontal scrollbar ---------------- */
    function worldX(cx, w) { return view.xmin + (cx / w) * (view.xmax - view.xmin); }

    /** The single entry point for every view change (pan, zoom, reset, preset, scrollbar).
     *  Keeps the scrollbar, hover position, grid, curves and probe resampling in sync
     *  (probe curves resample on the next frame because their key includes the x range). */
    function setView(nv) {
      if (!(nv.xmax > nv.xmin) || !(nv.ymax > nv.ymin)) return;
      view = { xmin: nv.xmin, xmax: nv.xmax, ymin: nv.ymin, ymax: nv.ymax };
      if (hover && hover.src === 'canvas') {
        var w = canvas.clientWidth;
        if (w > 0) hover.x = worldX(hover.cx, w);
      }
      updateScrollbar();
      requestRender();
    }

    function scrollExtent() {
      var d = PRESETS[presetKey].domain, W = d[1] - d[0];
      return [Math.min(view.xmin, d[0] - SCROLL_PAD * W), Math.max(view.xmax, d[1] + SCROLL_PAD * W)];
    }

    function thumbGeom(ext) {
      var tw = hbar.clientWidth;
      var vw = view.xmax - view.xmin, ew = ext[1] - ext[0];
      var w = ew > 0 ? clampN(tw * vw / ew, Math.min(24, tw), tw) : tw;
      var room = tw - w, span = ew - vw;
      var left = room > 0 && span > 0 ? clampN((view.xmin - ext[0]) / span, 0, 1) * room : 0;
      return { tw: tw, w: w, left: left, room: room, span: span };
    }

    function updateScrollbar() {
      var g = thumbGeom(scrollExtent());
      thumb.style.width = g.w.toFixed(1) + 'px';
      thumb.style.left = g.left.toFixed(1) + 'px';
      hbar.setAttribute('aria-valuenow', String(g.room > 0 ? Math.round(g.left / g.room * 100) : 0));
    }

    /** Pan horizontally by d world units. clampToExtent: scrollbar-style movement
     *  that stops at the ends of the scroll extent. */
    function panX(d, clampToExtent) {
      var vw = view.xmax - view.xmin;
      var xmin = view.xmin + d;
      if (clampToExtent) {
        var ext = scrollExtent();
        xmin = clampN(xmin, ext[0], Math.max(ext[0], ext[1] - vw));
      }
      if (xmin === view.xmin) return;
      setView({ xmin: xmin, xmax: xmin + vw, ymin: view.ymin, ymax: view.ymax });
    }

    function wheelPx(e, v, pagePx) {
      return e.deltaMode === 1 ? v * 16 : e.deltaMode === 2 ? v * (pagePx || 400) : v;
    }

    /* ---------------- rendering ---------------- */
    function requestRender() {
      if (!frameId && !destroyed) frameId = requestAnimationFrame(frame);
    }
    function frame(now) {
      frameId = 0;
      if (destroyed) return;
      var t = currentT();
      var anim = animating();
      sampleProbeCurves();
      drawGraph(t);
      var probeTabDue = probes.length && probeTablePending() && now - lastProbeTableAt >= 100;
      if (tableDirty || probeTabDue || (anim && now - lastTableAt > 100)) {
        updateTable(t, now, tableDirty);
        lastTableAt = now;
        tableDirty = false;
      }
      updateReadout(t);
      updatePlayUI();
      tLabel.textContent = 't=' + t.toFixed(2);
      if (anim) frameId = requestAnimationFrame(frame);
      else if (probes.length && probeTablePending()) scheduleTrailing();
    }

    function gridSteps(range, px, base) {
      var upp = range / Math.max(1, px);
      var minor = base;
      while (minor / upp < 14) minor = nextNice(minor);
      var m = mantissa(minor);
      var major = minor * (m === 5 ? 2 : 5);
      return { minor: minor, major: major, upp: upp };
    }
    function labelStep(g, minPx) {
      var cands = [g.minor, g.major, g.major * 2, g.major * 5, g.major * 10, g.major * 20, g.major * 50];
      for (var i = 0; i < cands.length; i++) if (cands[i] / g.upp >= minPx) return cands[i];
      return cands[cands.length - 1];
    }

    function drawGraph(t) {
      var W = canvas.width, H = canvas.height;
      if (!W || !H) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.fillStyle = theme.panel;
      ctx.fillRect(0, 0, W, H);

      var xr = view.xmax - view.xmin, yr = view.ymax - view.ymin;
      var sx = function (x) { return (x - view.xmin) / xr * W; };
      var sy = function (y) { return H - (y - view.ymin) / yr * H; };
      var cssW = W / dpr, cssH = H / dpr;

      var base = niceCeil(Math.max(xr / cssW, yr / cssH) * 24);
      var gx = gridSteps(xr, cssW, base);
      var gy = gridSteps(yr, cssH, base);

      var lw = Math.max(1, Math.floor(dpr));
      var off = (lw % 2) / 2;

      // shade outside the preset domain very slightly
      var dom = PRESETS[presetKey].domain;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      var d0 = sx(dom[0]), d1 = sx(dom[1]);
      if (d0 > 0) ctx.fillRect(0, 0, Math.min(W, d0), H);
      if (d1 < W) ctx.fillRect(Math.max(0, d1), 0, W - Math.max(0, d1), H);

      function vLines(g, isMajor) {
        var k0 = Math.ceil(view.xmin / g.minor), k1 = Math.floor(view.xmax / g.minor);
        if (k1 - k0 > 4000) return;
        for (var k = k0; k <= k1; k++) {
          var v = k * g.minor;
          var maj = Math.abs(Math.round(v / g.major) * g.major - v) < g.minor * 1e-3;
          if (maj !== isMajor || Math.abs(v) < g.minor * 1e-6) continue;
          var px = Math.round(sx(v)) + off;
          ctx.moveTo(px, 0); ctx.lineTo(px, H);
        }
      }
      function hLines(g, isMajor) {
        var k0 = Math.ceil(view.ymin / g.minor), k1 = Math.floor(view.ymax / g.minor);
        if (k1 - k0 > 4000) return;
        for (var k = k0; k <= k1; k++) {
          var v = k * g.minor;
          var maj = Math.abs(Math.round(v / g.major) * g.major - v) < g.minor * 1e-3;
          if (maj !== isMajor || Math.abs(v) < g.minor * 1e-6) continue;
          var py = Math.round(sy(v)) + off;
          ctx.moveTo(0, py); ctx.lineTo(W, py);
        }
      }
      ctx.lineWidth = lw;
      // minor
      ctx.strokeStyle = theme.border;
      ctx.globalAlpha = 0.45;
      ctx.beginPath(); vLines(gx, false); hLines(gy, false); ctx.stroke();
      // major
      ctx.globalAlpha = 1;
      ctx.beginPath(); vLines(gx, true); hLines(gy, true); ctx.stroke();
      // axes
      ctx.strokeStyle = theme.dim;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      var ax = sx(0), ay = sy(0);
      if (ax >= 0 && ax <= W) { var pax = Math.round(ax) + off; ctx.moveTo(pax, 0); ctx.lineTo(pax, H); }
      if (ay >= 0 && ay <= H) { var pay = Math.round(ay) + off; ctx.moveTo(0, pay); ctx.lineTo(W, pay); }
      ctx.stroke();
      ctx.globalAlpha = 1;

      drawLabels(W, H, sx, sy, gx, gy);

      // curves
      var act = activeLines();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (var a = 0; a < act.length; a++) {
        var L = eqs[act[a]];
        if (!L.fn) continue;
        ctx.strokeStyle = L.color;
        ctx.lineWidth = 2 * dpr;
        if (L.stale) { ctx.globalAlpha = 0.45; ctx.setLineDash([5 * dpr, 4 * dpr]); }
        else { ctx.globalAlpha = 1; ctx.setLineDash([]); }
        ctx.beginPath();
        var pen = false, prev = 0;
        for (var i = 0; i <= W; i++) {
          var x = view.xmin + (i / W) * xr;
          var y = evalLine(L, x, t);
          if (!isFinite(y)) { pen = false; continue; }
          var py = sy(y);
          if (py < -4 * H) py = -4 * H; else if (py > 5 * H) py = 5 * H;
          if (pen && Math.abs(py - prev) > 2 * H) pen = false; // asymptotes (tan, 1/x)
          if (!pen) { ctx.moveTo(i, py); pen = true; } else ctx.lineTo(i, py);
          prev = py;
        }
        ctx.stroke();
      }

      // shader probe curves, on top of the expression lines
      for (var pk = 0; pk < probes.length; pk++) {
        var P = probes[pk], cv = P.curve;
        if (!cv) continue;
        var pstale = probeStale(P);
        var pdx = cv.n > 1 ? (cv.xmax - cv.xmin) / (cv.n - 1) : 0;
        for (var pc = 0; pc < P.comps.length; pc++) {
          if (!P.vis[pc] || !cv.data[pc]) continue;
          var pd = cv.data[pc];
          ctx.strokeStyle = P.comps[pc].color;
          ctx.lineWidth = 2 * dpr;
          if (pstale) { ctx.globalAlpha = 0.45; ctx.setLineDash([5 * dpr, 4 * dpr]); }
          else { ctx.globalAlpha = 1; ctx.setLineDash([]); }
          ctx.beginPath();
          var ppen = false, pprev = 0;
          for (var pi = 0; pi < cv.n; pi++) {
            var pv = pd[pi];
            if (!isFinite(pv)) { ppen = false; continue; }
            var ppx = sx(cv.xmin + pi * pdx);
            var ppy = sy(pv);
            if (ppy < -4 * H) ppy = -4 * H; else if (ppy > 5 * H) ppy = 5 * H;
            if (ppen && Math.abs(ppy - pprev) > 2 * H) ppen = false;
            if (!ppen) { ctx.moveTo(ppx, ppy); ppen = true; } else ctx.lineTo(ppx, ppy);
            pprev = ppy;
          }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);

      // hover guide
      if (hover) {
        var hx = sx(hover.x);
        if (hx >= -2 && hx <= W + 2) {
          ctx.strokeStyle = theme.text;
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = lw;
          ctx.setLineDash([4 * dpr, 4 * dpr]);
          ctx.beginPath();
          ctx.moveTo(Math.round(hx) + off, 0); ctx.lineTo(Math.round(hx) + off, H);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          var dot = function (yv, color) {
            if (!isFinite(yv)) return;
            var pyy = sy(yv);
            if (pyy < -10 || pyy > H + 10) return;
            ctx.beginPath();
            ctx.arc(hx, pyy, 4 * dpr, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.lineWidth = 1.5 * dpr;
            ctx.strokeStyle = theme.panel;
            ctx.stroke();
          };
          for (var b = 0; b < act.length; b++) {
            var L2 = eqs[act[b]];
            dot(evalLine(L2, hover.x, t), L2.color);
          }
          for (var hk = 0; hk < probes.length; hk++) {
            var HP = probes[hk];
            for (var hc = 0; hc < HP.comps.length; hc++) {
              if (HP.vis[hc]) dot(probeValueAt(HP, hc, hover), HP.comps[hc].color);
            }
          }
        }
      }
    }

    function drawLabels(W, H, sx, sy, gx, gy) {
      var fs = Math.round(10 * dpr);
      ctx.font = fs + 'px ' + theme.mono;
      ctx.lineWidth = 3 * dpr;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = theme.panel;
      ctx.fillStyle = theme.dim;
      var pad = 4 * dpr;

      // x labels, along y=0 (clamped to the canvas)
      var lx = labelStep(gx, 46);
      var dx = stepDecimals(lx);
      var ay = sy(0);
      var ty = clampN(ay + pad, pad, H - fs - pad);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      var k0 = Math.ceil(view.xmin / lx), k1 = Math.floor(view.xmax / lx);
      if (k1 - k0 < 400) {
        for (var k = k0; k <= k1; k++) {
          var v = k * lx;
          if (k === 0) continue;
          var px = sx(v);
          var s = fmtLabel(v, dx);
          var w = ctx.measureText(s).width;
          if (px - w / 2 < 2 || px + w / 2 > W - 2) continue;
          ctx.strokeText(s, px, ty);
          ctx.fillText(s, px, ty);
        }
      }

      // y labels, along x=0 (clamped)
      var ly = labelStep(gy, 26);
      var dy = stepDecimals(ly);
      var j0 = Math.ceil(view.ymin / ly), j1 = Math.floor(view.ymax / ly);
      if (j1 - j0 < 400) {
        var labs = [], maxW = 0;
        for (var j = j0; j <= j1; j++) {
          if (j === 0) continue;
          var vy = j * ly;
          var sL = fmtLabel(vy, dy);
          var wL = ctx.measureText(sL).width;
          if (wL > maxW) maxW = wL;
          labs.push([sL, sy(vy)]);
        }
        var ax = sx(0);
        var rightSide;
        var tx;
        if (ax > W) { rightSide = false; tx = W - pad; }
        else if (ax - pad - maxW >= 2) { rightSide = false; tx = ax - pad; }
        else { rightSide = true; tx = Math.max(ax, 0) + pad; }
        ctx.textAlign = rightSide ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        for (var q = 0; q < labs.length; q++) {
          var py = labs[q][1];
          if (py < fs / 2 + 2 || py > H - fs / 2 - 2) continue;
          ctx.strokeText(labs[q][0], tx, py);
          ctx.fillText(labs[q][0], tx, py);
        }
      }

      // origin
      var ox = sx(0), oy = sy(0);
      if (ox >= 0 && ox <= W && oy >= 0 && oy <= H) {
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        var ox2 = ox - pad < ctx.measureText('0').width + 2 ? ox + pad + ctx.measureText('0').width : ox - pad;
        var oy2 = Math.min(oy + pad, H - fs - pad);
        ctx.strokeText('0', ox2, oy2);
        ctx.fillText('0', ox2, oy2);
      }
    }

    /* ---------------- table ---------------- */
    function computeRowsX() {
      var dom = PRESETS[presetKey].domain;
      var dec = decimalsOf(step);
      var n = Math.floor((dom[1] - dom[0]) / step + 1e-9) + 1;
      n = Math.max(1, Math.min(MAX_ROWS, n));
      var xs = [];
      for (var i = 0; i < n; i++) xs.push(+(dom[0] + i * step).toFixed(dec));
      return { xs: xs, dec: dec };
    }

    function probeCols() {
      var cols = [];
      for (var k = 0; k < probes.length; k++) {
        var p = probes[k];
        for (var c = 0; c < p.comps.length; c++) if (p.vis[c]) cols.push({ p: p, c: c });
      }
      return cols;
    }

    function sampleProbeTable(now, force) {
      var rows = tableRowsX.length;
      if (!rows || !probes.length) return;
      var tmin = tableRowsX[0];
      var tmax = tmin + (rows - 1) * step;
      var key = tableXKey + '|' + rowY;
      var due = force || now - lastProbeTableAt >= 100;
      var did = false;
      for (var k = 0; k < probes.length; k++) {
        var p = probes[k];
        if (!probeShown(p)) continue;
        // a changed grid / rowY is resampled right away; plain invalidations are throttled
        if (p.tabKey === key && (p.tabGen === probeGen || !due)) continue;
        p.tabKey = key; p.tabGen = probeGen;
        did = true;
        var reuse = p.tab && p.tab.xkey === tableXKey ? p.tab.data : null;
        var d = runSample(p, tmin, tmax, rows, reuse);
        if (d) p.tab = { xkey: tableXKey, data: d };
        p.tabFailed = !d;
      }
      if (did) lastProbeTableAt = now;
    }

    function eqHeadTitle(L) {
      return L.expr + (L.stale ? '  (has an error — last valid version shown)' : '');
    }

    function updateTable(t, now, force) {
      var act = activeLines();
      var pcols = probeCols();
      var rx = computeRowsX();
      var sig = presetKey + '|' + step + '|' +
        act.map(function (i) {
          var L = eqs[i];
          return L.id + ':' + i + ':' + L.color + ':' + (L.stale ? 's' : (L.fn ? 'f' : 'n'));
        }).join(',') + '|' +
        pcols.map(function (pc) {
          var cc = pc.p.comps[pc.c];
          return pc.p.id + '\u0001' + pc.c + '\u0001' + cc.label + '\u0001' + cc.color + '\u0001' + (pc.p.error ? 'e' : '');
        }).join('\u0002');
      if (sig !== tableSig) {
        tableSig = sig;
        tableRowsX = rx.xs;
        hlRowEl = null;
        // header
        thead.textContent = '';
        tableHeads = [];
        var hr = el('tr');
        var thx = el('th', 'sgw-thx');
        thx.textContent = 'x';
        hr.appendChild(thx);
        for (var a = 0; a < act.length; a++) {
          var L = eqs[act[a]];
          var th = el('th');
          th.textContent = 'y' + (act[a] + 1);
          th.style.color = L.color;
          th.style.boxShadow = 'inset 0 -2px 0 ' + L.color;
          th.title = eqHeadTitle(L);
          if (L.stale) th.classList.add('sgw-stale');
          hr.appendChild(th);
          tableHeads.push(th);
        }
        for (var pa = 0; pa < pcols.length; pa++) {
          var PC = pcols[pa], comp = PC.p.comps[PC.c];
          var pth = el('th', 'sgw-pth');
          pth.textContent = comp.label;
          pth.style.color = comp.color;
          pth.style.boxShadow = 'inset 0 -2px 0 ' + comp.color;
          pth.title = comp.label + ' — shader value' + (PC.p.type ? ' (' + PC.p.label + ': ' + PC.p.type + ')' : '') +
            (PC.p.error ? '\n' + PC.p.error + ' — last good values shown' : '');
          if (PC.p.error) pth.classList.add('sgw-stale');
          hr.appendChild(pth);
        }
        thead.appendChild(hr);
        // body
        var frag = document.createDocumentFragment();
        tableCells = [];
        for (var r = 0; r < rx.xs.length; r++) {
          var tr = el('tr');
          tr.setAttribute('data-i', String(r));
          var tdx = el('td', 'sgw-tdx');
          tdx.textContent = rx.xs[r].toFixed(rx.dec);
          tr.appendChild(tdx);
          var cells = [];
          for (var a2 = 0; a2 < act.length; a2++) {
            var td = el('td');
            if (eqs[act[a2]].stale) td.className = 'sgw-stale';
            tr.appendChild(td);
            cells.push(td);
          }
          for (var pb = 0; pb < pcols.length; pb++) {
            var ptd = el('td', pcols[pb].p.error ? 'sgw-stale' : '');
            tr.appendChild(ptd);
            cells.push(ptd);
          }
          tableCells.push(cells);
          frag.appendChild(tr);
        }
        tbody.textContent = '';
        tbody.appendChild(frag);
      } else {
        for (var h = 0; h < act.length && h < tableHeads.length; h++) {
          var ht = eqHeadTitle(eqs[act[h]]);
          if (tableHeads[h].title !== ht) tableHeads[h].title = ht;
        }
      }
      tableXKey = tableRowsX.length ? tableRowsX[0] + '|' + step + '|' + tableRowsX.length : '';
      if (pcols.length) sampleProbeTable(now, force);
      for (var rr = 0; rr < tableRowsX.length; rr++) {
        var x = tableRowsX[rr];
        var row = tableCells[rr];
        for (var c = 0; c < act.length; c++) {
          var s = fmtVal(evalLine(eqs[act[c]], x, t));
          if (row[c].textContent !== s) row[c].textContent = s;
        }
        for (var q = 0; q < pcols.length; q++) {
          var tp = pcols[q].p;
          var tv = tp.tab && tp.tab.xkey === tableXKey && tp.tab.data[pcols[q].c] ? tp.tab.data[pcols[q].c][rr] : NaN;
          var ts = fmtVal(tv);
          var cell = row[act.length + q];
          if (cell.textContent !== ts) cell.textContent = ts;
        }
      }
      syncTableHighlight();
    }

    function syncTableHighlight() {
      var target = null;
      if (hover && hover.src === 'canvas' && tableRowsX.length) {
        var x0 = tableRowsX[0];
        var idx = Math.round((hover.x - x0) / step);
        if (idx >= 0 && idx < tableRowsX.length && Math.abs(tableRowsX[idx] - hover.x) <= step / 2 + 1e-12) {
          target = tbody.children[idx] || null;
        }
      }
      if (target !== hlRowEl) {
        if (hlRowEl) hlRowEl.classList.remove('sgw-row-hl');
        if (target) target.classList.add('sgw-row-hl');
        hlRowEl = target;
      }
    }

    /* ---------------- readout ---------------- */
    function updateReadout(t) {
      if (!hover || hover.src !== 'canvas') { readout.style.display = 'none'; return; }
      var act = activeLines();
      var frag = document.createDocumentFragment();
      function roLine(cls, color, text) {
        var d = el('div', cls);
        if (color) d.style.color = color;
        d.textContent = text;
        frag.appendChild(d);
      }
      roLine('sgw-ro-x', '', 'x = ' + fmtVal(hover.x));
      for (var a = 0; a < act.length; a++) {
        var L = eqs[act[a]];
        roLine('', L.color, 'y' + (act[a] + 1) + ' = ' + fmtVal(evalLine(L, hover.x, t)));
      }
      for (var k = 0; k < probes.length; k++) {
        var P = probes[k];
        for (var c = 0; c < P.comps.length; c++) {
          if (!P.vis[c]) continue;
          roLine(probeStale(P) ? 'sgw-ro-stale' : '', P.comps[c].color,
            P.comps[c].label + ' = ' + fmtVal(probeValueAt(P, c, hover)));
        }
      }
      readout.textContent = '';
      readout.appendChild(frag);
      readout.style.display = 'block';
      var pw = plot.clientWidth, ph = plot.clientHeight;
      var rw = readout.offsetWidth, rh = readout.offsetHeight;
      var left = hover.cx + 14, top = hover.cy + 14;
      if (left + rw > pw - 4) left = hover.cx - rw - 14;
      if (top + rh > ph - 4) top = hover.cy - rh - 14;
      if (compact) { left = hover.cx > pw / 2 ? 8 : pw - rw - 8; top = 8; }  // keep clear of the finger
      readout.style.left = Math.max(4, left) + 'px';
      readout.style.top = Math.max(4, top) + 'px';
    }

    /* ---------------- sizing ---------------- */
    function sideMax(mainW) { return Math.max(SIDE_MIN, Math.floor(mainW * SIDE_MAX_FRAC)); }
    function applySideWidth() {
      if (compact || root.classList.contains('sgw-narrow')) { side.style.width = ''; return; }
      var mw = main.clientWidth;
      if (!mw) return;
      var w = sideW == null ? clampN(Math.round(mw * 0.4), SIDE_MIN, SIDE_DEFAULT) : sideW;
      w = clampN(w, SIDE_MIN, sideMax(mw));
      side.style.width = w + 'px';
      split.setAttribute('aria-valuenow', String(w));
    }

    function resize() {
      if (destroyed) return;
      root.classList.toggle('sgw-narrow', !compact && root.clientWidth > 0 && root.clientWidth < NARROW_PX);
      applySideWidth();
      readTheme();
      dpr = window.devicePixelRatio || 1;
      var w = plot.clientWidth, h = plot.clientHeight;
      var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      updateScrollbar();
      // draw synchronously so a resize never shows a blank canvas
      if (frameId) { cancelAnimationFrame(frameId); frameId = 0; }
      frame(performance.now());
    }

    /* ---------------- events ---------------- */
    var listeners = [];
    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      listeners.push([target, type, fn, opts]);
    }

    function recompileEq(L) {
      var c = compileExpr(L.expr);
      if (c.ok) {
        L.fn = c.fn; L.usesT = c.usesT; L.refs = c.refs; L.error = null; L.stale = false;
      } else {
        // keep the last valid function (and its refs), drawn dashed/dim, until fixed
        L.error = c.error; L.stale = !!L.fn;
      }
      applyLineError(L);
    }

    // equations (delegated)
    on(eqRows, 'input', function (e) {
      var inp = e.target;
      if (!inp.classList || !inp.classList.contains('sgw-expr')) return;
      var L = eqFromEl(inp);
      if (!L) return;
      L.expr = inp.value;
      recompileEq(L);
      resolveRefs();
      tableDirty = true;
      save();
      requestRender();
    });
    on(eqRows, 'change', function (e) {
      var cb = e.target;
      if (!cb.classList || !cb.classList.contains('sgw-vis')) return;
      var L = eqFromEl(cb);
      if (!L) return;
      L.visible = cb.checked;
      L.rowEl.classList.toggle('sgw-hidden', !L.visible);
      tableDirty = true;
      save();
      requestRender();
    });
    on(eqRows, 'click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.sgw-rm') : null;
      if (!b) return;
      var L = eqFromEl(b);
      if (L) removeEquation(L);
    });
    on(addBtn, 'click', function () { addEquation(); });
    on(addTop, 'click', function () { addEquation(); });

    // shader values (delegated)
    on(probeBody, 'click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.sgw-prm') : null;
      if (!b) return;
      if (typeof options.onRemoveProbe === 'function') options.onRemoveProbe(b.getAttribute('data-pid'));
    });
    on(probeBody, 'change', function (e) {
      var cb = e.target;
      if (!cb.classList || !cb.classList.contains('sgw-vis')) return;
      var pid = cb.getAttribute('data-pid'), ci = parseInt(cb.getAttribute('data-ci'), 10);
      if (has(probeVis, pid)) probeVis[pid][ci] = cb.checked;
      var lab = cb.closest('.sgw-pcomp');
      if (lab) lab.classList.toggle('sgw-hidden', !cb.checked);
      tableDirty = true;
      requestRender();
    });

    // toolbar
    function setPreset(k) {
      presetKey = k;
      updateViewUI();
      tableDirty = true;
      save();
      setView(PRESETS[k].view);
    }
    function resetView() { setPreset(presetKey); }
    on(btn01, 'click', function () { setPreset('01'); });
    on(btn11, 'click', function () { setPreset('11'); });
    on(resetBtn, 'click', resetView);

    on(stepInput, 'input', function () {
      var v = parseFloat(stepInput.value);
      var ok = isFinite(v) && v >= 0.001;
      stepInput.classList.toggle('sgw-invalid', !ok);
      stepInput.title = ok ? 'Table x interval (min 0.001)' : 'Step must be a number ≥ 0.001';
      if (!ok) return;
      step = v;
      tableDirty = true;
      save();
      requestRender();
    });
    on(stepInput, 'change', function () {
      stepInput.classList.remove('sgw-invalid');
      stepInput.value = String(step);
    });

    on(rowYInput, 'input', function () {
      var v = parseFloat(rowYInput.value);
      var ok = isFinite(v) && v >= 0 && v <= 1;
      rowYInput.classList.toggle('sgw-invalid', !ok);
      rowYInput.title = ok ? ROWY_TIP : 'row y must be between 0 and 1';
      if (!ok || v === rowY) return;
      rowY = v;
      tableDirty = true;
      requestRender();
    });
    on(rowYInput, 'change', function () {
      rowYInput.classList.remove('sgw-invalid');
      rowYInput.title = ROWY_TIP;
      rowYInput.value = String(rowY);
    });

    on(playBtn, 'click', function () {
      if (playing) { clockBase = currentT(); playing = false; }
      else { clockStart = performance.now(); playing = true; }
      tableDirty = true;
      requestRender();
    });
    on(tLabel, 'click', function () {
      clockBase = 0; clockStart = performance.now();
      tableDirty = true;
      requestRender();
    });

    var compact = false, compactPanel = 'list';
    function setCompactPanel(k) {
      compactPanel = k === 'table' ? 'table' : 'list';
      side.classList.toggle('sgw-show-table', compactPanel === 'table');
      ctEq.classList.toggle('sgw-on', compactPanel === 'list');
      ctTable.classList.toggle('sgw-on', compactPanel === 'table');
      ctEq.setAttribute('aria-selected', String(compactPanel === 'list'));
      ctTable.setAttribute('aria-selected', String(compactPanel === 'table'));
      if (compactPanel === 'table') tableDirty = true;
      requestRender();
    }
    on(ctEq, 'click', function () { setCompactPanel('list'); });
    on(ctTable, 'click', function () { setCompactPanel('table'); });
    function setCompact(v) {
      v = !!v;
      if (v === compact) return;
      compact = v;
      root.classList.toggle('sgw-compact', compact);
      // Step only affects the table: on phones it lives above the table as "Interval"
      var stepLbl = gStep.querySelector('.sgw-lbl');
      if (compact) { tableBar.appendChild(gStep); if (stepLbl) stepLbl.textContent = 'Interval'; }
      else { toolbar.insertBefore(gStep, gT); if (stepLbl) stepLbl.textContent = 'Step'; }
      setHelp(false);
      if (!compact) side.classList.remove('sgw-show-table');
      else setCompactPanel(compactPanel);
      resize();
    }

    function setHelp(open) {
      helpPop.hidden = !open;
      helpBtn.classList.toggle('sgw-on', open);
      helpBtn.setAttribute('aria-expanded', String(open));
    }
    on(helpBtn, 'click', function () { setHelp(helpPop.hidden); });
    on(helpPop, 'click', function () { setHelp(false); });

    // canvas: hover, drag-pan, wheel, keyboard
    function canvasPoint(e) {
      var r = canvas.getBoundingClientRect();
      return { cx: e.clientX - r.left, cy: e.clientY - r.top, w: r.width, h: r.height };
    }

    /* ---- touch: one-finger pan, pinch zoom, double-tap reset, touch-and-hold scrub ---- */
    var touches = {};          // pointerId -> { cx, cy }
    var tstate = null;         // { mode: 'pending' | 'pan' | 'scrub' | 'pinch', ... }
    var holdTimer = 0, lastTap = 0, lastTapX = 0, lastTapY = 0;
    function touchCount() { return Object.keys(touches).length; }
    function setHoverAt(cx, cy) {
      var r = canvas.getBoundingClientRect();
      hover = { x: worldX(cx, r.width), src: 'canvas', cx: cx, cy: cy };
      syncTableHighlight();
      requestRender();
    }
    function startPinch() {
      var ids = Object.keys(touches), a = touches[ids[0]], b = touches[ids[1]];
      var r = canvas.getBoundingClientRect();
      var mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
      tstate = {
        mode: 'pinch', w: r.width, h: r.height,
        d0: Math.max(12, Math.hypot(a.cx - b.cx, a.cy - b.cy)),
        v0: { xmin: view.xmin, xmax: view.xmax, ymin: view.ymin, ymax: view.ymax },
        wx: worldX(mx, r.width), wy: view.ymax - (my / r.height) * (view.ymax - view.ymin)
      };
      if (hover) { hover = null; syncTableHighlight(); }
      plot.classList.remove('sgw-scrubbing');
    }
    function touchDown(e) {
      var p = canvasPoint(e);
      touches[e.pointerId] = { cx: p.cx, cy: p.cy };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
      clearTimeout(holdTimer);
      var n = touchCount();
      if (n === 1) {
        tstate = { mode: 'pending', id: e.pointerId, sx: p.cx, sy: p.cy, lx: p.cx, ly: p.cy };
        holdTimer = setTimeout(function () {
          if (tstate && tstate.mode === 'pending') {
            tstate.mode = 'scrub';
            plot.classList.add('sgw-scrubbing');
            setHoverAt(tstate.lx, tstate.ly);
          }
        }, 380);
      } else if (n === 2) {
        startPinch();
      }
    }
    function touchMove(e) {
      if (!touches[e.pointerId]) return;
      var p = canvasPoint(e);
      touches[e.pointerId] = { cx: p.cx, cy: p.cy };
      if (!tstate) return;
      if (tstate.mode === 'pinch') {
        var ids = Object.keys(touches);
        if (ids.length < 2) return;
        var a = touches[ids[0]], b = touches[ids[1]];
        var d = Math.max(12, Math.hypot(a.cx - b.cx, a.cy - b.cy));
        var mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
        var f = tstate.d0 / d, v0 = tstate.v0;
        var xr = clampN((v0.xmax - v0.xmin) * f, 1e-6, 1e6), yr = clampN((v0.ymax - v0.ymin) * f, 1e-6, 1e6);
        var xmin = tstate.wx - (mx / tstate.w) * xr;
        var ymax = tstate.wy + (my / tstate.h) * yr;
        setView({ xmin: xmin, xmax: xmin + xr, ymin: ymax - yr, ymax: ymax });
        return;
      }
      if (e.pointerId !== tstate.id) return;
      if (tstate.mode === 'scrub') { tstate.lx = p.cx; tstate.ly = p.cy; setHoverAt(p.cx, p.cy); return; }
      if (tstate.mode === 'pending') {
        if (Math.hypot(p.cx - tstate.sx, p.cy - tstate.sy) < 8) { tstate.lx = p.cx; tstate.ly = p.cy; return; }
        tstate.mode = 'pan';
        clearTimeout(holdTimer);
        plot.classList.add('sgw-dragging');
      }
      if (p.w > 0 && p.h > 0) {
        var dxw = (p.cx - tstate.lx) / p.w * (view.xmax - view.xmin);
        var dyw = (p.cy - tstate.ly) / p.h * (view.ymax - view.ymin);
        setView({ xmin: view.xmin - dxw, xmax: view.xmax - dxw, ymin: view.ymin + dyw, ymax: view.ymax + dyw });
      }
      tstate.lx = p.cx; tstate.ly = p.cy;
    }
    function touchUp(e) {
      if (!touches[e.pointerId]) return;
      delete touches[e.pointerId];
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      clearTimeout(holdTimer);
      var n = touchCount();
      if (n === 1 && tstate && tstate.mode === 'pinch') {   // keep panning with the remaining finger
        var id = Object.keys(touches)[0], q = touches[id];
        tstate = { mode: 'pan', id: +id, sx: q.cx, sy: q.cy, lx: q.cx, ly: q.cy };
        return;
      }
      if (n > 0) return;
      if (tstate && tstate.mode === 'pending' && e.type === 'pointerup') {   // a tap
        var now = performance.now(), p = canvasPoint(e);
        if (now - lastTap < 320 && Math.hypot(p.cx - lastTapX, p.cy - lastTapY) < 30) { resetView(); lastTap = 0; }
        else { lastTap = now; lastTapX = p.cx; lastTapY = p.cy; }
      }
      if (tstate && tstate.mode === 'scrub') { hover = null; syncTableHighlight(); requestRender(); }
      plot.classList.remove('sgw-scrubbing', 'sgw-dragging');
      tstate = null;
    }

    on(canvas, 'pointermove', function (e) {
      if (e.pointerType === 'touch') { touchMove(e); return; }
      var p = canvasPoint(e);
      hover = { x: worldX(p.cx, p.w), src: 'canvas', cx: p.cx, cy: p.cy };
      if (drag && p.w > 0 && p.h > 0) {
        var dxw = (p.cx - drag.cx) / p.w * (view.xmax - view.xmin);
        var dyw = (p.cy - drag.cy) / p.h * (view.ymax - view.ymin);
        drag.cx = p.cx; drag.cy = p.cy;
        setView({ xmin: view.xmin - dxw, xmax: view.xmax - dxw, ymin: view.ymin + dyw, ymax: view.ymax + dyw });
      }
      if (!animating()) syncTableHighlight();
      requestRender();
    });
    on(canvas, 'pointerleave', function (e) {
      if (drag || e.pointerType === 'touch') return;
      if (hover && hover.src === 'canvas') { hover = null; syncTableHighlight(); requestRender(); }
    });
    on(canvas, 'pointerdown', function (e) {
      if (e.pointerType === 'touch') { touchDown(e); return; }
      if (e.button !== 0) return;
      var p = canvasPoint(e);
      drag = { cx: p.cx, cy: p.cy, id: e.pointerId };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      plot.classList.add('sgw-dragging');
      focusQuiet(canvas);
      e.preventDefault();
    });
    function endDrag(e) {
      if (e && e.pointerType === 'touch') { touchUp(e); return; }
      if (!drag) return;
      try { canvas.releasePointerCapture(drag.id); } catch (err) { /* ignore */ }
      drag = null;
      plot.classList.remove('sgw-dragging');
      if (e && e.type === 'pointercancel') { hover = null; requestRender(); }
    }
    on(canvas, 'pointerup', endDrag);
    on(canvas, 'pointercancel', endDrag);
    on(canvas, 'dblclick', function (e) { if (e.pointerType !== 'touch') resetView(); });

    on(canvas, 'wheel', function (e) {
      e.preventDefault();  // never scroll / zoom the page
      var p = canvasPoint(e);
      if (!(p.w > 0) || !(p.h > 0)) return;
      var dx = wheelPx(e, e.deltaX, p.w), dy = wheelPx(e, e.deltaY, p.h);
      hover = { x: worldX(p.cx, p.w), src: 'canvas', cx: p.cx, cy: p.cy };
      if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        // horizontal scroll (Shift+wheel, tilt wheel, trackpad swipe)
        var d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        if (d) panX(d / p.w * (view.xmax - view.xmin), false);
        else requestRender();
        return;
      }
      if (!dy) return;
      var f = Math.exp(clampN(dy, -300, 300) * 0.0015);
      var zx = e.ctrlKey || !e.altKey;   // Ctrl: x only
      var zy = e.altKey || !e.ctrlKey;   // Alt: y only
      var nv = { xmin: view.xmin, xmax: view.xmax, ymin: view.ymin, ymax: view.ymax };
      var wx = worldX(p.cx, p.w);
      var wy = view.ymax - (p.cy / p.h) * (view.ymax - view.ymin);
      var nxr = (view.xmax - view.xmin) * f, nyr = (view.ymax - view.ymin) * f;
      if (zx && nxr > 1e-6 && nxr < 1e6) {
        nv.xmin = wx - (wx - view.xmin) * f;
        nv.xmax = nv.xmin + nxr;
      }
      if (zy && nyr > 1e-6 && nyr < 1e6) {
        nv.ymin = wy - (wy - view.ymin) * f;
        nv.ymax = nv.ymin + nyr;
      }
      setView(nv);
    }, { passive: false });

    on(canvas, 'keydown', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      var vw = view.xmax - view.xmin;
      if (e.key === 'ArrowLeft') panX(-0.1 * vw, false);
      else if (e.key === 'ArrowRight') panX(0.1 * vw, false);
      else if (e.key === 'Home') resetView();
      else return;
      e.preventDefault();
    });

    // horizontal scrollbar
    on(hbar, 'pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var ext = scrollExtent(), g = thumbGeom(ext);
      if (e.target === thumb) {
        // the extent is frozen for the drag so the thumb tracks the pointer 1:1
        sbDrag = { x: e.clientX, xmin: view.xmin, ext: ext, room: g.room, span: g.span, id: e.pointerId };
        try { hbar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        hbar.classList.add('sgw-active');
      } else {
        var px = e.clientX - hbar.getBoundingClientRect().left;
        var dir = px < g.left ? -1 : px > g.left + g.w ? 1 : 0;
        if (dir) panX(dir * 0.9 * (view.xmax - view.xmin), true);
      }
    });
    on(hbar, 'pointermove', function (e) {
      if (!sbDrag || !(sbDrag.room > 0) || !(sbDrag.span > 0)) return;
      var vw = view.xmax - view.xmin;
      var xmin = sbDrag.xmin + (e.clientX - sbDrag.x) / sbDrag.room * sbDrag.span;
      xmin = clampN(xmin, sbDrag.ext[0], Math.max(sbDrag.ext[0], sbDrag.ext[1] - vw));
      setView({ xmin: xmin, xmax: xmin + vw, ymin: view.ymin, ymax: view.ymax });
    });
    function endSbDrag() {
      if (!sbDrag) return;
      try { hbar.releasePointerCapture(sbDrag.id); } catch (err) { /* ignore */ }
      sbDrag = null;
      hbar.classList.remove('sgw-active');
    }
    on(hbar, 'pointerup', endSbDrag);
    on(hbar, 'pointercancel', endSbDrag);
    on(hbar, 'lostpointercapture', endSbDrag);
    on(hbar, 'wheel', function (e) {
      e.preventDefault();
      var w = canvas.clientWidth || hbar.clientWidth;
      if (!(w > 0)) return;
      var dx = wheelPx(e, e.deltaX, w), dy = wheelPx(e, e.deltaY, w);
      var d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      if (d) panX(d / w * (view.xmax - view.xmin), true);
    }, { passive: false });

    // sidebar splitter
    on(split, 'pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      splitDrag = { x: e.clientX, w: side.getBoundingClientRect().width, id: e.pointerId };
      try { split.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      split.classList.add('sgw-active');
      root.classList.add('sgw-resizing');
    });
    on(split, 'pointermove', function (e) {
      if (!splitDrag) return;
      var w = Math.round(splitDrag.w - (e.clientX - splitDrag.x));
      w = clampN(w, SIDE_MIN, sideMax(main.clientWidth));
      if (w === sideW) return;
      sideW = w;
      resize();
    });
    function endSplit() {
      if (!splitDrag) return;
      try { split.releasePointerCapture(splitDrag.id); } catch (err) { /* ignore */ }
      splitDrag = null;
      split.classList.remove('sgw-active');
      root.classList.remove('sgw-resizing');
      save();
    }
    on(split, 'pointerup', endSplit);
    on(split, 'pointercancel', endSplit);
    on(split, 'lostpointercapture', endSplit);
    on(split, 'dblclick', function () { sideW = null; resize(); save(); });
    on(split, 'keydown', function (e) {
      var d = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
      if (!d) return;
      e.preventDefault();
      sideW = clampN(side.getBoundingClientRect().width + d, SIDE_MIN, sideMax(main.clientWidth));
      resize();
      save();
    });

    // table rows -> hover guide on the graph
    on(tbody, 'mouseover', function (e) {
      var tr = e.target && e.target.closest ? e.target.closest('tr') : null;
      if (!tr || !tbody.contains(tr)) return;
      var i = parseInt(tr.getAttribute('data-i'), 10);
      if (!isFinite(i) || tableRowsX[i] === undefined) return;
      hover = { x: tableRowsX[i], src: 'table', row: i };
      if (hlRowEl) { hlRowEl.classList.remove('sgw-row-hl'); hlRowEl = null; }
      requestRender();
    });
    on(tbody, 'mouseleave', function () {
      if (hover && hover.src === 'table') { hover = null; requestRender(); }
    });

    var ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function () { resize(); });
      ro.observe(root);
      ro.observe(plot);
    } else {
      on(window, 'resize', resize);
    }

    /* ---------------- init ---------------- */
    rebuildEqRows();
    resolveRefs();
    updateViewUI();
    updatePlayUI();
    resize();

    function setProbes(list) {
      if (destroyed) return;
      list = Array.isArray(list) ? list : [];
      var old = {};
      for (var k = 0; k < probes.length; k++) old[probes[k].id] = probes[k];
      var next = [], seen = {};
      for (var j = 0; j < list.length; j++) {
        var q = list[j];
        if (!q || q.id == null) continue;
        var id = String(q.id);
        if (has(seen, id)) continue;
        seen[id] = true;
        var label = q.label != null ? String(q.label) : id;
        var srcComps = Array.isArray(q.components) ? q.components.slice(0, 4) : [];
        var comps = srcComps.map(function (c, i) {
          return {
            label: c && c.label != null ? String(c.label) : label + '[' + i + ']',
            color: c && c.color ? String(c.color) : PALETTE[i % PALETTE.length]
          };
        });
        var vis = has(probeVis, id) ? probeVis[id] : (probeVis[id] = []);
        for (var ci = 0; ci < comps.length; ci++) if (typeof vis[ci] !== 'boolean') vis[ci] = true;
        var prev = has(old, id) ? old[id] : null;
        var keep = prev && prev.comps.length === comps.length;
        next.push({
          id: id,
          label: label,
          type: q.type != null ? String(q.type) : '',
          comps: comps,
          vis: vis,
          sample: typeof q.sample === 'function' ? q.sample : null,
          error: q.error ? String(q.error) : '',
          // last good data survives (drawn as stale while `error` is set)
          curve: keep ? prev.curve : null,
          curveKey: '', curveGen: -1, failed: keep ? prev.failed : false,
          tab: keep ? prev.tab : null,
          tabKey: '', tabGen: -1, tabFailed: false
        });
      }
      probes = next;
      probeGen++;
      tableDirty = true;
      var sig = probes.map(function (p) {
        return [p.id, p.label, p.type, p.error, p.comps.map(function (c) { return c.label + '\u0003' + c.color; }).join('\u0004')].join('\u0001');
      }).join('\u0002');
      if (sig !== probeSig) {
        probeSig = sig;
        rebuildProbeUI();
        resize(); // draws synchronously
      } else {
        requestRender();
      }
    }

    return {
      resize: resize,
      setCompact: setCompact,
      setProbes: setProbes,
      /** read-only copy of the current view rectangle (debug/test helper) */
      getView: function () { return { xmin: view.xmin, xmax: view.xmax, ymin: view.ymin, ymax: view.ymax }; },
      invalidate: function () {
        if (destroyed || !probes.length) return;
        probeGen++;
        requestRender();
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (frameId) cancelAnimationFrame(frameId);
        frameId = 0;
        if (trailTimer) clearTimeout(trailTimer);
        trailTimer = 0;
        drag = sbDrag = splitDrag = null;
        probes = [];
        if (ro) ro.disconnect();
        for (var i = 0; i < listeners.length; i++) {
          var l = listeners[i];
          l[0].removeEventListener(l[1], l[2], l[3]);
        }
        listeners.length = 0;
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  };
})(window.ShaderSandbox);
