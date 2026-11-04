'use strict';
// Node tests for js/code-keyboard.js (on-screen code keyboard: layouts + key logic).
// Run: node --test tests/code-keyboard.test.js   (no deps; Node >= 18)

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var ROOT = path.join(__dirname, '..');
var CKB_PATH = path.join(ROOT, 'js', 'code-keyboard.js');

function freshContext() {
  // No `document`: the module must only touch the DOM inside createCodeKeyboard().
  var ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(CKB_PATH, 'utf8'), ctx, { filename: 'js/code-keyboard.js' });
  return ctx;
}

var K = freshContext().window.ShaderSandbox.codeKeyboard;
// Iterate the expected tabs (not K.TABS) so an empty TABS can't make layout tests pass vacuously.
var TAB_IDS = [{ id: 'abc' }, { id: 'fn' }, { id: 'maths' }];

// vm-realm objects fail deepStrictEqual prototype checks; normalise first.
function plain(x) { return JSON.parse(JSON.stringify(x)); }
function deepFreeze(o) {
  Object.keys(o).forEach(function (k) {
    if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]);
  });
  return Object.freeze(o);
}
function allKeys(tab) {
  return K.LAYOUTS[tab].reduce(function (acc, row) { return acc.concat(row); }, []);
}
function key(tab, id) {
  var k = allKeys(tab).filter(function (x) { return x.id === id; })[0];
  assert.ok(k, 'missing key ' + tab + '/' + id);
  return k;
}
function keyByLabel(tab, label) {
  var k = allKeys(tab).filter(function (x) { return x.label === label; })[0];
  assert.ok(k, 'missing key labelled ' + tab + '/' + label);
  return k;
}
function rowLabels(tab, i) { return K.LAYOUTS[tab][i].map(function (k) { return k.label; }); }
function st(shift, lastShiftAt) {
  return { tab: 'abc', shift: shift, lastShiftAt: lastShiftAt === undefined ? -Infinity : lastShiftAt };
}
// state without lastShiftAt (-Infinity does not survive JSON)
function shiftOf(r) { return r.state.shift; }

// ------------------------------------------------------------------ module shape
test('module loads in vm without document and exposes the API', function () {
  assert.equal(typeof K, 'object');
  ['initialState', 'setTab', 'resolveKey', 'createCodeKeyboard'].forEach(function (f) {
    assert.equal(typeof K[f], 'function', f);
  });
});

test('TABS are abc, fn, maths with the agreed labels', function () {
  assert.deepEqual(plain(K.TABS), [
    { id: 'abc', label: 'ABC' }, { id: 'fn', label: 'ƒ(x)' }, { id: 'maths', label: '123 π' }
  ]);
});

test('initialState is abc / shift off / lastShiftAt -Infinity', function () {
  var s = K.initialState();
  assert.equal(s.tab, 'abc');
  assert.equal(s.shift, 'off');
  assert.equal(s.lastShiftAt, -Infinity);
  assert.notEqual(K.initialState(), s, 'fresh object each call');
});

// ------------------------------------------------------------------ layouts
test('every layout exists and has exactly 4 rows', function () {
  TAB_IDS.forEach(function (t) {
    assert.ok(Array.isArray(K.LAYOUTS[t.id]), t.id);
    assert.equal(K.LAYOUTS[t.id].length, 4, t.id);
    K.LAYOUTS[t.id].forEach(function (row) { assert.ok(row.length > 0); });
  });
});

