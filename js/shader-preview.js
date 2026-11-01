/* ShaderSandbox — shader preview (raw WebGL, no libraries).
 * Exposes NS.createShaderPreview(canvas, { onFps }).
 * See CONTRACT.md. Classic script, attaches to window.ShaderSandbox.
 */
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) {
  'use strict';

  var CLEAR_COLOR = [0x0f / 255, 0x11 / 255, 0x15 / 255, 1]; // matches --bg
  var MAX_DPR = 2;

  var VS_100 =
    'attribute vec2 a_pos;\n' +
    'void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n';
  var VS_300 =
    '#version 300 es\n' +
    'in vec2 a_pos;\n' +
    'void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n';

  var RE_VERSION_300 = /^[ \t]*#[ \t]*version[ \t]+300[ \t]+es\b/m;
  var RE_PRECISION = /\bprecision\b/;

  // ---------------------------------------------------------------- log parsing
  // Known per-line formats:
  //   ERROR: 0:12: 'foo' : undeclared identifier        (ANGLE / Apple / generic)
  //   WARNING: 0:3: ...
  //   0(12) : error C0000: syntax error ...             (NVIDIA)
  //   0:12(5): error: ...                                (Mesa)
  //   ERROR: 12: ...                                      (some mobile drivers)
  var LOG_PATTERNS = [
    { re: /^\s*(ERROR|WARNING)\s*:\s*-?\d+\s*:\s*(-?\d+)\s*:\s*(.*)$/i, sev: 1, line: 2, msg: 3 },
    { re: /^\s*\d+\s*\(\s*(\d+)\s*\)\s*:\s*(error|warning)\b\s*(?:[A-Z]+\d+\s*)?:?\s*(.*)$/i, line: 1, sev: 2, msg: 3 },
    { re: /^\s*\d+\s*:\s*(\d+)\s*\(\s*\d+\s*\)\s*:\s*(error|warning)\b\s*:?\s*(.*)$/i, line: 1, sev: 2, msg: 3 },
    { re: /^\s*(ERROR|WARNING)\s*:\s*(\d+)\s*:\s*(.*)$/i, sev: 1, line: 2, msg: 3 }
  ];
  var RE_SUMMARY = /^\s*(ERROR|WARNING)?\s*:?\s*\d+\s+compilation errors?/i;

  function parseLog(log) {
    var out = [];
    var unlined = [];
    var seen = {};
    String(log || '').replace(/\0/g, '').split(/\r?\n/).forEach(function (raw) {
      var text = raw.trim();
      if (!text || RE_SUMMARY.test(text)) return;
      for (var i = 0; i < LOG_PATTERNS.length; i++) {
        var p = LOG_PATTERNS[i];
        var m = p.re.exec(text);
        if (m) {
          if (/^warning$/i.test(m[p.sev])) return; // ignore warnings
          var line = Math.max(1, parseInt(m[p.line], 10) || 1);
          // ANGLE emits an empty token for some errors: "'' : Missing main()"
          var msg = (m[p.msg] || '').replace(/^''\s*:\s*/, '').trim() || text;
          var key = line + '|' + msg;
          if (!seen[key]) { seen[key] = 1; out.push({ line: line, message: msg }); }
          return;
        }
      }
      if (/^warning\b/i.test(text)) return;
      unlined.push(text.replace(/^error\s*:\s*/i, ''));
    });
    if (!out.length && unlined.length) {
      unlined.forEach(function (msg) { out.push({ line: 1, message: msg }); });
    }
    return out;
  }

  // Where to insert a fallback precision line: after the leading run of
  // blank / // comment / #version / #extension lines. Returns 0-based index
  // of the line before which we insert.
  function precisionInsertIndex(lines) {
    var idx = 0;
    var lastDirective = -1;
    for (; idx < lines.length; idx++) {
      var l = lines[idx];
      if (/^\s*#\s*(version|extension)\b/.test(l)) { lastDirective = idx; continue; }
      if (/^\s*(\/\/.*)?$/.test(l)) continue;
      break;
    }
    return lastDirective + 1;
  }

  // ---------------------------------------------------------------- factory
  NS.createShaderPreview = function (canvas, options) {
    options = options || {};
    var onFps = typeof options.onFps === 'function' ? options.onFps : null;

    var gl = null;
    var isGL2 = false;
    var attrs = { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: true };
    try { gl = canvas.getContext('webgl2', attrs); isGL2 = !!gl; } catch (e) { gl = null; }
    if (!gl) {
      try { gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); }
      catch (e2) { gl = null; }
    }

    var destroyed = false;
    var contextLost = false;
    var playing = true;
    var rafId = 0;

    // GL resources
    var buffer = null;
    var vsCache = {};          // '100' | '300' -> WebGLShader
    var current = null;        // { program, uniforms }
    var lastGoodSrc = null;
    var lastRequestedSrc = null;

    // time
    var startTime = now();
    var pausedAt = 0;
    var frame = 0;

    // fps
    var fpsFrames = 0;
    var fpsLast = now();
    var fpsSmooth = 0;

    // mouse, stored as fractions of the canvas (0..1, origin bottom-left) so it
    // survives resizes.
    var mouse = { x: 0, y: 0, cx: 0, cy: 0, down: false };

    var resizeObserver = null;

    function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

    // ------------------------------------------------------------ GL setup
    function initResources() {
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      // single full-screen triangle
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      vsCache = {};
      current = null;
    }

    function getVertexShader(is300) {
      var key = is300 ? '300' : '100';
      if (vsCache[key]) return vsCache[key];
      var sh = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(sh, is300 ? VS_300 : VS_100);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        // Should never happen; surface it anyway.
        var log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('Vertex shader failed: ' + log);
      }
      vsCache[key] = sh;
      return sh;
    }

    function compileFragment(src) {
      var sh = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return { shader: sh, errors: [] };
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      var errors = parseLog(log);
      if (!errors.length) errors = [{ line: 1, message: 'Shader compilation failed' }];
      return { shader: null, errors: errors };
    }

    function linkProgram(fs, is300) {
      var vs;
      try { vs = getVertexShader(is300); }
      catch (e) { return { program: null, errors: [{ line: 1, message: String(e.message || e) }] }; }
      var prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, 'a_pos');
      gl.linkProgram(prog);
      gl.detachShader(prog, vs);
      gl.detachShader(prog, fs);
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) return { program: prog, errors: [] };
      var log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      var errors = parseLog(log).map(function (e) { return { line: Math.max(1, e.line || 1), message: e.message }; });
      if (!errors.length) errors = [{ line: 1, message: 'Program link failed' + (log ? ': ' + log.trim() : '') }];
      return { program: null, errors: errors };
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

    // Build a program from source. Returns { ok, errors, program?, uniforms? }.
    function build(src) {
      var is300 = isGL2 && RE_VERSION_300.test(src);
      var res = compileFragment(src);
      var lineShift = null; // 1-based line number of inserted precision line

      if (!res.shader && !RE_PRECISION.test(src)) {
        var lines = src.split('\n');
        var at = precisionInsertIndex(lines);
        lines.splice(at, 0, 'precision mediump float;');
        var retry = compileFragment(lines.join('\n'));
        lineShift = at + 1;
        if (retry.shader) {
          res = retry;
        } else {
          // Report the retry's errors (minus the precision noise), mapped back.
          res = { shader: null, errors: retry.errors.map(function (e) {
            var l = e.line > lineShift ? e.line - 1 : e.line;
            return { line: Math.max(1, l), message: e.message };
          }) };
        }
      }
      if (!res.shader) return { ok: false, errors: res.errors };

      var linked = linkProgram(res.shader, is300);
      gl.deleteShader(res.shader);
      if (!linked.program) {
        if (lineShift !== null) {
          linked.errors = linked.errors.map(function (e) {
            return { line: Math.max(1, e.line > lineShift ? e.line - 1 : e.line), message: e.message };
          });
        }
        return { ok: false, errors: linked.errors };
      }
      return { ok: true, errors: [], program: linked.program, uniforms: lookupUniforms(linked.program) };
    }

    function install(built) {
      if (current && current.program) gl.deleteProgram(current.program);
      current = { program: built.program, uniforms: built.uniforms };
    }

    // ------------------------------------------------------------ uniforms
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
          // samplers / matrices etc.: not ours, leave alone
      }
    }

    function elapsedSeconds() {
      var t = playing ? now() : pausedAt;
      return Math.max(0, (t - startTime) / 1000);
    }

    // The exact uniform values render() sets this frame (shared with
    // getUniformState so the probe engine sees what the preview sees).
    // resolution = drawing-buffer size; mouse/click in px, origin bottom-left.
    function uniformState() {
      var w = 0, h = 0;
      if (gl && !contextLost) { w = gl.drawingBufferWidth; h = gl.drawingBufferHeight; }
      if (!w || !h) { w = canvas.width || 1; h = canvas.height || 1; }
      return {
        time: elapsedSeconds(),
        resolution: [w, h],
        mouse: [mouse.x * w, mouse.y * h],
        click: [mouse.cx * w, mouse.cy * h, mouse.down ? 1 : 0],
        frame: frame
      };
    }

    // ------------------------------------------------------------ sizing
    function targetSize() {
      var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      return {
        w: Math.max(1, Math.round((canvas.clientWidth || 0) * dpr) || 1),
        h: Math.max(1, Math.round((canvas.clientHeight || 0) * dpr) || 1)
      };
    }

    function resize() {
      if (destroyed) return;
      var s = targetSize();
      var changed = canvas.width !== s.w || canvas.height !== s.h;
      if (changed) { canvas.width = s.w; canvas.height = s.h; }
      if (gl && !contextLost) gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      if (changed) requestFrame();
    }

    // ------------------------------------------------------------ render loop
    function render() {
      if (!gl || contextLost) return;
      var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      if (!current) {
        gl.clearColor(CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], CLEAR_COLOR[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      gl.useProgram(current.program);
      applyUniforms(uniformState());
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function applyUniforms(s) {
      var u = current.uniforms;
      var t = s.time;
      var mx = s.mouse[0], my = s.mouse[1];
      var sgn = s.click[2] ? 1 : -1;
      var cx = s.click[0] * sgn, cy = s.click[1] * sgn;
      setU(u.u_time, [t]);
      setU(u.u_resolution, [s.resolution[0], s.resolution[1], 1]);
      setU(u.u_mouse, [mx, my, cx, cy]);
      setU(u.iTime, [t]);
      setU(u.iResolution, [s.resolution[0], s.resolution[1], 1]);
      setU(u.iMouse, [mx, my, cx, cy]);
      setU(u.u_frame, [s.frame]);
      setU(u.iFrame, [s.frame]);
    }

    // ------------------------------------------------------------ offscreen capture
    // Render the current (last good) program at an exact time/size into an RGBA8 FBO and
    // return top-down RGBA pixels. The visible canvas is untouched. Returns null if unavailable.
    var cap = null;   // { fbo, tex, w, h, buf, flip }
    function captureFrame(time, width, height, frameNo) {
      if (!gl || contextLost || !current) return null;
      var maxS = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
      var w = Math.max(1, Math.min(maxS, Math.round(width))), h = Math.max(1, Math.min(maxS, Math.round(height)));
      if (!cap || cap.w !== w || cap.h !== h) {
        releaseCapture();
        cap = { w: w, h: h, tex: gl.createTexture(), fbo: gl.createFramebuffer(),
                buf: new Uint8Array(w * h * 4), flip: new Uint8Array(w * h * 4) };
        gl.bindTexture(gl.TEXTURE_2D, cap.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, cap.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cap.tex, 0);
        var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        if (!ok) { releaseCapture(); return null; }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, cap.fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(current.program);
      applyUniforms({
        time: time,
        resolution: [w, h],
        mouse: [mouse.x * w, mouse.y * h],
        click: [mouse.cx * w, mouse.cy * h, mouse.down ? 1 : 0],
        frame: frameNo || 0
      });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, cap.buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      var row = w * 4;                      // GL rows are bottom-up; flip to top-down
      for (var y = 0; y < h; y++) cap.flip.set(cap.buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      return cap.flip;
    }
    function releaseCapture() {
      if (cap && gl) {
        try { gl.deleteFramebuffer(cap.fbo); gl.deleteTexture(cap.tex); } catch (e) { /* ignore */ }
      }
      cap = null;
    }

    function tick() {
      rafId = 0;
      if (destroyed || contextLost) return;
      var s = targetSize();
      if (canvas.width !== s.w || canvas.height !== s.h) resize();
      render();
      if (playing) {
        frame++;
        fpsFrames++;
        var t = now();
        var dt = t - fpsLast;
        if (dt >= 500) {
          var fps = fpsFrames * 1000 / dt;
          fpsSmooth = fpsSmooth ? fpsSmooth * 0.6 + fps * 0.4 : fps;
          fpsFrames = 0;
          fpsLast = t;
          if (onFps) { try { onFps(Math.round(fpsSmooth * 10) / 10); } catch (e) { /* ignore */ } }
        }
        requestFrame();
      }
    }

    function requestFrame() {
      if (destroyed || contextLost || !gl || rafId) return;
      rafId = window.requestAnimationFrame(tick);
    }

    function cancelFrame() {
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
    }

    // ------------------------------------------------------------ input
    function updateMouse(e) {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      mouse.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      mouse.y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    }
    function onPointerMove(e) {
      updateMouse(e);
      if (!playing) requestFrame();
    }
    function onPointerDown(e) {
      updateMouse(e);
      mouse.down = true;
      mouse.cx = mouse.x; mouse.cy = mouse.y;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (!playing) requestFrame();
    }
    function onPointerUp(e) {
      mouse.down = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (!playing) requestFrame();
    }

    // ------------------------------------------------------------ context loss
    function onContextLost(e) {
      e.preventDefault();
      contextLost = true;
      cancelFrame();
      current = null;
      cap = null;            // GL objects die with the context
      buffer = null;
      vsCache = {};
    }
    function onContextRestored() {
      if (destroyed) return;
      contextLost = false;
      initResources();
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      if (lastGoodSrc !== null) {
        var b = build(lastGoodSrc);
        if (b.ok) install(b);
      }
      if (lastRequestedSrc !== null && lastRequestedSrc !== lastGoodSrc) {
        var b2 = build(lastRequestedSrc);
        if (b2.ok) { install(b2); lastGoodSrc = lastRequestedSrc; }
      }
      requestFrame();
    }

    // ------------------------------------------------------------ public API
    function setSource(src) {
      src = String(src == null ? '' : src);
      if (destroyed) return { ok: false, errors: [{ line: 1, message: 'Preview destroyed' }] };
      if (!gl) return { ok: false, errors: [{ line: 1, message: 'WebGL not supported' }] };
      lastRequestedSrc = src;
      if (contextLost || gl.isContextLost()) {
        return { ok: false, errors: [{ line: 1, message: 'WebGL context lost (will recompile when restored)' }] };
      }
      var b;
      try { b = build(src); }
      catch (e) { return { ok: false, errors: [{ line: 1, message: String((e && e.message) || e) }] }; }
      if (b.ok) {
        install(b);
        lastGoodSrc = src;
        render(); // show the edit immediately (also covers the paused case)
      }
      requestFrame();
      return { ok: b.ok, errors: b.errors };
    }

    function play() {
      if (destroyed || playing) return;
      playing = true;
      startTime += now() - pausedAt;
      fpsFrames = 0;
      fpsLast = now();
      requestFrame();
    }

    function pause() {
      if (destroyed || !playing) return;
      playing = false;
      pausedAt = now();
      fpsSmooth = 0;
      if (onFps) { try { onFps(0); } catch (e) { /* ignore */ } }
    }

    function resetTime() {
      if (destroyed) return;
      var t = now();
      startTime = t;
      if (!playing) pausedAt = t;
      frame = 0;
      requestFrame();
    }

    function destroy() {
      if (destroyed) return;
      cancelFrame();
      destroyed = true;
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      if (gl && !contextLost && !gl.isContextLost()) {
        try {
          if (current && current.program) gl.deleteProgram(current.program);
          Object.keys(vsCache).forEach(function (k) { gl.deleteShader(vsCache[k]); });
          if (buffer) gl.deleteBuffer(buffer);
        } catch (e) { /* ignore */ }
      }
      current = null; vsCache = {}; buffer = null;
    }

    var api = {
      setSource: setSource,
      play: play,
      pause: pause,
      isPlaying: function () { return playing && !destroyed; },
      resetTime: resetTime,
      resize: resize,
      getUniformState: uniformState,
      captureFrame: function (time, w, h, frameNo) { return captureFrame(time, w, h, frameNo); },
      releaseCapture: releaseCapture,
      destroy: destroy
    };

    if (!gl) {
      // No WebGL: keep the API shape, never throw.
      return api;
    }

    // ------------------------------------------------------------ start
    initResources();
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    if (typeof window.ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(function () { resize(); });
      try { resizeObserver.observe(canvas); } catch (e) { /* ignore */ }
    }
    resize();
    render();
    requestFrame();

    return api;
  };

  // Exposed for testing / reuse (not part of the contract).
  NS._parseShaderLog = parseLog;
})(window.ShaderSandbox);
