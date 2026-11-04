/* ShaderSandbox — on-screen code keyboard for phones (replaces the OS keyboard).
 *
 * Pure data + logic at load time (no DOM), so Node tests can load it in a vm.
 * The DOM is only touched inside createCodeKeyboard().
 *
 * NS.codeKeyboard = {
 *   TABS     [{ id, label }]                 abc | fn | maths
 *   LAYOUTS  { abc: Row[], fn: Row[], maths: Row[] }   4 rows each; Row = Key[]
 *            Key = { id, label, aria?, w?, and exactly one of text | wrap: [before, after] | action }
 *            action: 'shift' | 'backspace' | 'enter' | 'left' | 'right'
 *   initialState()                 -> { tab: 'abc', shift: 'off', lastShiftAt: -Infinity }
 *   setTab(state, tabId)           -> new state (shift 'off'); unknown tab -> state unchanged
 *   resolveKey(key, state, now)    -> { state, op }   (never mutates `state`)
 *            op: null | {type:'insert', text} | {type:'wrap', before, after}
 *              | {type:'backspace'} | {type:'enter'} | {type:'move', delta: -1|1}
 *   createCodeKeyboard(container, { onOp }) -> { el, setTab(id), getState(), destroy() }
 * }
 */
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) {
  'use strict';

  var DOUBLE_TAP_MS = 350;   // shift tapped twice within this -> caps lock
  var REPEAT_DELAY_MS = 400; // auto-repeat: first repeat
  var REPEAT_EVERY_MS = 60;  //              then every

  var TABS = [
    { id: 'abc', label: 'ABC' },
    { id: 'fn', label: 'ƒ(x)' },
    { id: 'maths', label: '123 π' }
  ];

  // ------------------------------------------------------------------ key builders
  function txt(label, text, id, aria, w) {
    var k = { id: id || label, label: label, text: text === undefined ? label : text };
    if (aria) k.aria = aria;
    if (w) k.w = w;
    return k;
  }
  function fn(name, w) {
    var k = { id: name, label: name, wrap: [name + '(', ')'] };
    if (w) k.w = w;
    return k;
  }
  function act(action, label, aria, w) {
    var k = { id: action, label: label, aria: aria, action: action };
    if (w) k.w = w;
    return k;
  }
  function texts(str) { return str.split(' ').map(function (c) { return txt(c); }); }
  function fns(str) { return str.split(' ').map(function (n) { return fn(n); }); }

  function SHIFT() { return act('shift', '⇧', 'Shift', 1.5); }
  function BKSP(w) { return act('backspace', '⌫', 'Delete', w); }
  function LEFT() { return act('left', '←', 'Move left'); }
  function RIGHT() { return act('right', '→', 'Move right'); }
  function ENTER(w) { return act('enter', '⏎', 'Return', w); }
  function SPACE(w) { return txt('space', ' ', 'space', 'Space', w); }

  var LAYOUTS = {
    abc: [
      texts('q w e r t y u i o p'),
      texts('a s d f g h j k l'),
      [SHIFT()].concat(texts('z x c v b n m'), [BKSP(1.5)]),
      [LEFT(), txt('_', '_', 'underscore'), SPACE(4), txt('.', '.', 'dot'), RIGHT(), ENTER(1.5)]
    ],
    fn: [
      fns('sin cos tan atan pow sqrt'),
      [fn('smoothstep', 2)].concat(fns('mix step clamp fract')),
      fns('abs mod floor min max length').concat([BKSP()]),
      [LEFT()].concat(fns('vec2 vec3 vec4'), [SPACE(2), RIGHT(), ENTER()])
    ],
    maths: [
      texts('1 2 3 4 5 6 7 8 9 0'),
      texts('+ - * / = < > ( ) ,'),
      [txt('π', '3.14159265', 'pi', 'pi'), txt('τ', '6.28318531', 'tau', 'tau')]
        .concat(texts('0.5 1.0 2.0 .x .y .xy .rgb'), [BKSP()]),
      [LEFT(), txt('u_time', undefined, undefined, undefined, 1.5), txt('st'), SPACE(3), RIGHT(), ENTER()]
    ]
  };

  // Shared, read-only data: consumers must not be able to edit a layout in place.
  function deepFreeze(o) {
    Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]); });
    return Object.freeze(o);
  }
  deepFreeze(TABS);
  deepFreeze(LAYOUTS);

  // ------------------------------------------------------------------ pure logic
  function isLetterKey(key) { return typeof key.text === 'string' && /^[a-z]$/.test(key.text); }
  function hasTab(id) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return true;
    return false;
  }
  function copyState(s) { return { tab: s.tab, shift: s.shift, lastShiftAt: s.lastShiftAt }; }

  function initialState() { return { tab: 'abc', shift: 'off', lastShiftAt: -Infinity }; }

  function setTab(state, tabId) {
    if (!hasTab(tabId)) return state;
    var s = copyState(state);
    s.tab = tabId;
    s.shift = 'off';
    return s;
  }

  function resolveKey(key, state, now) {
    var s = copyState(state);
    if (key.action) {
      switch (key.action) {
        case 'shift':
          if (s.shift === 'off') { s.shift = 'once'; s.lastShiftAt = now; }
          else if (s.shift === 'once') s.shift = (now - s.lastShiftAt < DOUBLE_TAP_MS) ? 'lock' : 'off';
          else s.shift = 'off';
          return { state: s, op: null };
        case 'backspace': return { state: s, op: { type: 'backspace' } };
        case 'enter': return { state: s, op: { type: 'enter' } };
        case 'left': return { state: s, op: { type: 'move', delta: -1 } };
        case 'right': return { state: s, op: { type: 'move', delta: 1 } };
      }
      return { state: s, op: null };
    }
    if (key.wrap) return { state: s, op: { type: 'wrap', before: key.wrap[0], after: key.wrap[1] } };
    if (typeof key.text === 'string') {
      var text = key.text;
      if (isLetterKey(key) && s.shift !== 'off') {
        text = text.toUpperCase();
        if (s.shift === 'once') s.shift = 'off';
      }
      return { state: s, op: { type: 'insert', text: text } };
    }
    return { state: s, op: null };
  }

  // ------------------------------------------------------------------ DOM factory
  function isRepeatable(key) {
    return key.action === 'backspace' || key.action === 'left' || key.action === 'right';
  }

  function createCodeKeyboard(container, opts) {
    opts = opts || {};
    var doc = (container && container.ownerDocument) || window.document;
    var onOp = typeof opts.onOp === 'function' ? opts.onOp : function () {};
    var clock = typeof opts.now === 'function' ? opts.now : function () {
      return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    };
    var state = initialState();
    var repeats = {};    // pointerId -> { btn, timeout, interval } (one per finger)
    var keyButtons = []; // [{ btn, key }] for the current layout
    var tabButtons = []; // [{ btn, id }]
    var destroyed = false;
    var lastDownBtn = null; // key whose pointerdown already fired (its trailing click is ignored)
    var api;

    function mk(tag, cls, attrs) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (attrs) for (var a in attrs) if (attrs.hasOwnProperty(a)) n.setAttribute(a, attrs[a]);
      return n;
    }
    function prevent(e) { e.preventDefault(); }
    function pointerKey(e) { return e.pointerId === undefined ? 'mouse' : String(e.pointerId); }

    var root = mk('div', 'ckb', { role: 'group', 'aria-label': 'Code keyboard' });
    var tabsEl = mk('div', 'ckb-tabs', { role: 'tablist' });
    var keysEl = mk('div', 'ckb-keys');
    root.appendChild(tabsEl);
    root.appendChild(keysEl);
    // Never let a tap on the keyboard move focus away from the editor textarea.
    root.addEventListener('pointerdown', prevent);
    root.addEventListener('mousedown', prevent);
    root.addEventListener('contextmenu', prevent); // long-press must not open a menu

    TABS.forEach(function (t) {
      var b = mk('button', 'ckb-tab', {
        type: 'button', role: 'tab', tabindex: '-1', 'data-tab': t.id, 'aria-selected': 'false'
      });
      b.textContent = t.label;
      b.addEventListener('click', function (e) { e.preventDefault(); api.setTab(t.id); });
      tabsEl.appendChild(b);
      tabButtons.push({ btn: b, id: t.id });
    });

    function emit(key) {
      if (destroyed) return;
      var r = resolveKey(key, state, clock());
      var shiftChanged = r.state.shift !== state.shift;
      state = r.state;
      if (shiftChanged) refreshShift();
      if (r.op) onOp(r.op);
    }

    function stopRepeat(id) {
      var r = repeats[id];
      if (!r) return;
      clearTimeout(r.timeout);
      clearInterval(r.interval);
      r.btn.classList.remove('is-pressed');
      delete repeats[id];
    }
    function stopAllRepeats() { Object.keys(repeats).forEach(stopRepeat); }

    function onKeyDown(btn, key, e) {
      // Mouse/pen: primary button only. Touch: every finger types (button is 0 for each).
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      var id = pointerKey(e);
      stopRepeat(id);
      var rec = { btn: btn, timeout: null, interval: null };
      repeats[id] = rec;
      btn.classList.add('is-pressed');
      emit(key);
      if (isRepeatable(key)) {
        rec.timeout = setTimeout(function () {
          emit(key);
          rec.interval = setInterval(function () { emit(key); }, REPEAT_EVERY_MS);
        }, REPEAT_DELAY_MS);
      }
    }
    function onKeyUp(e) { stopRepeat(pointerKey(e)); }

    function keyClass(key) {
      var c = 'ckb-key';
      if (isLetterKey(key)) c += ' ckb-key-letter';
      if (key.wrap) c += ' ckb-key-fn';
      if (key.action) c += ' ckb-key-special';
      if (key.text === ' ') c += ' ckb-key-space';
      else if (typeof key.text === 'string' && key.label.length > 2) c += ' ckb-key-word'; // u_time, .rgb, 0.5 ...
      return c;
    }

    function renderKeys() {
      stopAllRepeats();
      keyButtons = [];
      while (keysEl.firstChild) keysEl.removeChild(keysEl.firstChild);
      LAYOUTS[state.tab].forEach(function (row) {
        var rowEl = mk('div', 'ckb-row');
        row.forEach(function (key) {
          var attrs = { type: 'button', tabindex: '-1', 'data-id': key.id };
          if (key.aria) attrs['aria-label'] = key.aria;
          var b = mk('button', keyClass(key), attrs);
          b.style.flexGrow = String(key.w || 1);
          b.textContent = key.label;
          b.addEventListener('pointerdown', function (e) { lastDownBtn = b; onKeyDown(b, key, e); });
          // VoiceOver / Switch Control activate buttons with a bare click (no pointerdown first).
          b.addEventListener('click', function (e) {
            e.preventDefault();
            if (lastDownBtn === b) { lastDownBtn = null; return; }
            emit(key);
          });
          b.addEventListener('pointerup', onKeyUp);
          b.addEventListener('pointercancel', onKeyUp);
          b.addEventListener('pointerleave', onKeyUp);
          rowEl.appendChild(b);
          keyButtons.push({ btn: b, key: key });
        });
        keysEl.appendChild(rowEl);
      });
      refreshShift();
      tabButtons.forEach(function (t) {
        var on = t.id === state.tab;
        t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
        t.btn.classList.toggle('is-active', on);
      });
    }

    function refreshShift() {
      var upper = state.shift !== 'off';
      keyButtons.forEach(function (kb) {
        if (isLetterKey(kb.key)) kb.btn.textContent = upper ? kb.key.label.toUpperCase() : kb.key.label;
        if (kb.key.action === 'shift') {
          kb.btn.classList.toggle('is-shift-once', state.shift === 'once');
          kb.btn.classList.toggle('is-shift-lock', state.shift === 'lock');
          kb.btn.setAttribute('aria-pressed', upper ? 'true' : 'false');
        }
      });
    }

    api = {
      el: root,
      setTab: function (id) {
        if (destroyed) return;
        var next = setTab(state, id);
        if (next === state) return;
        state = next;
        renderKeys();
      },
      getState: function () { return copyState(state); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        stopAllRepeats();
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };

    renderKeys();
    if (container) container.appendChild(root);
    return api;
  }

  NS.codeKeyboard = {
    TABS: TABS,
    LAYOUTS: LAYOUTS,
    initialState: initialState,
    setTab: setTab,
    resolveKey: resolveKey,
    createCodeKeyboard: createCodeKeyboard
  };
})(window.ShaderSandbox);