test('each key has id + label and exactly one of text / wrap / action', function () {
  var ACTIONS = ['shift', 'backspace', 'enter', 'left', 'right'];
  TAB_IDS.forEach(function (t) {
    allKeys(t.id).forEach(function (k) {
      var where = t.id + '/' + k.id;
      assert.equal(typeof k.id, 'string', where);
      assert.ok(k.id.length > 0, where);
      assert.equal(typeof k.label, 'string', where);
      assert.ok(k.label.length > 0, where);
      var n = ['text', 'wrap', 'action'].filter(function (p) { return k[p] !== undefined; }).length;
      assert.equal(n, 1, where + ' must have exactly one of text/wrap/action');
      if (k.text !== undefined) assert.equal(typeof k.text, 'string', where);
      if (k.wrap !== undefined) {
        assert.equal(k.wrap.length, 2, where);
        assert.equal(typeof k.wrap[0], 'string', where);
        assert.equal(typeof k.wrap[1], 'string', where);
      }
      if (k.action !== undefined) assert.ok(ACTIONS.indexOf(k.action) >= 0, where);
      if (k.w !== undefined) assert.ok(typeof k.w === 'number' && k.w > 0, where);
    });
  });
});

test('key ids are unique within each layout', function () {
  TAB_IDS.forEach(function (t) {
    var ids = allKeys(t.id).map(function (k) { return k.id; });
    var seen = {};
    ids.forEach(function (id) {
      assert.ok(!seen[id], t.id + ' duplicate id ' + id);
      seen[id] = true;
    });
  });
});

test('abc layout is QWERTY with the agreed special keys', function () {
  assert.deepEqual(plain(rowLabels('abc', 0)), 'q w e r t y u i o p'.split(' '));
  assert.deepEqual(plain(rowLabels('abc', 1)), 'a s d f g h j k l'.split(' '));
  assert.deepEqual(plain(rowLabels('abc', 2)), '⇧ z x c v b n m ⌫'.split(' '));
  assert.deepEqual(plain(rowLabels('abc', 3)), ['←', '_', 'space', '.', '→', '⏎']);
  var row3 = K.LAYOUTS.abc[2], row4 = K.LAYOUTS.abc[3];
  assert.equal(row3[0].action, 'shift'); assert.equal(row3[0].w, 1.5);
  assert.equal(row3[8].action, 'backspace'); assert.equal(row3[8].w, 1.5);
  assert.equal(row4[0].action, 'left');
  assert.equal(row4[1].text, '_');
  assert.equal(row4[2].text, ' '); assert.equal(row4[2].w, 4);
  assert.equal(row4[3].text, '.');
  assert.equal(row4[4].action, 'right');
  assert.equal(row4[5].action, 'enter'); assert.equal(row4[5].w, 1.5);
  allKeys('abc').forEach(function (k) {
    if (/^[a-z]$/.test(k.label)) assert.equal(k.text, k.label, 'letter ' + k.label);
  });
});

test('fn layout rows; sin cos tan smoothstep (and every fn key) are name( ) wraps', function () {
  assert.deepEqual(plain(rowLabels('fn', 0)), 'sin cos tan atan pow sqrt'.split(' '));
  assert.deepEqual(plain(rowLabels('fn', 1)), 'smoothstep mix step clamp fract'.split(' '));
  assert.deepEqual(plain(rowLabels('fn', 2)), 'abs mod floor min max length ⌫'.split(' '));
  assert.deepEqual(plain(rowLabels('fn', 3)), '← vec2 vec3 vec4 space → ⏎'.split(' '));
  ['sin', 'cos', 'tan', 'smoothstep'].forEach(function (n) {
    assert.deepEqual(plain(keyByLabel('fn', n).wrap), [n + '(', ')'], n);
  });
  assert.equal(keyByLabel('fn', 'smoothstep').w, 2);
  assert.equal(keyByLabel('fn', 'space').w, 2);
  allKeys('fn').forEach(function (k) {
    if (/^[a-z][a-z0-9]*$/.test(k.label) && k.label !== 'space') {
      assert.deepEqual(plain(k.wrap), [k.label + '(', ')'], k.label);
    }
  });
});

