'use strict';
// Node tests for js/glsl.js (pure-logic GLSL completion helpers).
// Run: node --test tests/glsl.test.js   (no deps; Node >= 18)

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var ROOT = path.join(__dirname, '..');
var GLSL_PATH = path.join(ROOT, 'js', 'glsl.js');
var EDITOR_PATH = path.join(ROOT, 'js', 'editor.js');

function loadInto(ctx, file, name) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: name });
}
function freshContext() {
  var ctx = { window: {} };
  vm.createContext(ctx);
  loadInto(ctx, GLSL_PATH, 'js/glsl.js');
  return ctx;
}

var G = freshContext().window.ShaderSandbox.glsl;

// vm-realm objects fail deepStrictEqual prototype checks; normalise first.
function plain(x) { return JSON.parse(JSON.stringify(x)); }
// at('src with | caret') -> { text, pos }
function at(src) {
  var pos = src.indexOf('|');
  assert.ok(pos >= 0, 'fixture needs a | caret');
  return { text: src.slice(0, pos) + src.slice(pos + 1), pos: pos };
}
function sug(src, opts) { var c = at(src); return G.suggest(c.text, c.pos, opts); }
function texts(r) { return r.items.map(function (i) { return i.text; }); }

// Fixture: copied verbatim from js/editor.js (lines 24-43).
var EDITOR_WORDS = {
  KEYWORDS:
    'uniform varying attribute in out inout const if else for while do return ' +
    'break continue discard struct precision highp mediump lowp switch case default ' +
    'layout flat smooth centroid invariant',
  TYPES:
    'float int uint bool void vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 ' +
    'bvec2 bvec3 bvec4 mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 ' +
    'mat4x2 mat4x3 mat4x4 sampler2D sampler3D samplerCube sampler2DArray',
  BUILTINS:
    'radians degrees sin cos tan asin acos atan sinh cosh tanh pow exp log exp2 log2 ' +
    'sqrt inversesqrt abs sign floor ceil trunc round fract mod min max clamp mix step ' +
    'smoothstep length distance dot cross normalize faceforward reflect refract ' +
    'matrixCompMult transpose inverse determinant lessThan lessThanEqual greaterThan ' +
    'greaterThanEqual equal notEqual any all not texture2D texture2DLod textureCube ' +
    'texture textureLod texelFetch textureSize dFdx dFdy fwidth',
  CONSTANTS: 'true false',
  UNIFORM_ALIASES: 'iTime iResolution iMouse iFrame iTimeDelta iDate'
};

var SHADER = [
  '#ifdef GL_ES',
  'precision mediump float;',
  '#endif',
  '#define PI 3.14159',
  'uniform vec2 u_resolution;',
  '// commentword should not appear',
  '/* blockword neither */',
  'float circle(vec2 p, float r) { return step(length(p), r) * 1e5 + 0x1F; }',
  'void main() {',
  '    vec2 st = gl_FragCoord.xy / u_resolution;',
  '    vec3 color = vec3(st.x, PI, 0.0);',
  '    color *= circle(st, 0.5);',
  '    gl_FragColor = vec4(color, 1.0);',
  '}'
].join('\n');

// ---------------------------------------------------------------- vocabulary

test('vocabulary arrays match the editor.js highlighter word strings exactly', function () {
  Object.keys(EDITOR_WORDS).forEach(function (k) {
    assert.ok(Array.isArray(G[k]) || (G[k] && typeof G[k].length === 'number'), k + ' is array-like');
    assert.deepEqual(plain(G[k]), EDITOR_WORDS[k].split(/\s+/), k);
  });
});

test('vocabulary arrays round-trip through wordSet(join(" "))', function () {
  Object.keys(EDITOR_WORDS).forEach(function (k) {
    assert.equal(G[k].join(' '), EDITOR_WORDS[k].split(/\s+/).join(' '), k);
  });
});

