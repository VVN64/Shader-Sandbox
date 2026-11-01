/* ShaderSandbox — shader probe engine ("Graph this shader value").
 * Exposes NS.createProbeEngine({ getUniforms }).
 * See CONTRACT.md, "Feature 2". Classic script, attaches to window.ShaderSandbox.
 *
 * How it works: the user's fragment shader is instrumented so that right after
 * the statement on the selected line the selected expression is captured into a
 * global (`_probe_v = _probe_pack(EXPR);`). A new main() remaps gl_FragCoord so
 * that pixel i of a 1-pixel-high float render target corresponds to graph x_i on
 * the chosen row, calls the user's (renamed) main, and writes the captured value
 * out. readPixels(FLOAT) gives the values back.
 */
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) {
  'use strict';

  var MAX_SAMPLES = 4096;
  var LQ = '‘', RQ = '’';

  var VS_100 =
    'attribute vec2 a_pos;\n' +
    'void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n';
  var VS_300 =
    '#version 300 es\n' +
    'in vec2 a_pos;\n' +
    'void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n';

  var RE_VERSION_300 = /^[ \t]*#[ \t]*version[ \t]+300[ \t]+es\b/m;
  var RE_PRECISION = /\bprecision\b/;
  var RE_MAIN = /\bvoid\s+main\s*\(\s*(?:void\s*)?\)/g;
  var RE_MAIN_BODY = /\bvoid\s+main\s*\(\s*(?:void\s*)?\)\s*\{/;
  var RE_OUT_VEC4 = /(?:^|[;\s)])out\s+(?:(?:highp|mediump|lowp)\s+)?vec4\s+([A-Za-z_]\w*)\s*;/;

  var TYPE_RE_SRC = '(?:float|int|uint|bool|[ibu]?vec[234]|mat[234](?:x[234])?)';
  var RE_LEADING_QUAL = /^(?:const|highp|mediump|lowp|in|out|inout|uniform|varying|attribute|flat|smooth|centroid|invariant)\s+/;
  var RE_LEADING_TYPE = new RegExp('^' + TYPE_RE_SRC + '\\s+(?=[A-Za-z_])');
  var RE_DECL_BEFORE = new RegExp('\\b' + TYPE_RE_SRC + '\\s+$');
  var RE_ASSIGN_AFTER = /^\s*(?:[-+*\/%&|^]|<<|>>)?=(?!=)/;

  function quote(s) { return LQ + s + RQ; }

  // Minimal log parser fallback (the preview exposes a better one).
  function parseLogFallback(log) {
    var out = [];
    String(log || '').replace(/\0/g, '').split(/\r?\n/).forEach(function (raw) {
      var t = raw.trim();
      if (!t || /^warning\b/i.test(t) || /compilation errors?/i.test(t)) return;
      var m = /^(?:ERROR|error)\s*:\s*-?\d+\s*:\s*(\d+)\s*:\s*(.*)$/.exec(t) ||
              /^\d+\s*:\s*(\d+)\s*\(\s*\d+\s*\)\s*:\s*error\s*:?\s*(.*)$/i.exec(t) ||
              /^\d+\s*\(\s*(\d+)\s*\)\s*:\s*error\b[^:]*:\s*(.*)$/i.exec(t);
      if (m) out.push({ line: +m[1] || 1, message: m[2].replace(/^''\s*:\s*/, '').trim() || t });
      else out.push({ line: 1, message: t.replace(/^error\s*:\s*/i, '') });
    });
    return out;
  }
  function parseLog(log) {
    var f = typeof NS._parseShaderLog === 'function' ? NS._parseShaderLog : parseLogFallback;
    return f(log);
  }

  // ---------------------------------------------------------------- source text helpers

  // Returns { noComments, clean }: both the same length as src, newlines kept.
  // noComments: comments replaced by spaces. clean: additionally, preprocessor
  // lines blanked (used by the statement scanner).
  function stripSource(src) {
    var out = new Array(src.length);
    var i = 0, n = src.length;
    while (i < n) {
      var c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      } else if (c === '/' && d === '*') {
        out[i] = ' '; out[i + 1] = ' '; i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = src[i] === '\n' ? '\n' : ' '; i++; }
        if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      } else { out[i] = c; i++; }
    }
    var noComments = out.join('');
    var clean = noComments.split('\n').map(function (l) {
      return /^\s*#/.test(l) ? l.replace(/[^\n]/g, ' ') : l;
    }).join('\n');
    return { noComments: noComments, clean: clean };
  }

  function lineStarts(src) {
    var starts = [0];
    for (var i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
    return starts;
  }

  // Index of the line before which to insert our header: after the leading run
  // of blank / comment / #version / #extension lines (mirrors the preview).
  function headerInsertIndex(lines) {
    var lastDirective = -1;
    var inBlock = false;
    for (var idx = 0; idx < lines.length; idx++) {
      var l = lines[idx];
      if (inBlock) { if (l.indexOf('*/') >= 0) inBlock = false; continue; }
      if (/^\s*#\s*(version|extension)\b/.test(l)) { lastDirective = idx; continue; }
      if (/^\s*(\/\/.*)?$/.test(l)) continue;
      if (/^\s*\/\*/.test(l) && l.indexOf('*/') < 0) { inBlock = true; continue; }
      if (/^\s*\/\*.*\*\/\s*$/.test(l)) continue;
      break;
    }
    return lastDirective + 1;
  }

  // ---------------------------------------------------------------- expression handling

  function cleanExpr(expr) {
    var e = String(expr == null ? '' : expr).trim();
    e = e.replace(/(\s*;)+\s*$/, '').trim();
    var prev;
    do {
      prev = e;
      e = e.replace(RE_LEADING_QUAL, '');
      e = e.replace(/^precision\s+/, '');
    } while (e !== prev);
    e = e.replace(RE_LEADING_TYPE, '').trim();
    if (!e) return { error: 'Select an expression to graph' };
    if (/[;{}]/.test(e)) return { error: 'Select a single expression (no ; { or })' };
    if (/=/.test(e.replace(/[=!<>]=/g, ''))) {
      var lhs = /^\s*([A-Za-z_][\w.\[\]]*)\s*(?:[-+*\/%&|^]|<<|>>)?=(?!=)/.exec(e);
      return { error: 'Select an expression, not an assignment' + (lhs ? ' (try selecting just ' + quote(lhs[1]) + ')' : '') };
    }
    var depth = 0;
    for (var i = 0; i < e.length; i++) {
      var c = e[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') { depth--; if (depth < 0) break; }
    }
    if (depth !== 0) return { error: 'Unbalanced brackets in ' + quote(e) };
    return { expr: e };
  }

  function escRe(c) { return c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
  function isWord(c) { return !!c && /\w/.test(c); }

  // Regex matching expr with flexible whitespace and identifier boundaries.
  // Group 1 = leading boundary char (or empty), so match start = index + g1.length.
  function exprRegex(expr) {
    var e = expr.replace(/\s+/g, ' ');
    var src = '';
    for (var i = 0; i < e.length; i++) {
      var c = e[i];
      if (c === ' ') continue;
      src += escRe(c);
      var j = i + 1, sawSpace = false;
      while (j < e.length && e[j] === ' ') { sawSpace = true; j++; }
      if (j < e.length) {
        if (isWord(c) && isWord(e[j])) src += sawSpace ? '\\s+' : '';
        else src += '\\s*';
      }
    }
    var lead = isWord(e[0]) ? '(^|[^\\w.])' : '()';
    var trail = isWord(e[e.length - 1]) ? '(?!\\w)' : '';
    return new RegExp(lead + src + trail, 'g');
  }

  // Find occurrences of expr on one (comment-free) line.
  // Returns [{ col, assigned:boolean }] (col = 0-based start column).
  function findOnLine(re, text) {
    var res = [];
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(text))) {
      var col = m.index + m[1].length;
      var end = m.index + m[0].length;
      var assigned = RE_ASSIGN_AFTER.test(text.slice(end)) || RE_DECL_BEFORE.test(text.slice(0, col));
      res.push({ col: col, assigned: assigned });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return res;
  }

  // Locate { line (1-based), col } of expr, preferring lineHint.
  function locate(noComments, expr, lineHint) {
    var lines = noComments.split('\n');
    var re = exprRegex(expr);
    var hint = Math.min(Math.max(1, Math.round(+lineHint || 1)), lines.length);
    var here = findOnLine(re, lines[hint - 1]);
    if (here.length) {
      var pick = here.filter(function (h) { return h.assigned; })[0] || here[0];
      return { line: hint, col: pick.col };
    }
    var bestAssigned = null, bestAny = null;
    for (var i = 0; i < lines.length; i++) {
      var found = findOnLine(re, lines[i]);
      if (!found.length) continue;
      var dist = Math.abs(i + 1 - hint);
      var a = found.filter(function (h) { return h.assigned; })[0];
      if (a && (!bestAssigned || dist < bestAssigned.dist)) bestAssigned = { line: i + 1, col: a.col, dist: dist };
      if (!bestAny || dist < bestAny.dist) bestAny = { line: i + 1, col: found[0].col, dist: dist };
    }
    return bestAssigned || bestAny;
  }

  // ---------------------------------------------------------------- insertion point scanner
  // Works on `clean` (comments + preprocessor lines blanked; same offsets as src).

  function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }
  function wordAt(s, i) { var m = /^[A-Za-z_]\w*/.exec(s.slice(i, i + 64)); return m ? m[0] : ''; }

  function matchParen(s, open) {
    var depth = 0;
    for (var i = open; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  // First ';' '{' or '}' at paren depth 0 starting at i.
  function findTerm(s, i) {
    var paren = 0;
    for (; i < s.length; i++) {
      var c = s[i];
      if (c === '(') paren++;
      else if (c === ')') { if (paren > 0) paren--; }
      else if (paren === 0 && (c === ';' || c === '{' || c === '}')) return { kind: c, pos: i };
    }
    return null;
  }

  function braceDepth(s, pos) {
    var d = 0;
    for (var i = 0; i < pos && i < s.length; i++) {
      if (s[i] === '{') d++;
      else if (s[i] === '}') d--;
    }
    return d;
  }

  // Start of the statement containing position m.
  function statementStart(s, m) {
    var paren = 0;
    for (var i = m - 1; i >= 0; i--) {
      var c = s[i];
      if (c === ')') paren++;
      else if (c === '(') { if (paren > 0) paren--; }
      else if (paren === 0 && (c === ';' || c === '{' || c === '}')) return i + 1;
    }
    return 0;
  }

  function mainBodyStart(clean) {
    var m = RE_MAIN_BODY.exec(clean);
    return m ? m.index + m[0].length : -1;
  }

  // Returns { insertions:[{pos,text}], error? } for capture text CAP placed for match at m.
  function planInsertion(clean, m, cap, isDirectiveLine) {
    var toMain = function () {
      var p = mainBodyStart(clean);
      if (p < 0) return { error: 'Couldn’t find void main() in the shader' };
      return { insertions: [{ pos: p, text: ' ' + cap + ' ' }] };
    };
    if (isDirectiveLine) return toMain();

    var s = skipWs(clean, statementStart(clean, m));
    var descended = false; // inside an unbraced if/else/for/while body
    var guard = 0;
    var res = null;
    while (guard++ < 64) {
      var w = wordAt(clean, s);
      if (w === 'else') { s = skipWs(clean, s + 4); descended = true; continue; }
      if (w === 'if' || w === 'while' || w === 'switch' || w === 'for') {
        var op = clean.indexOf('(', s);
        var cp = op >= 0 ? matchParen(clean, op) : -1;
        if (cp < 0) break;
        if (m < cp) {
          if (w !== 'for' && !descended) {
            res = { insertions: [{ pos: s, text: cap + ' ' }] };
            break;
          }
          // `for` header (loop var only in scope inside) or `else if` condition:
          // capture at the start of the body block.
          var t = findTerm(clean, cp + 1);
          if (t && t.kind === '{') { res = { insertions: [{ pos: t.pos + 1, text: ' ' + cap + ' ' }] }; break; }
          res = { insertions: [{ pos: s, text: cap + ' ' }] };
          break;
        }
        s = skipWs(clean, cp + 1);
        descended = true;
        continue;
      }
      if (w === 'do') { s = skipWs(clean, s + 2); descended = true; continue; }
      if (clean[s] === '{') { s = skipWs(clean, s + 1); descended = false; continue; }
      if (w === 'return') {
        var rt = findTerm(clean, s);
        if (descended && rt && rt.kind === ';') {
          res = { insertions: [{ pos: s, text: '{ ' + cap + ' ' }, { pos: rt.pos + 1, text: ' }' }] };
        } else {
          res = { insertions: [{ pos: s, text: cap + ' ' }] };
        }
        break;
      }
      var term = findTerm(clean, s);
      if (!term) break;
      if (term.kind === ';' && term.pos < m) { s = skipWs(clean, term.pos + 1); descended = false; continue; }
      if (braceDepth(clean, s) === 0) {
        // Global scope: a function header gets the capture at the start of its
        // body; anything else (uniform/const/struct...) goes to main().
        var head = clean.slice(s, term.pos);
        if (term.kind === '{' && /\(/.test(head) && !/\b(struct|uniform|in|out|buffer)\b/.test(head)) {
          res = { insertions: [{ pos: term.pos + 1, text: ' ' + cap + ' ' }] };
          break;
        }
        return toMain();
      }
      if (term.kind === ';') {
        if (descended) res = { insertions: [{ pos: s, text: '{ ' }, { pos: term.pos + 1, text: ' ' + cap + ' }' }] };
        else res = { insertions: [{ pos: term.pos + 1, text: ' ' + cap }] };
      } else if (term.kind === '{') {
        res = { insertions: [{ pos: term.pos + 1, text: ' ' + cap + ' ' }] };
      } else { // '}' closes the block before any ';'
        res = { insertions: [{ pos: term.pos, text: cap + ' ' }] };
      }
      break;
    }
    if (!res) return toMain();
    if (braceDepth(clean, res.insertions[0].pos) <= 0) return toMain();
    return res;
  }

  function applyInsertions(src, ins) {
    ins = ins.slice().sort(function (a, b) { return b.pos - a.pos; });
    ins.forEach(function (x) { src = src.slice(0, x.pos) + x.text + src.slice(x.pos); });
    return src;
  }

  // ---------------------------------------------------------------- instrumented source

  function packers(P, is300) {
    var out = [];
    function add(t, n, kind, body) {
      out.push(P + ' vec4 _probe_pack(' + (t === 'bool' || /^bvec/.test(t) ? '' : P + ' ') + t + ' v){ _probe_n = ' +
        (n + 10 * kind).toFixed(1) + '; return ' + body + '; }');
    }
    add('float', 1, 0, 'vec4(v, 0.0, 0.0, 0.0)');
    add('vec2', 2, 0, 'vec4(v, 0.0, 0.0)');
    add('vec3', 3, 0, 'vec4(v, 0.0)');
    add('vec4', 4, 0, 'v');
    add('int', 1, 1, 'vec4(float(v), 0.0, 0.0, 0.0)');
    add('ivec2', 2, 1, 'vec4(vec2(v), 0.0, 0.0)');
    add('ivec3', 3, 1, 'vec4(vec3(v), 0.0)');
    add('ivec4', 4, 1, 'vec4(v)');
    add('bool', 1, 2, 'vec4(v ? 1.0 : 0.0, 0.0, 0.0, 0.0)');
    add('bvec2', 2, 2, 'vec4(vec2(v), 0.0, 0.0)');
    add('bvec3', 3, 2, 'vec4(vec3(v), 0.0)');
    add('bvec4', 4, 2, 'vec4(v)');
    if (is300) {
      add('uint', 1, 3, 'vec4(float(v), 0.0, 0.0, 0.0)');
      add('uvec2', 2, 3, 'vec4(vec2(v), 0.0, 0.0)');
      add('uvec3', 3, 3, 'vec4(vec3(v), 0.0)');
      add('uvec4', 4, 3, 'vec4(v)');
    }
    return out.join('\n');
  }

  // Build the instrumented fragment source. Returns { src, outName } or { error }.
  function instrument(source, insertions, is300, P, addPrecision) {
    var src = applyInsertions(source, insertions);
    src = src.replace(/\bgl_FragCoord\b/g, '_probe_fc');
    RE_MAIN.lastIndex = 0;
    src = src.replace(RE_MAIN, 'void _probe_user_main()');

    var outName = 'gl_FragColor';
    if (is300) {
      var om = RE_OUT_VEC4.exec(stripSource(src).clean);
      if (!om) return { error: 'Couldn’t find the shader’s “out vec4” output' };
      outName = om[1];
    }

    var header = [
      '// ---- probe header ----',
      P + ' vec4 _probe_fc;',
      P + ' vec4 _probe_v;',
      P + ' float _probe_n;',
      'uniform ' + P + ' vec4 _probe_map;',
      'uniform ' + P + ' vec2 _probe_res;',
      'uniform ' + P + ' float _probe_mode;',
      packers(P, is300),
      '// ---- end probe header ----'
    ];
    if (addPrecision) header.unshift('precision mediump float;');

    var lines = src.split('\n');
    var at = headerInsertIndex(lines);
    lines.splice.apply(lines, [at, 0].concat(header));
    src = lines.join('\n');

    src += '\n\nvoid main() {\n' +
      '  ' + P + ' float _probe_t = (gl_FragCoord.x - 0.5) / max(_probe_map.z - 1.0, 1.0);\n' +
      '  ' + P + ' float _probe_x = mix(_probe_map.x, _probe_map.y, _probe_t);\n' +
      '  _probe_fc = vec4(_probe_x * _probe_res.x, _probe_map.w * _probe_res.y, gl_FragCoord.zw);\n' +
      '  _probe_v = vec4(0.0);\n' +
      '  _probe_n = 0.0;\n' +
      '  _probe_user_main();\n' +
      '  ' + outName + ' = _probe_mode < 0.5 ? _probe_v : vec4(_probe_n);\n' +
      '}\n';
    return { src: src, outName: outName };
  }

  var KIND_NAMES = [
    ['float', 'vec'],
    ['int', 'ivec'],
    ['bool', 'bvec'],
    ['uint', 'uvec']
  ];
  function typeName(code) {
    var count = Math.round(code) % 10;
    var kind = Math.floor(Math.round(code) / 10);
    var k = KIND_NAMES[kind] || KIND_NAMES[0];
    return count <= 1 ? k[0] : k[1] + count;
  }

  // ---------------------------------------------------------------- engine
  NS.createProbeEngine = function (options) {
    options = options || {};
    var getUniforms = typeof options.getUniforms === 'function' ? options.getUniforms : function () { return null; };

    var canvas = null, gl = null, isGL2 = false;
    var floatOK = false, noGL = false;
    var lost = false, destroyed = false;
    var generation = 0;
    var buffer = null, fbo = null, tex = null, fboWidth = 0;
    var vsCache = {};
    var P = 'highp';
    var maxWidth = MAX_SAMPLES;
    var readBuf = null;

    var attrs = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };

    function makeCanvas() {
      var c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      return c;
    }

    function initResources() {
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.DITHER);
      vsCache = {};
      fbo = null; tex = null; fboWidth = 0;
      var hp = gl.getShaderPrecisionFormat && gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      P = (hp && hp.precision > 0) ? 'highp' : 'mediump';
      var mt = gl.getParameter(gl.MAX_TEXTURE_SIZE) || MAX_SAMPLES;
      var mv = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      maxWidth = Math.min(MAX_SAMPLES, mt, mv ? mv[0] : MAX_SAMPLES);
      return ensureFbo(64);
    }

    // (Re)allocate the float target so it is at least `w` wide. Returns success.
    function ensureFbo(w) {
      if (fbo && fboWidth >= w) { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); return true; }
      var width = Math.min(maxWidth, Math.max(w, fboWidth * 2, 64));
      if (!tex) tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (isGL2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.FLOAT, null);
      if (!fbo) fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      fboWidth = ok ? width : 0;
      return ok;
    }

    function freeContext(g) {
      try { var ext = g.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) { /* ignore */ }
    }

    function initContext() {
      // 1) WebGL2 + EXT_color_buffer_float (RGBA32F)
      try {
        canvas = makeCanvas();
        gl = canvas.getContext('webgl2', attrs);
      } catch (e) { gl = null; }
      if (gl) {
        isGL2 = true;
        if (gl.getExtension('EXT_color_buffer_float') && initResources()) { floatOK = true; return; }
        freeContext(gl); gl = null; isGL2 = false;
      }
      // 2) WebGL1 + OES_texture_float (+ WEBGL_color_buffer_float)
      try {
        canvas = makeCanvas();
        gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
      } catch (e2) { gl = null; }
      if (gl) {
        if (gl.getExtension('OES_texture_float')) {
          gl.getExtension('WEBGL_color_buffer_float');
          if (initResources()) { floatOK = true; return; }
        }
        freeContext(gl); gl = null;
      }
      noGL = !gl && !floatOK;
    }

    initContext();
    if (gl && floatOK) {
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        lost = true;
        buffer = null; fbo = null; tex = null; fboWidth = 0; vsCache = {};
      }, false);
      canvas.addEventListener('webglcontextrestored', function () {
        if (destroyed) return;
        lost = false;
        generation++;
        try { if (!initResources()) floatOK = false; } catch (e) { floatOK = false; }
      }, false);
    }

    function isLost() { return lost || !gl || gl.isContextLost(); }

    // ------------------------------------------------------------ GL helpers
    function getVS(is300) {
      var key = is300 ? '300' : '100';
      if (vsCache[key]) return vsCache[key];
      var sh = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(sh, is300 ? VS_300 : VS_100);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
      vsCache[key] = sh;
      return sh;
    }

    // Compile + link. Returns { program } or { log }.
    function buildProgram(fsSrc, is300) {
      var fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSrc);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(fs) || 'Shader compilation failed';
        gl.deleteShader(fs);
        return { log: log };
      }
      var vs = getVS(is300);
      if (!vs) { gl.deleteShader(fs); return { log: 'Probe vertex shader failed to compile' }; }
      var prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, 'a_pos');
      gl.linkProgram(prog);
      gl.detachShader(prog, vs);
      gl.detachShader(prog, fs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        var plog = gl.getProgramInfoLog(prog) || 'Program link failed';
        gl.deleteProgram(prog);
        return { log: plog, link: true };
      }
      return { program: prog };
    }

    function compilesAlone(fsSrc) {
      var fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSrc);
      gl.compileShader(fs);
      var ok = gl.getShaderParameter(fs, gl.COMPILE_STATUS);
      var log = ok ? '' : (gl.getShaderInfoLog(fs) || 'Shader compilation failed');
      gl.deleteShader(fs);
      return { ok: ok, log: log };
    }

    function lookupUniforms(prog) {
      var u = {};
      var n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
      for (var i = 0; i < n; i++) {
        var info = gl.getActiveUniform(prog, i);
        if (!info) continue;
        var name = info.name.replace(/\[0\]$/, '');
        var loc = gl.getUniformLocation(prog, name);
        if (loc) u[name] = { loc: loc, type: info.type };
      }
      return u;
    }

    // Same type dispatch as the preview's setU.
    function setU(u, vals) {
      if (!u) return;
      var v0 = vals[0] || 0, v1 = vals[1] || 0, v2 = vals[2] || 0, v3 = vals[3] || 0;
      switch (u.type) {
        case gl.FLOAT: gl.uniform1f(u.loc, v0); break;
        case gl.FLOAT_VEC2: gl.uniform2f(u.loc, v0, v1); break;
        case gl.FLOAT_VEC3: gl.uniform3f(u.loc, v0, v1, v2); break;
        case gl.FLOAT_VEC4: gl.uniform4f(u.loc, v0, v1, v2, v3); break;
        case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, Math.floor(v0)); break;
        case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2i(u.loc, Math.floor(v0), Math.floor(v1)); break;
        case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3i(u.loc, Math.floor(v0), Math.floor(v1), Math.floor(v2)); break;
        case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4i(u.loc, Math.floor(v0), Math.floor(v1), Math.floor(v2), Math.floor(v3)); break;
        default:
          if (isGL2 && u.type === gl.UNSIGNED_INT) gl.uniform1ui(u.loc, Math.max(0, Math.floor(v0)));
      }
    }

    function readState() {
      var s = null;
      try { s = getUniforms(); } catch (e) { s = null; }
      s = s || {};
      var res = s.resolution || [1, 1];
      var mouse = s.mouse || [0, 0];
      var click = s.click || [0, 0, 0];
      return {
        time: +s.time || 0,
        w: +res[0] || 1, h: +res[1] || 1,
        mx: +mouse[0] || 0, my: +mouse[1] || 0,
        cx: +click[0] || 0, cy: +click[1] || 0, down: !!click[2],
        frame: +s.frame || 0
      };
    }

    // Draw n pixels for x in [x0,x1] on rowY. Fills readBuf (RGBA). Returns false on failure.
    function draw(probe, x0, x1, n, rowY, mode) {
      if (!ensureFbo(n)) return false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, n, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(probe.program);
      var u = probe.uniforms;
      var st = readState();
      var sgn = st.down ? 1 : -1;
      setU(u.u_time, [st.time]);
      setU(u.u_resolution, [st.w, st.h, 1]);
      setU(u.u_mouse, [st.mx, st.my, st.cx * sgn, st.cy * sgn]);
      setU(u.iTime, [st.time]);
      setU(u.iResolution, [st.w, st.h, 1]);
      setU(u.iMouse, [st.mx, st.my, st.cx * sgn, st.cy * sgn]);
      setU(u.u_frame, [st.frame]);
      setU(u.iFrame, [st.frame]);
      if (u._probe_map) gl.uniform4f(u._probe_map.loc, x0, x1, n, rowY);
      if (u._probe_res) gl.uniform2f(u._probe_res.loc, st.w, st.h);
      if (u._probe_mode) gl.uniform1f(u._probe_mode.loc, mode);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!readBuf || readBuf.length < n * 4) readBuf = new Float32Array(Math.max(n, 64) * 4);
      gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, readBuf);
      return gl.getError() === gl.NO_ERROR;
    }

    // ------------------------------------------------------------ error translation
    function friendlyError(log, expr, line) {
      var errs = parseLog(log);
      var msgs = errs.map(function (e) { return e.message; });
      var all = msgs.join('\n') + '\n' + String(log || '');
      var ident;
      // undeclared identifier for an identifier in the expression
      var reU = /'([A-Za-z_]\w*)'\s*:?\s*undeclared/g, mu;
      var reU2 = /undeclared identifier\s*'?([A-Za-z_]\w*)'?/g;
      var idents = [];
      while ((mu = reU.exec(all))) idents.push(mu[1]);
      while ((mu = reU2.exec(all))) idents.push(mu[1]);
      for (var i = 0; i < idents.length; i++) {
        ident = idents[i];
        if (new RegExp('(^|[^\\w.])' + ident + '(?!\\w)').test(expr)) return quote(ident) + ' is not in scope on line ' + line;
      }
      if (/_probe_pack/.test(all) && /(no matching|overload|no function|ambiguous)/i.test(all)) {
        return quote(expr) + ' is a matrix/struct — only float/int/bool scalars and vectors can be graphed';
      }
      var first = msgs[0] || String(log || '').trim().split('\n')[0] || 'Shader compilation failed';
      return first
        .replace(/_probe_user_main/g, 'main')
        .replace(/_probe_fc/g, 'gl_FragCoord')
        .replace(/_probe_pack\s*\(/g, '(')
        .trim();
    }

    // ------------------------------------------------------------ probe object
    function failed(msg, line) {
      return {
        ok: false, error: msg, line: line || 0, type: '', components: 0,
        sample: function () { return null; },
        dispose: function () {}
      };
    }

    function rebuild(probe) {
      if (probe.program) { try { gl.deleteProgram(probe.program); } catch (e) { /* ignore */ } }
      probe.program = null;
      var b = buildProgram(probe.fsSrc, probe.is300);
      if (!b.program) return false;
      probe.program = b.program;
      probe.uniforms = lookupUniforms(b.program);
      probe.gen = generation;
      return true;
    }

    function compile(source, exprIn, lineHint) {
      source = String(source == null ? '' : source);
      if (destroyed) return failed('Probe engine destroyed');
      if (noGL) return failed('WebGL not supported in this browser');
      if (!floatOK) return failed('Float render targets not supported in this browser');
      if (isLost()) return failed('WebGL context lost');

      var ce = cleanExpr(exprIn);
      if (ce.error) return failed(ce.error);
      var expr = ce.expr;

      var is300 = RE_VERSION_300.test(source);
      if (is300 && !isGL2) return failed('#version 300 es shaders need WebGL2 for graphing');

      var stripped = stripSource(source);
      var loc = locate(stripped.noComments, expr, lineHint);
      if (!loc) return failed('can’t find ' + quote(expr) + ' anymore');
      var line = loc.line;

      var starts = lineStarts(source);
      var m = starts[line - 1] + loc.col;
      var lineText = stripped.noComments.slice(starts[line - 1], line < starts.length ? starts[line] - 1 : source.length);
      var isDirective = /^\s*#/.test(lineText);
      var cap = '_probe_v = _probe_pack(' + expr + ');';
      var plan = planInsertion(stripped.clean, m, cap, isDirective);
      if (plan.error) return failed(plan.error, line);

      try {
        var inst = instrument(source, plan.insertions, is300, P, false);
        if (inst.error) return failed(inst.error, line);
        var b = buildProgram(inst.src, is300);
        var fsSrc = inst.src;
        if (!b.program && !RE_PRECISION.test(source)) {
          var inst2 = instrument(source, plan.insertions, is300, P, true);
          var b2 = buildProgram(inst2.src, is300);
          if (b2.program) { b = b2; fsSrc = inst2.src; }
          else b = b2;
        }
        if (!b.program) {
          // Is the user's shader itself broken? Then say so rather than blame the probe.
          var alone = compilesAlone(source);
          if (!alone.ok && !RE_PRECISION.test(source)) {
            var ls = source.split('\n');
            ls.splice(headerInsertIndex(ls), 0, 'precision mediump float;');
            alone = compilesAlone(ls.join('\n'));
          }
          if (!alone.ok) {
            var ue = parseLog(alone.log)[0];
            return failed('Shader has errors' + (ue ? ': ' + ue.message : ''), line);
          }
          return failed(friendlyError(b.log, expr, line), line);
        }

        var probe = {
          program: b.program, uniforms: lookupUniforms(b.program),
          fsSrc: fsSrc, is300: is300, gen: generation, disposed: false
        };

        // Determine type: draw with mode 1 (outputs _probe_n). Try the centre
        // row first, then a grid of rows in case the capture is in a branch.
        var code = 0;
        var rows = [0.5, 0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9];
        for (var r = 0; r < rows.length && !code; r++) {
          var nn = r === 0 ? 1 : 9;
          if (!draw(probe, r === 0 ? 0.5 : 0.1, 0.9, nn, rows[r], 1)) continue;
          for (var k = 0; k < nn; k++) { if (readBuf[k * 4] > 0.5) { code = readBuf[k * 4]; break; } }
        }
        if (!code) {
          gl.deleteProgram(probe.program);
          if (isLost()) return failed('WebGL context lost', line);
          return failed(quote(expr) + ' was never reached on line ' + line + ' (inside a branch or uncalled function?)', line);
        }
        var components = Math.min(4, Math.max(1, Math.round(code) % 10));

        var result = {
          ok: true, error: '', line: line, type: typeName(code), components: components,
          // Returns fresh Float32Arrays each call (safe to keep); the internal
          // readback buffer is reused.
          sample: function (xmin, xmax, n, rowY) {
            if (probe.disposed || destroyed || isLost() || !floatOK) return null;
            if (probe.gen !== generation && !rebuild(probe)) return null;
            n = Math.max(1, Math.min(maxWidth, Math.floor(+n) || 1));
            xmin = +xmin || 0;
            xmax = (xmax === undefined || isNaN(+xmax)) ? xmin : +xmax;
            rowY = (rowY === undefined || isNaN(+rowY)) ? 0.5 : +rowY;
            if (!draw(probe, xmin, n === 1 ? xmin : xmax, n, rowY, 0)) return null;
            var out = [];
            for (var c = 0; c < components; c++) {
              var arr = new Float32Array(n);
              for (var i = 0; i < n; i++) arr[i] = readBuf[i * 4 + c];
              out.push(arr);
            }
            return out;
          },
          dispose: function () {
            if (probe.disposed) return;
            probe.disposed = true;
            if (probe.program && gl && !isLost()) { try { gl.deleteProgram(probe.program); } catch (e) { /* ignore */ } }
            probe.program = null;
          }
        };
        return result;
      } catch (err) {
        return failed(String((err && err.message) || err), line);
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (gl && !isLost()) {
        try {
          if (fbo) gl.deleteFramebuffer(fbo);
          if (tex) gl.deleteTexture(tex);
          if (buffer) gl.deleteBuffer(buffer);
          Object.keys(vsCache).forEach(function (k) { gl.deleteShader(vsCache[k]); });
        } catch (e) { /* ignore */ }
        freeContext(gl);
      }
      fbo = tex = buffer = null; vsCache = {}; readBuf = null;
    }

    return {
      compile: compile,
      supported: function () { return floatOK && !destroyed; },
      destroy: destroy
    };
  };

  // Exposed for testing (not part of the contract).
  NS._probeInternals = {
    cleanExpr: cleanExpr, locate: locate, stripSource: stripSource,
    planInsertion: planInsertion, instrument: instrument
  };
})(window.ShaderSandbox);