test('maths layout rows and constants', function () {
  assert.deepEqual(plain(rowLabels('maths', 0)), '1 2 3 4 5 6 7 8 9 0'.split(' '));
  assert.deepEqual(plain(rowLabels('maths', 1)), '+ - * / = < > ( ) ,'.split(' '));
  assert.deepEqual(plain(rowLabels('maths', 2)), 'π τ 0.5 1.0 2.0 .x .y .xy .rgb ⌫'.split(' '));
  assert.deepEqual(plain(rowLabels('maths', 3)), '← u_time st space → ⏎'.split(' '));
  assert.equal(keyByLabel('maths', 'π').text, '3.14159265');
  assert.equal(keyByLabel('maths', 'π').aria, 'pi');
  assert.equal(keyByLabel('maths', 'τ').text, '6.28318531');
  assert.equal(keyByLabel('maths', 'τ').aria, 'tau');
  assert.equal(keyByLabel('maths', 'space').w, 3);
  allKeys('maths').forEach(function (k) {
    if (k.text !== undefined && ['π', 'τ', 'space'].indexOf(k.label) < 0) {
      assert.equal(k.text, k.label, 'label equals text for ' + k.label);
    }
  });
});

test('special keys carry aria labels', function () {
  var want = { shift: 'Shift', backspace: 'Delete', enter: 'Return', left: 'Move left', right: 'Move right' };
  TAB_IDS.forEach(function (t) {
    allKeys(t.id).forEach(function (k) {
      if (k.action) assert.equal(k.aria, want[k.action], t.id + '/' + k.id);
      if (k.text === ' ') assert.equal(k.aria, 'Space', t.id + '/' + k.id);
    });
  });
});

// ------------------------------------------------------------------ resolveKey: letters + shift
test('letter inserts lowercase when shift is off', function () {
  var r = K.resolveKey(key('abc', 'a'), st('off'), 0);
  assert.deepEqual(plain(r.op), { type: 'insert', text: 'a' });
  assert.equal(shiftOf(r), 'off');
});

test('shift once uppercases one letter, then returns to off', function () {
  var r = K.resolveKey(key('abc', 'q'), st('once', 10), 1000);
  assert.deepEqual(plain(r.op), { type: 'insert', text: 'Q' });
  assert.equal(shiftOf(r), 'off');
});

test('shift lock uppercases and persists', function () {
  var s = st('lock', 10);
  var r1 = K.resolveKey(key('abc', 'z'), s, 1000);
  var r2 = K.resolveKey(key('abc', 'm'), r1.state, 1100);
  assert.deepEqual(plain(r1.op), { type: 'insert', text: 'Z' });
  assert.deepEqual(plain(r2.op), { type: 'insert', text: 'M' });
  assert.equal(shiftOf(r2), 'lock');
});

test('shift key: off -> once records lastShiftAt, op null', function () {
  var r = K.resolveKey(key('abc', 'shift'), st('off'), 5000);
  assert.equal(r.op, null);
  assert.equal(r.state.shift, 'once');
  assert.equal(r.state.lastShiftAt, 5000);
});

test('shift double-tap within 350 ms locks (349 ms)', function () {
  var r = K.resolveKey(key('abc', 'shift'), st('once', 1000), 1349);
  assert.equal(r.op, null);
  assert.equal(r.state.shift, 'lock');
});

test('shift second tap after 350 ms turns off (351 ms)', function () {
  var r = K.resolveKey(key('abc', 'shift'), st('once', 1000), 1351);
  assert.equal(r.op, null);
  assert.equal(r.state.shift, 'off');
});

test('shift key: lock -> off', function () {
  var r = K.resolveKey(key('abc', 'shift'), st('lock', 1000), 1100);
  assert.equal(r.op, null);
  assert.equal(r.state.shift, 'off');
});

test('non-letter text keys ignore shift and do not consume once', function () {
  var s = { tab: 'maths', shift: 'once', lastShiftAt: 10 };
  var r = K.resolveKey(key('maths', '7'), s, 1000);
  assert.deepEqual(plain(r.op), { type: 'insert', text: '7' });
  assert.equal(r.state.shift, 'once');
  var r2 = K.resolveKey(keyByLabel('abc', '_'), st('once', 10), 1000);
  assert.deepEqual(plain(r2.op), { type: 'insert', text: '_' });
  assert.equal(r2.state.shift, 'once');
  var r3 = K.resolveKey(keyByLabel('maths', '.xy'), st('lock', 10), 1000);
  assert.deepEqual(plain(r3.op), { type: 'insert', text: '.xy' }, 'multi-letter text never uppercased');
});