test('every builtin has a non-empty signature starting with its name', function () {
  G.BUILTINS.forEach(function (b) {
    var s = G.SIGNATURES[b];
    assert.equal(typeof s, 'string', 'signature for ' + b);
    assert.ok(s.indexOf(b + '(') === 0, b + ' -> ' + s);
  });
  assert.equal(G.SIGNATURES.smoothstep, 'smoothstep(edge0, edge1, x)');
  assert.equal(G.SIGNATURES.atan, 'atan(y, x) | atan(y_over_x)');
});

test('SIGNATURES has no keys beyond BUILTINS', function () {
  assert.deepEqual(Object.keys(G.SIGNATURES).sort(), plain(G.BUILTINS).sort());
});

test('VARIABLES covers the preview uniforms, the 4 Shadertoy aliases and gl_ built-ins', function () {
  assert.deepEqual(Object.keys(G.VARIABLES).sort(), [
    'gl_FragColor', 'gl_FragCoord', 'iFrame', 'iMouse', 'iResolution', 'iTime',
    'u_mouse', 'u_resolution', 'u_time'
  ]);
  assert.equal(G.VARIABLES.u_time, 'float · seconds since start');
  assert.equal(G.VARIABLES.u_resolution, 'vec2 · canvas size in px');
  assert.equal(G.VARIABLES.u_mouse, 'vec2 · mouse position in px');
  assert.equal(G.VARIABLES.gl_FragCoord, "vec4 · this pixel's window position");
  assert.equal(G.VARIABLES.gl_FragColor, 'vec4 · output colour (GLSL ES 1.0)');
  assert.match(G.VARIABLES.iResolution, /^vec3 · /);
  assert.match(G.VARIABLES.iMouse, /^vec4 · /);
  assert.match(G.VARIABLES.iFrame, /^int · /);
  assert.match(G.VARIABLES.iTime, /^float · /);
});

// ---------------------------------------------------------------- wordAt

test('wordAt at end of word', function () {
  var c = at('float smo|');
  assert.deepEqual(plain(G.wordAt(c.text, c.pos)), { start: 6, end: 9, prefix: 'smo' });
});

test('wordAt mid-word spans the whole identifier, prefix is left part', function () {
  var c = at('x = smo|othstep(0.0');
  assert.deepEqual(plain(G.wordAt(c.text, c.pos)), { start: 4, end: 14, prefix: 'smo' });
});

test('wordAt on whitespace is an empty range', function () {
  var c = at('a |b');
  assert.deepEqual(plain(G.wordAt(c.text, c.pos)), { start: 2, end: 3, prefix: '' });
  c = at('a | b');
  assert.deepEqual(plain(G.wordAt(c.text, c.pos)), { start: 2, end: 2, prefix: '' });
});

test('wordAt handles start and end of text', function () {
  assert.deepEqual(plain(G.wordAt('', 0)), { start: 0, end: 0, prefix: '' });
  assert.deepEqual(plain(G.wordAt('u_time', 0)), { start: 0, end: 6, prefix: '' });
  assert.deepEqual(plain(G.wordAt('u_time', 6)), { start: 0, end: 6, prefix: 'u_time' });
});

// ---------------------------------------------------------------- inComment

test('inComment: line comments', function () {
  var c = at('float a; // hello wor|');
  assert.equal(G.inComment(c.text, c.pos), true);
  c = at('float a; // hello\nfl|');
  assert.equal(G.inComment(c.text, c.pos), false);
  c = at('// hello\n|');
  assert.equal(G.inComment(c.text, c.pos), false, 'start of line after // comment');
  c = at('float a; /|/ x');
  assert.equal(G.inComment(c.text, c.pos), false, 'between the two slashes');
});

test('inComment: block comments', function () {
  var c = at('/* unterminated wor|');
  assert.equal(G.inComment(c.text, c.pos), true);
  c = at('/* multi\nline wor|d */');
  assert.equal(G.inComment(c.text, c.pos), true);
  c = at('/* closed */|');
  assert.equal(G.inComment(c.text, c.pos), false, 'right after */');
  c = at('/* closed */ fl|');
  assert.equal(G.inComment(c.text, c.pos), false);
  c = at('/*/|');
  assert.equal(G.inComment(c.text, c.pos), true, '/*/ does not close');
  c = at('/**/|');
  assert.equal(G.inComment(c.text, c.pos), false, '/**/ is closed');
  c = at('// a /* b\nfl|');
  assert.equal(G.inComment(c.text, c.pos), false, '/* inside // does not open a block');
  c = at('/* a // b */ fl|');
  assert.equal(G.inComment(c.text, c.pos), false, '// inside /* */ is inert');
});

