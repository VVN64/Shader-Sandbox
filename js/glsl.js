/* ShaderSandbox — GLSL vocabulary + autocomplete logic (pure, no DOM).
 *
 * NS.glsl = {
 *   KEYWORDS, TYPES, BUILTINS, CONSTANTS, UNIFORM_ALIASES   // word arrays (shared with the highlighter)
 *   SIGNATURES        // builtin name -> 'name(args)' hint
 *   VARIABLES         // preview-provided uniforms / gl_ built-ins -> 'type · description'
 *   wordAt(text, pos)            -> { start, end, prefix }
 *   inComment(text, pos)         -> bool
 *   completionContext(text, pos) -> { start, end, prefix } | null
 *   documentIdentifiers(text)    -> [name, ...]  (user identifiers, first-appearance order)
 *   suggest(text, pos, opts)     -> { start, end, prefix, items: [{ text, kind, detail }] } | null
 * }
 */
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) {
  'use strict';

  function words(str) { return str.split(/\s+/).filter(function (w) { return !!w; }); }

  // Keep these strings identical to the highlighter's word lists.
  var KEYWORDS = words(
    'uniform varying attribute in out inout const if else for while do return ' +
    'break continue discard struct precision highp mediump lowp switch case default ' +
    'layout flat smooth centroid invariant'
  );
  var TYPES = words(
    'float int uint bool void vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 ' +
    'bvec2 bvec3 bvec4 mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 ' +
    'mat4x2 mat4x3 mat4x4 sampler2D sampler3D samplerCube sampler2DArray'
  );
  var BUILTINS = words(
    'radians degrees sin cos tan asin acos atan sinh cosh tanh pow exp log exp2 log2 ' +
    'sqrt inversesqrt abs sign floor ceil trunc round fract mod min max clamp mix step ' +
    'smoothstep length distance dot cross normalize faceforward reflect refract ' +
    'matrixCompMult transpose inverse determinant lessThan lessThanEqual greaterThan ' +
    'greaterThanEqual equal notEqual any all not texture2D texture2DLod textureCube ' +
    'texture textureLod texelFetch textureSize dFdx dFdy fwidth'
  );
  var CONSTANTS = words('true false');
  var UNIFORM_ALIASES = words('iTime iResolution iMouse iFrame iTimeDelta iDate');

  var SIGNATURES = {
    radians: 'radians(degrees)',
    degrees: 'degrees(radians)',
    sin: 'sin(angle)',
    cos: 'cos(angle)',
    tan: 'tan(angle)',
    asin: 'asin(x)',
    acos: 'acos(x)',
    atan: 'atan(y, x) | atan(y_over_x)',
    sinh: 'sinh(x)',
    cosh: 'cosh(x)',
    tanh: 'tanh(x)',
    pow: 'pow(x, y)',
    exp: 'exp(x)',
    log: 'log(x)',
    exp2: 'exp2(x)',
    log2: 'log2(x)',
    sqrt: 'sqrt(x)',
    inversesqrt: 'inversesqrt(x)',
    abs: 'abs(x)',
    sign: 'sign(x)',
    floor: 'floor(x)',
    ceil: 'ceil(x)',
    trunc: 'trunc(x)',
    round: 'round(x)',
    fract: 'fract(x)',
    mod: 'mod(x, y)',
    min: 'min(x, y)',
    max: 'max(x, y)',
    clamp: 'clamp(x, minVal, maxVal)',
    mix: 'mix(x, y, a)',
    step: 'step(edge, x)',
    smoothstep: 'smoothstep(edge0, edge1, x)',
    length: 'length(x)',
    distance: 'distance(p0, p1)',
    dot: 'dot(x, y)',
    cross: 'cross(x, y)',
    normalize: 'normalize(x)',
    faceforward: 'faceforward(N, I, Nref)',
    reflect: 'reflect(I, N)',
    refract: 'refract(I, N, eta)',
    matrixCompMult: 'matrixCompMult(x, y)',
    transpose: 'transpose(m)',
    inverse: 'inverse(m)',
    determinant: 'determinant(m)',
    lessThan: 'lessThan(x, y)',
    lessThanEqual: 'lessThanEqual(x, y)',
    greaterThan: 'greaterThan(x, y)',
    greaterThanEqual: 'greaterThanEqual(x, y)',
    equal: 'equal(x, y)',
    notEqual: 'notEqual(x, y)',
    any: 'any(bvec)',
    all: 'all(bvec)',
    not: 'not(bvec)',
    texture2D: 'texture2D(sampler, coord)',
    texture2DLod: 'texture2DLod(sampler, coord, lod)',
    textureCube: 'textureCube(sampler, dir)',
    texture: 'texture(sampler, coord)',
    textureLod: 'textureLod(sampler, coord, lod)',
    texelFetch: 'texelFetch(sampler, ivec, lod)',
    textureSize: 'textureSize(sampler, lod)',
    dFdx: 'dFdx(p)',
    dFdy: 'dFdy(p)',
    fwidth: 'fwidth(p)'
  };

  // What the preview actually provides (it sets only these 4 Shadertoy aliases).
  var VARIABLES = {
    u_time: 'float · seconds since start',
    u_resolution: 'vec2 · canvas size in px',
    u_mouse: 'vec2 · mouse position in px',
    iTime: 'float · seconds since start (Shadertoy)',
    iResolution: 'vec3 · canvas size in px (Shadertoy)',
    iMouse: 'vec4 · mouse position in px (Shadertoy)',
    iFrame: 'int · frame number (Shadertoy)',
    gl_FragCoord: "vec4 · this pixel's window position",
    gl_FragColor: 'vec4 · output colour (GLSL ES 1.0)'
  };

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  var VOCAB = Object.create(null);
  [KEYWORDS, TYPES, BUILTINS, CONSTANTS, UNIFORM_ALIASES].forEach(function (list) {
    list.forEach(function (w) { VOCAB[w] = true; });
  });

  function isIdentChar(ch) { return !!ch && /[A-Za-z0-9_]/.test(ch); }

  function wordAt(text, pos) {
    var s = pos, e = pos;
    while (s > 0 && isIdentChar(text.charAt(s - 1))) s--;
    while (e < text.length && isIdentChar(text.charAt(e))) e++;
    return { start: s, end: e, prefix: text.slice(s, pos) };
  }

  // Comments only (GLSL has no string literals). Block comments may be unterminated.
  var COMMENT_RE = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;

  function inComment(text, pos) {
    var before = text.slice(0, pos);
    var m;
    COMMENT_RE.lastIndex = 0;
    while ((m = COMMENT_RE.exec(before)) !== null) {
      var c = m[0];
      if (m.index + c.length < before.length) continue;
      if (c.charAt(1) === '/') return true;          // line comment reaching the caret
      // block: closed only if it ends in '*/' beyond the opening '/*' ('/*/' is still open)
      return !(c.length >= 4 && c.slice(-2) === '*/');
    }
    return false;
  }

  function completionContext(text, pos) {
    if (inComment(text, pos)) return null;
    var w = wordAt(text, pos);
    if (/^[0-9]/.test(text.slice(w.start, w.end))) return null;   // numeric literal
    var prev = w.start > 0 ? text.charAt(w.start - 1) : '';
    if (prev === '.' || prev === '#') return null;                 // swizzle/member, directive
    return w;
  }

  // Numbers are consumed whole so their letters (1e5, 0x1F, 1.0f) never look like names;
  // a leading '.' or '#' marks a member/swizzle or a directive word. (No regex lookbehind:
  // keeps the file parseable by older Safari.)
  var IDENT_RE = /[0-9][\w]*|([.#]?)([A-Za-z_]\w*)/g;

  function documentIdentifiers(text) {
    var src = text.replace(COMMENT_RE, ' ');
    var seen = Object.create(null);
    var out = [];
    var m;
    IDENT_RE.lastIndex = 0;
    while ((m = IDENT_RE.exec(src)) !== null) {
      var name = m[2];
      if (!name || m[1]) continue;
      if (VOCAB[name] || has(VARIABLES, name) || name.indexOf('GL_') === 0) continue;
      if (seen[name]) continue;
      seen[name] = true;
      out.push(name);
    }
    return out;
  }

  var KIND_RANK = { local: 0, variable: 1, 'function': 2, type: 3, keyword: 4, constant: 4 };

  function suggest(text, pos, opts) {
    opts = opts || {};
    var minPrefix = opts.minPrefix != null ? opts.minPrefix : 0;
    var limit = opts.limit != null ? opts.limit : 12;

    var ctx = completionContext(text, pos);
    if (!ctx || ctx.prefix.length < minPrefix) return null;
    var prefix = ctx.prefix;
    var lower = prefix.toLowerCase();

    var seen = Object.create(null);
    var cands = [];
    function add(name, kind, detail) {
      if (seen[name]) return;
      seen[name] = true;
      if (name.slice(0, prefix.length).toLowerCase() !== lower) return;
      cands.push({ text: name, kind: kind, detail: detail });
    }

    var others = text.slice(0, ctx.start) + ' ' + text.slice(ctx.end);
    documentIdentifiers(others).forEach(function (n) { add(n, 'local', ''); });
    Object.keys(VARIABLES).forEach(function (n) { add(n, 'variable', VARIABLES[n]); });
    BUILTINS.forEach(function (n) { add(n, 'function', SIGNATURES[n] || ''); });
    TYPES.forEach(function (n) { add(n, 'type', ''); });
    KEYWORDS.forEach(function (n) { add(n, 'keyword', ''); });
    CONSTANTS.forEach(function (n) { add(n, 'constant', ''); });

    function key(it) {
      return [
        it.text === prefix ? 0 : 1,
        it.text.slice(0, prefix.length) === prefix ? 0 : 1,
        KIND_RANK[it.kind],
        it.text.length
      ];
    }
    cands.sort(function (a, b) {
      var ka = key(a), kb = key(b);
      for (var i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
    });

    if (!cands.length) return null;
    if (cands.length === 1 && cands[0].text === prefix) return null;
    return { start: ctx.start, end: ctx.end, prefix: prefix, items: cands.slice(0, limit) };
  }

  NS.glsl = {
    KEYWORDS: KEYWORDS,
    TYPES: TYPES,
    BUILTINS: BUILTINS,
    CONSTANTS: CONSTANTS,
    UNIFORM_ALIASES: UNIFORM_ALIASES,
    SIGNATURES: SIGNATURES,
    VARIABLES: VARIABLES,
    wordAt: wordAt,
    inComment: inComment,
    completionContext: completionContext,
    documentIdentifiers: documentIdentifiers,
    suggest: suggest
  };
})(window.ShaderSandbox);