test('π inserts 3.14159265', function () {
  var r = K.resolveKey(keyByLabel('maths', 'π'), K.initialState(), 0);
  assert.deepEqual(plain(r.op), { type: 'insert', text: '3.14159265' });
});

// ------------------------------------------------------------------ resolveKey: other ops
test('wrap key yields {type:wrap, before, after}', function () {
  var r = K.resolveKey(keyByLabel('fn', 'smoothstep'), K.initialState(), 0);
  assert.deepEqual(plain(r.op), { type: 'wrap', before: 'smoothstep(', after: ')' });
  var v = K.resolveKey(keyByLabel('fn', 'vec3'), K.initialState(), 0);
  assert.deepEqual(plain(v.op), { type: 'wrap', before: 'vec3(', after: ')' });
});

test('wrap keys ignore shift and do not consume once', function () {
  var r = K.resolveKey(keyByLabel('fn', 'sin'), { tab: 'fn', shift: 'once', lastShiftAt: 1 }, 100);
  assert.deepEqual(plain(r.op), { type: 'wrap', before: 'sin(', after: ')' });
  assert.equal(r.state.shift, 'once');
});

test('backspace and enter produce their ops', function () {
  assert.deepEqual(plain(K.resolveKey(key('abc', 'backspace'), K.initialState(), 0).op), { type: 'backspace' });
  assert.deepEqual(plain(K.resolveKey(key('abc', 'enter'), K.initialState(), 0).op), { type: 'enter' });
});

test('left / right produce move -1 / +1', function () {
  assert.deepEqual(plain(K.resolveKey(key('abc', 'left'), K.initialState(), 0).op), { type: 'move', delta: -1 });
  assert.deepEqual(plain(K.resolveKey(key('abc', 'right'), K.initialState(), 0).op), { type: 'move', delta: 1 });
});

test('space inserts a single space', function () {
  assert.deepEqual(plain(K.resolveKey(keyByLabel('abc', 'space'), K.initialState(), 0).op), { type: 'insert', text: ' ' });
});

test('resolveKey never mutates the (deep-frozen) input state', function () {
  var cases = [
    [key('abc', 'shift'), 'off'], [key('abc', 'shift'), 'once'], [key('abc', 'shift'), 'lock'],
    [key('abc', 'a'), 'once'], [key('abc', 'a'), 'lock'], [key('abc', 'backspace'), 'once'],
    [keyByLabel('fn', 'mix'), 'once'], [key('abc', 'left'), 'off']
  ];
  cases.forEach(function (c) {
    var s = deepFreeze({ tab: 'abc', shift: c[1], lastShiftAt: 1000 });
    var r;
    assert.doesNotThrow(function () { r = K.resolveKey(c[0], s, 1100); }, c[0].id + '/' + c[1]);
    assert.deepEqual(plain(s), { tab: 'abc', shift: c[1], lastShiftAt: 1000 });
    assert.notEqual(r.state, s, 'returns a new state object');
  });
});

// ------------------------------------------------------------------ setTab
test('setTab switches tab and resets shift to off', function () {
  var s = deepFreeze({ tab: 'abc', shift: 'lock', lastShiftAt: 1000 });
  var n = K.setTab(s, 'fn');
  assert.equal(n.tab, 'fn');
  assert.equal(n.shift, 'off');
  assert.notEqual(n, s);
  assert.equal(s.tab, 'abc');
  assert.equal(s.shift, 'lock');
});

test('setTab ignores unknown tab ids', function () {
  var s = { tab: 'maths', shift: 'once', lastShiftAt: 3 };
  var n = K.setTab(s, 'emoji');
  assert.equal(n.tab, 'maths');
  assert.equal(n.shift, 'once');
  assert.equal(n.lastShiftAt, 3);
});