// ---------------------------------------------------------------- completionContext

test('completionContext returns the word range in code', function () {
  var c = at('vec2 st = smo|');
  assert.deepEqual(plain(G.completionContext(c.text, c.pos)), { start: 10, end: 13, prefix: 'smo' });
});

test('completionContext is null in comments', function () {
  var c = at('// smo|');
  assert.equal(G.completionContext(c.text, c.pos), null);
  c = at('/* smo|');
  assert.equal(G.completionContext(c.text, c.pos), null);
});

test('completionContext is null in numbers', function () {
  var c = at('float a = 1e|5;');
  assert.equal(G.completionContext(c.text, c.pos), null);
  c = at('int b = 0x1F|;');
  assert.equal(G.completionContext(c.text, c.pos), null);
  c = at('float c = 2.5|');
  assert.equal(G.completionContext(c.text, c.pos), null);
});

test('completionContext is null after "." (swizzle/member) and "#" (directive)', function () {
  var c = at('st.x|');
  assert.equal(G.completionContext(c.text, c.pos), null);
  c = at('st.|');
  assert.equal(G.completionContext(c.text, c.pos), null);
  c = at('#def|');
  assert.equal(G.completionContext(c.text, c.pos), null);
});

test('completionContext is non-null right after a closed block comment', function () {
  var c = at('/* note */smo|');
  assert.deepEqual(plain(G.completionContext(c.text, c.pos)), { start: 10, end: 13, prefix: 'smo' });
});

// ---------------------------------------------------------------- documentIdentifiers

test('documentIdentifiers finds user names in first-appearance order', function () {
  assert.deepEqual(plain(G.documentIdentifiers(SHADER)), ['PI', 'circle', 'p', 'r', 'main', 'st', 'color']);
});

test('documentIdentifiers excludes swizzles, comment words, GL_ES, vocabulary, numbers', function () {
  var ids = plain(G.documentIdentifiers(SHADER));
  ['xy', 'x', 'commentword', 'blockword', 'neither', 'GL_ES', 'ifdef', 'define', 'endif',
   'float', 'vec2', 'step', 'precision', 'mediump', 'uniform', 'u_resolution',
   'gl_FragCoord', 'gl_FragColor', 'e5', 'x1F'].forEach(function (w) {
    assert.equal(ids.indexOf(w), -1, w + ' must be excluded');
  });
});

test('documentIdentifiers keeps user function names like main and unique entries', function () {
  var ids = plain(G.documentIdentifiers('void main() {}\nvoid main2() { main(); }'));
  assert.deepEqual(ids, ['main', 'main2']);
  assert.deepEqual(plain(G.documentIdentifiers('')), []);
});

// ---------------------------------------------------------------- suggest

test("suggest 'smo|' -> smoothstep first, with signature detail", function () {
  var r = sug('float a = smo|');
  assert.ok(r);
  assert.equal(r.start, 10);
  assert.equal(r.end, 13);
  assert.equal(r.prefix, 'smo');
  assert.deepEqual(plain(r.items[0]), {
    text: 'smoothstep', kind: 'function', detail: 'smoothstep(edge0, edge1, x)'
  });
});

test("suggest 'co|' ranks local 'color' before builtin cos and keyword const", function () {
  var r = sug('vec3 color = vec3(0.0);\nco|');
  var t = texts(r);
  assert.equal(t[0], 'color');
  assert.equal(r.items[0].kind, 'local');
  assert.ok(t.indexOf('cos') > 0 && t.indexOf('const') > t.indexOf('cos'), t.join(','));
  assert.equal(r.items[t.indexOf('const')].kind, 'keyword');
});

test("suggest 'u_t|' -> u_time variable with detail", function () {
  var r = sug('float t = u_t|');
  assert.deepEqual(plain(r.items[0]), { text: 'u_time', kind: 'variable', detail: 'float · seconds since start' });
});

test('suggest honours minPrefix', function () {
  assert.equal(sug('float a = s|', { minPrefix: 2 }), null);
  assert.ok(sug('float a = sm|', { minPrefix: 2 }));
  assert.ok(sug('float a = s|'));
});

test('suggest returns null when the only match equals the prefix exactly', function () {
  assert.equal(sug('float a = smoothstep|'), null);
});

test("suggest 'st|' with 'vec2 st' declared -> exact local first, step still offered", function () {
  var r = sug('vec2 st = vec2(0.0);\nst|');
  var t = texts(r);
  assert.equal(t[0], 'st');
  assert.equal(r.items[0].kind, 'local');
  assert.ok(t.indexOf('step') > 0);
});

test('suggest does not offer the word being typed from itself', function () {
  var r = sug('float a = smoo|');
  assert.equal(texts(r).indexOf('smoo'), -1);
  assert.equal(sug('float a = zzq|'), null, 'no candidates -> null');
});

test('suggest honours limit; empty prefix returns everything ranked', function () {
  var r = sug('vec2 st;\n|', { limit: 5 });
  assert.equal(r.items.length, 5);
  assert.equal(r.prefix, '');
  assert.equal(r.items[0].text, 'st', 'locals first on manual trigger');
  var d = sug('vec2 st;\n|');
  assert.equal(d.items.length, 12, 'default limit 12');
  var all = sug('vec2 st;\n|', { limit: 1000 });
  var expected = 1 + Object.keys(G.VARIABLES).length + G.BUILTINS.length +
    G.TYPES.length + G.KEYWORDS.length + G.CONSTANTS.length;
  assert.equal(all.items.length, expected);
});

test("suggest is case-insensitive: 'SMO|' still includes smoothstep", function () {
  var r = sug('float a = SMO|');
  assert.ok(texts(r).indexOf('smoothstep') >= 0);
});

test('suggest ranks case-sensitive prefix matches before case-insensitive ones', function () {
  var r = sug('float Mixer;\nmi|');
  var t = texts(r);
  assert.ok(t.indexOf('mix') < t.indexOf('Mixer'), t.join(','));
  assert.ok(t.indexOf('min') < t.indexOf('Mixer'), t.join(','));
});

test("suggest mid-word 'smo|oth' covers the whole word", function () {
  var r = sug('float a = smo|oth');
  assert.equal(r.start, 10);
  assert.equal(r.end, 16);
  assert.equal(r.prefix, 'smo');
  assert.equal(r.items[0].text, 'smoothstep');
});

test('suggest is null in comments, after "." and in numbers', function () {
  assert.equal(sug('// smo|'), null);
  assert.equal(sug('st.x|'), null);
  assert.equal(sug('float a = 1e|'), null);
});

test('suggest ties: shorter first, then alphabetical', function () {
  var r = sug('float a = te|');
  // all builtins, same case: texture (7) < texture2D (9) < texelFetch = textureLod (10)
  var t = texts(r);
  assert.equal(t[0], 'texture');
  assert.ok(t.indexOf('texture2D') < t.indexOf('texelFetch'), 'shorter first: ' + t.join(','));
  assert.ok(t.indexOf('texelFetch') < t.indexOf('textureLod'), 'then alphabetical: ' + t.join(','));
});

// ---------------------------------------------------------------- integration

test('glsl.js + real editor.js load together in one context (no DOM at top level)', function () {
  var ctx = freshContext();
  loadInto(ctx, EDITOR_PATH, 'js/editor.js');
  var NS = ctx.window.ShaderSandbox;
  assert.equal(typeof NS.createEditor, 'function');
  assert.equal(typeof NS.glsl.suggest, 'function', 'editor.js must not clobber NS.glsl');
});
