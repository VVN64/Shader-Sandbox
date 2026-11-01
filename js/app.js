/* Wires the editor, live shader preview, floating windows and graph widget together. */
(function (NS) {
  'use strict';

  var CODE_KEY = 'shadersandbox.code';
  var $ = function (id) { return document.getElementById(id); };

  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function save(key, v) { try { localStorage.setItem(key, v); } catch (e) {} }

  var statusEl = $('status'), statusMsg = $('status-msg');
  var initial = load(CODE_KEY) || NS.examples[0].code;

  // ---------- preview ----------
  var canvas = $('preview-canvas');
  var meta = $('preview-meta');
  var lastFps = 0;
  var preview = NS.createShaderPreview(canvas, {
    onFps: function (fps) { lastFps = fps; updateMeta(); }
  });
  function updateMeta() {
    meta.textContent = canvas.width + '×' + canvas.height + ' · ' + Math.round(lastFps) + ' fps' +
      (preview.isPlaying() ? '' : ' · paused');
  }

  // ---------- editor ----------
  var timer = 0;
  var editor = NS.createEditor($('editor'), {
    value: initial,
    onChange: function (code) {
      save(CODE_KEY, code);
      clearTimeout(timer);
      timer = setTimeout(compile, 200);
    }
  });

  function compile() {
    clearTimeout(timer);
    var res = preview.setSource(editor.getValue());
    editor.setErrors(res.errors || []);
    if (res.ok) {
      statusEl.className = 'status status-ok';
      statusEl.textContent = '● compiled';
      statusMsg.textContent = '';
    } else {
      var n = (res.errors || []).length;
      statusEl.className = 'status status-err';
      statusEl.textContent = '● ' + n + ' error' + (n === 1 ? '' : 's');
      var first = res.errors && res.errors[0];
      statusMsg.textContent = first ? 'line ' + first.line + ': ' + first.message : '';
    }
    rebuildProbes(res.ok);
  }

  // ---------- floating windows ----------
  var winPreview = NS.makeFloatingWindow($('win-preview'), {
    id: 'preview', x: -24, y: 60, w: 440, h: 300, minW: 200, minH: 140,
    onResize: function () { preview.resize(); updateMeta(); if (probes && probes.length) graph.invalidate(); },
    onVisibility: function (v) { $('btn-toggle-preview').classList.toggle('is-on', v); }
  });

  var graph = NS.createGraphWidget($('graph-body'), {
    onRemoveProbe: function (id) { removeProbe(id); }
  });
  var winGraph = NS.makeFloatingWindow($('win-graph'), {
    id: 'graph', x: -24, y: -40, w: 820, h: 460, minW: 380, minH: 300,
    onResize: function () { graph.resize(); },
    onVisibility: function (v) { $('btn-toggle-graph').classList.toggle('is-on', v); }
  });
  preview.resize();
  $('btn-toggle-preview').classList.toggle('is-on', !winPreview.isHidden());
  $('btn-toggle-graph').classList.toggle('is-on', !winGraph.isHidden());

  $('btn-toggle-preview').onclick = function () { winPreview.setHidden(!winPreview.isHidden()); };
  $('btn-toggle-graph').onclick = function () { winGraph.setHidden(!winGraph.isHidden()); };

  // ---------- toolbar ----------
  var playBtn = $('btn-play');
  function syncPlay() {
    playBtn.textContent = preview.isPlaying() ? '❚❚ Pause' : '▶ Play';
    updateMeta();
  }
  function togglePlay() {
    if (preview.isPlaying()) preview.pause(); else preview.play();
    syncPlay();
  }
  playBtn.onclick = togglePlay;
  $('btn-reset').onclick = function () { preview.resetTime(); };

  var sel = $('example-select');
  var custom = document.createElement('option');
  custom.value = ''; custom.textContent = '— your code —';
  sel.appendChild(custom);
  NS.examples.forEach(function (ex, i) {
    var o = document.createElement('option');
    o.value = String(i); o.textContent = ex.name;
    sel.appendChild(o);
  });
  sel.value = load(CODE_KEY) ? '' : '0';
  sel.onchange = function () {
    if (sel.value === '') return;
    var cur = editor.getValue();
    var isExample = NS.examples.some(function (ex) { return ex.code === cur; });
    if (!isExample && !confirm('Replace your current code with this example?')) {
      sel.value = ''; return;
    }
    editor.setValue(NS.examples[+sel.value].code);
    save(CODE_KEY, editor.getValue());
    compile();
    editor.focus();
  };

  $('btn-download').onclick = function () {
    var blob = new Blob([editor.getValue()], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shader.frag';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };
  $('file-input').onchange = function (e) {
    var f = e.target.files[0];
    if (!f) return;
    f.text().then(function (txt) {
      editor.setValue(txt);
      save(CODE_KEY, txt);
      sel.value = '';
      compile();
    });
    e.target.value = '';
  };
  $('btn-snapshot').onclick = function () {
    var a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'shader.png';
    a.click();
  };

  // ---------- shader value probes ("graph this variable") ----------
  var PROBE_KEY = 'shadersandbox.probes';
  var VEC_COLOR_SETS = [                                            // x/r, y/g, z/b, w/a — one set per vector probe
    ['#ff6b6b', '#5fd38d', '#6cb6ff', '#c9d1d9'],
    ['#ffb0a8', '#a8ecc2', '#b8dcff', '#8a93a3'],
    ['#d94a4a', '#2fae68', '#3f86d9', '#f0f0f0'],
    ['#ff9e64', '#c3e88d', '#c792ea', '#6b7280']
  ];
  var FLOAT_COLORS = ['#ff9e64', '#f48fb1', '#4dd0e1', '#f2cc60', '#c792ea'];
  var probes = [];      // { id, expr, line, handle, type, components, error }
  var probeSeq = 0;
  var engine = NS.createProbeEngine
    ? NS.createProbeEngine({ getUniforms: function () { return preview.getUniformState(); } })
    : null;

  var toastEl = document.createElement('div');
  toastEl.className = 'toast';
  document.body.appendChild(toastEl);
  var toastTimer = 0;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('is-err', !!isErr);
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, isErr ? 4500 : 2200);
  }

  function componentLabels(expr, n) {
    if (n === 1) return [expr];
    var base = /^[A-Za-z_][\w.]*$/.test(expr) ? expr : '(' + expr + ')';
    return 'xyzw'.slice(0, n).split('').map(function (c) { return base + '.' + c; });
  }
  function floatColor() {
    var used = {};
    probes.forEach(function (p) { if (p.components === 1 && p.color) used[p.color] = 1; });
    for (var i = 0; i < FLOAT_COLORS.length; i++) if (!used[FLOAT_COLORS[i]]) return FLOAT_COLORS[i];
    return FLOAT_COLORS[probes.length % FLOAT_COLORS.length];
  }

  function pushProbes() {
    var vecIdx = 0;
    graph.setProbes(probes.filter(function (p) { return p.handle; }).map(function (p) {
      var labels = componentLabels(p.expr, p.components);
      var set = p.components > 1 ? VEC_COLOR_SETS[(vecIdx++) % VEC_COLOR_SETS.length] : null;
      return {
        id: p.id,
        label: p.expr,
        type: p.type,
        components: labels.map(function (l, i) {
          return { label: l, color: set ? set[i] : p.color };
        }),
        sample: function (x0, x1, n, rowY) { return p.handle ? p.handle.sample(x0, x1, n, rowY) : null; },
        error: p.error || undefined
      };
    }));
    try {
      localStorage.setItem(PROBE_KEY, JSON.stringify(probes.map(function (p) { return { expr: p.expr, line: p.line }; })));
    } catch (e) {}
  }

  function applyCompile(p, res) {
    if (res.ok) {
      if (p.handle && p.handle !== res) p.handle.dispose();
      p.handle = res; p.line = res.line; p.type = res.type;
      p.components = res.components; p.error = null;
    } else {
      p.error = res.error || 'could not graph this value';   // keep last good handle (shows last data, dimmed)
    }
  }

  function rebuildProbes(shaderOk) {
    if (!engine || !probes.length) return;
    var src = editor.getValue();
    probes.forEach(function (p) {
      if (!shaderOk) { if (p.handle) p.error = 'shader has compile errors — showing last good values'; return; }
      applyCompile(p, engine.compile(src, p.expr, p.line));
    });
    probes = probes.filter(function (p) { return p.handle; });
    pushProbes();
    graph.invalidate();
  }

  function cleanExpr(text) {
    return String(text || '').trim().replace(/;+\s*$/, '').trim();
  }

  function addProbe(text, line, quiet) {
    var expr = cleanExpr(text);
    if (!engine) { toast('Graphing shader values is unavailable (probe engine missing).', true); return false; }
    if (!expr) { if (!quiet) toast('Select a variable or expression to graph.', true); return false; }
    if (/\n/.test(expr)) { if (!quiet) toast('Select a single-line expression.', true); return false; }
    var dup = probes.filter(function (p) { return p.expr === expr; })[0];
    if (dup && !dup.error) { if (!quiet) { toast('‘' + expr + '’ is already graphed.'); showGraph(); } return false; }
    var res = engine.compile(editor.getValue(), expr, line);
    if (!res.ok) {
      if (!quiet) toast((res.error || ('Could not graph ‘' + expr + '’')).replace(/ anymore$/, ' on line ' + line), true);
      return false;
    }
    if (dup) { applyCompile(dup, res); pushProbes(); graph.invalidate(); return true; }
    var p = { id: 'p' + (++probeSeq), expr: expr, line: res.line, handle: null };
    p.color = floatColor();
    applyCompile(p, res);
    probes.push(p);
    pushProbes();
    graph.invalidate();
    if (!quiet) {
      showGraph();
      toast('Graphing ' + expr + ' (' + p.type + (p.components > 1 ? ' → ' + p.components + ' lines' : '') + ')');
    }
    return true;
  }

  function removeProbe(id) {
    probes = probes.filter(function (p) {
      if (p.id === id) { if (p.handle) p.handle.dispose(); return false; }
      return true;
    });
    pushProbes();
    graph.invalidate();
  }

  function showGraph() {
    if (winGraph.isHidden()) winGraph.setHidden(false);
    winGraph.setCollapsed(false);
    winGraph.front();
  }

  function graphSelection(expandWord) {
    var s = editor.getSelection(expandWord);
    return addProbe(s.text, s.line);
  }

  // Live updates: the probe re-samples with the preview's time/mouse while playing (~30 Hz).
  var lastProbeTick = 0;
  (function probeLoop(ts) {
    if (probes.length && preview.isPlaying() && !winGraph.isHidden() && ts - lastProbeTick > 33) {
      lastProbeTick = ts;
      graph.invalidate();
    }
    requestAnimationFrame(probeLoop);
  })(0);
  canvas.addEventListener('pointermove', function () {
    if (probes.length && !preview.isPlaying()) graph.invalidate();
  });

  // ---------- editor context menu ----------
  var menuEl = null;
  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }
  function menuItem(icon, html, key, fn) {
    var b = document.createElement('button');
    b.className = 'ctx-item';
    b.innerHTML = '<span class="ctx-icon">' + icon + '</span>' + html +
      (key ? '<span class="ctx-key">' + key + '</span>' : '');
    b.addEventListener('click', function () { closeMenu(); fn(); });
    return b;
  }
  function esc(s) {
    return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  editor.getTextarea().addEventListener('contextmenu', function (e) {
    if (e.shiftKey) return;                        // Shift+right-click → native menu
    var s = editor.getSelection(false);
    var expr = cleanExpr(s.text);
    if (!expr || /\n/.test(expr)) return;          // nothing selected → native menu (paste etc.)
    e.preventDefault();
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    var shown = expr.length > 40 ? expr.slice(0, 39) + '…' : expr;
    menuEl.appendChild(menuItem('📈', 'Graph <code>' + esc(shown) + '</code>', 'Ctrl+G',
      function () { addProbe(expr, s.line); editor.focus(); }));
    menuEl.appendChild(menuItem('⧉', 'Copy', 'Ctrl+C', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(s.text).catch(function () {});
      editor.focus();
    }));
    if (probes.length) {
      menuEl.appendChild(menuItem('✕', 'Clear all graphed values', '', function () {
        probes.slice().forEach(function (p) { removeProbe(p.id); });
      }));
    }
    var sep = document.createElement('div'); sep.className = 'ctx-sep'; menuEl.appendChild(sep);
    var hint = document.createElement('div'); hint.className = 'ctx-hint';
    hint.textContent = 'Vectors become one line per component · Shift+right-click for browser menu';
    menuEl.appendChild(hint);
    document.body.appendChild(menuEl);
    var r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4)) + 'px';
    menuEl.style.top = Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4)) + 'px';
    menuEl.querySelector('.ctx-item').focus();
  });
  document.addEventListener('pointerdown', function (e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('blur', closeMenu);
  editor.getTextarea().addEventListener('scroll', closeMenu);

  // ---------- GIF recorder (10 s, rendered offscreen at exact times) ----------
  var GIF_SECONDS = 10;
  var gif = { panel: null, running: false, cancel: false, url: null, size: 320, fps: 20, fromZero: false, dither: false, colors: 128 };
  try {
    var gs = JSON.parse(localStorage.getItem('shadersandbox.gif') || 'null');
    if (gs) { if ([320, 480, 640].indexOf(gs.size) >= 0) gif.size = gs.size;
              if ([10, 20, 25].indexOf(gs.fps) >= 0) gif.fps = gs.fps; gif.fromZero = !!gs.fromZero; gif.dither = !!gs.dither;
              if ([32, 64, 128, 255].indexOf(gs.colors) >= 0) gif.colors = gs.colors; }
  } catch (e) {}

  function gifDims() {
    var pw = canvas.width || 4, ph = canvas.height || 3;
    var w = gif.size, h = Math.round(w * ph / pw);
    if (h > 640) { h = 640; w = Math.round(h * pw / ph); }
    return { w: Math.max(16, w & ~1), h: Math.max(16, h & ~1) };
  }
  function segment(values, current, fmt, onPick) {
    var seg = document.createElement('div'); seg.className = 'gif-seg';
    values.forEach(function (v) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = fmt(v);
      b.classList.toggle('is-on', v === current);
      b.onclick = function () {
        if (gif.running) return;
        seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on'); onPick(v); refreshGifInfo();
      };
      seg.appendChild(b);
    });
    return seg;
  }
  function gifRow(label, node) {
    var r = document.createElement('div'); r.className = 'gif-row';
    var l = document.createElement('span'); l.className = 'gif-lbl'; l.textContent = label;
    r.appendChild(l); r.appendChild(node); return r;
  }
  function refreshGifInfo() {
    if (!gif.panel) return;
    var d = gifDims();
    gif.panel.querySelector('.gif-info').textContent =
      d.w + '×' + d.h + ' px · ' + (GIF_SECONDS * gif.fps) + ' frames · loops forever';
    try { localStorage.setItem('shadersandbox.gif', JSON.stringify({ size: gif.size, fps: gif.fps, fromZero: gif.fromZero, dither: gif.dither, colors: gif.colors })); } catch (e) {}
  }

  function openGifPanel() {
    if (gif.panel) { closeGifPanel(); return; }
    var p = document.createElement('div');
    p.className = 'gif-panel';
    p.innerHTML =
      '<h3>Record GIF <span class="status-dim">' + GIF_SECONDS + ' s</span>' +
      '<button class="fwin-btn gif-x" title="Close">×</button></h3>' +
      '<div class="gif-opts"></div><div class="gif-info"></div>' +
      '<div class="gif-progress"><div></div></div><div class="gif-status">Ready.</div>' +
      '<div class="gif-result"><img alt="Recorded GIF preview"></div>' +
      '<div class="gif-actions">' +
      '<button class="tb-btn gif-dl" style="display:none">⤓ Download</button>' +
      '<button class="tb-btn gif-primary gif-go">● Record</button></div>';
    var opts = p.querySelector('.gif-opts');
    opts.appendChild(gifRow('Width', segment([320, 480, 640], gif.size, function (v) { return v + 'px'; },
      function (v) { gif.size = v; })));
    opts.appendChild(gifRow('FPS', segment([10, 20, 25], gif.fps, String, function (v) { gif.fps = v; })));
    opts.appendChild(gifRow('Start', segment([false, true], gif.fromZero,
      function (v) { return v ? 't = 0' : 'current time'; }, function (v) { gif.fromZero = v; })));
    var dr = gifRow('Dither', segment([false, true], gif.dither,
      function (v) { return v ? 'on' : 'off'; }, function (v) { gif.dither = v; }));
    dr.title = 'Dithering smooths colour banding but makes files much larger for moving shaders';
    var cr = gifRow('Colours', segment([32, 64, 128, 255], gif.colors, String, function (v) { gif.colors = v; }));
    cr.title = 'Fewer colours = smaller file; more colours = smoother gradients';
    opts.appendChild(cr);
    opts.appendChild(dr);
    p.querySelector('.gif-x').onclick = closeGifPanel;
    p.querySelector('.gif-go').onclick = function () { if (gif.running) gif.cancel = true; else recordGif(); };
    p.querySelector('.gif-dl').onclick = downloadGif;
    document.body.appendChild(p);
    var r = $('btn-gif').getBoundingClientRect();
    p.style.top = (r.bottom + 6) + 'px';
    p.style.left = Math.max(8, Math.min(r.right - p.offsetWidth, innerWidth - p.offsetWidth - 8)) + 'px';
    gif.panel = p;
    $('btn-gif').classList.add('tb-toggle', 'is-on');
    refreshGifInfo();
  }
  function closeGifPanel() {
    if (gif.running) gif.cancel = true;
    if (gif.panel) { gif.panel.remove(); gif.panel = null; }
    $('btn-gif').classList.remove('is-on');
  }
  function gifStatus(msg, frac, isErr) {
    if (!gif.panel) return;
    var st = gif.panel.querySelector('.gif-status');
    st.textContent = msg; st.classList.toggle('is-err', !!isErr);
    if (frac != null) gif.panel.querySelector('.gif-progress > div').style.width = Math.round(frac * 100) + '%';
  }
  function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function downloadGif() {
    if (!gif.url) return;
    var a = document.createElement('a');
    a.href = gif.url; a.download = 'shader.gif';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function recordGif() {
    if (!NS.GifEncoder) { gifStatus('GIF encoder not loaded.', 0, true); return; }
    var d = gifDims(), fps = gif.fps, n = GIF_SECONDS * fps, delay = Math.round(100 / fps);
    var t0 = gif.fromZero ? 0 : preview.getUniformState().time;
    var panel = gif.panel, goBtn = panel.querySelector('.gif-go');
    gif.running = true; gif.cancel = false;
    panel.classList.remove('has-result');
    panel.querySelector('.gif-dl').style.display = 'none';
    panel.querySelectorAll('.gif-seg button').forEach(function (b) { b.disabled = true; });
    goBtn.textContent = '■ Cancel'; goBtn.classList.remove('gif-primary');
    var started = performance.now();

    function finish(msg, isErr) {
      gif.running = false;
      if (!gif.panel) return;
      goBtn.textContent = '● Record'; goBtn.classList.add('gif-primary');
      panel.querySelectorAll('.gif-seg button').forEach(function (b) { b.disabled = false; });
      if (msg) gifStatus(msg, isErr ? 0 : null, isErr);
    }

    (async function () {
      try {
        // 1) palette from frames spread across the clip
        gifStatus('Sampling colours…', 0);
        var samples = [];
        for (var k = 0; k < 16; k++) {
          var fr = preview.captureFrame(t0 + (k + 0.5) * GIF_SECONDS / 16, d.w, d.h, Math.round((k + 0.5) * n / 16));
          if (!fr) { finish('Nothing to record — the shader has no compiled program.', true); return; }
          samples.push(fr.slice());
        }
        var palette = NS.GifEncoder.buildPalette(samples, d.w, d.h, { maxColors: gif.colors });
        samples = null;
        var enc = NS.GifEncoder.create({ width: d.w, height: d.h, delayCs: delay, palette: palette, dither: gif.dither, loop: 0 });

        // 2) render + encode each frame, yielding to keep the UI responsive
        var lastYield = performance.now();
        for (var i = 0; i < n; i++) {
          if (gif.cancel) { finish('Cancelled.'); gifStatus('Cancelled.', 0); return; }
          var px = preview.captureFrame(t0 + i / fps, d.w, d.h, i);
          if (!px) { finish('Rendering failed (WebGL context lost?).', true); return; }
          enc.addFrame(px);
          if (performance.now() - lastYield > 30 || i === n - 1) {
            gifStatus('Frame ' + (i + 1) + ' / ' + n + ' · ' + fmtBytes(enc.byteLength()), (i + 1) / n);
            await tick();
            lastYield = performance.now();
          }
        }
        var bytes = enc.finish();
        preview.releaseCapture();
        if (gif.url) URL.revokeObjectURL(gif.url);
        gif.url = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
        var secs = ((performance.now() - started) / 1000).toFixed(1);
        finish();
        if (!gif.panel) return;
        panel.querySelector('.gif-result img').src = gif.url;
        panel.classList.add('has-result');
        panel.querySelector('.gif-dl').style.display = '';
        gifStatus('Done: ' + d.w + '×' + d.h + ', ' + fmtBytes(bytes.length) + ' in ' + secs + ' s — saved shader.gif' +
          (bytes.length > 8 * 1048576 ? '. Large file: try a smaller width, fewer colours or 10 fps.' : ''), 1);
        downloadGif();
      } catch (err) {
        finish('GIF failed: ' + (err && err.message || err), true);
      }
    })();
  }
  $('btn-gif').onclick = openGifPanel;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && gif.panel && !gif.running) closeGifPanel(); });
  document.addEventListener('pointerdown', function (e) {
    if (gif.panel && !gif.running && !gif.panel.contains(e.target) && !$('btn-gif').contains(e.target)) closeGifPanel();
  }, true);

  // ---------- keyboard ----------
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); compile(); }
    else if (mod && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); togglePlay(); }
    else if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(CODE_KEY, editor.getValue()); compile(); }
    else if (mod && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); graphSelection(true); }
  });

  window.addEventListener('resize', function () { editor.refresh(); });

  compile();
  syncPlay();
  editor.focus();

  // restore previously graphed values
  try {
    (JSON.parse(localStorage.getItem(PROBE_KEY) || '[]') || []).forEach(function (q) {
      if (q && q.expr) addProbe(q.expr, q.line, true);
    });
  } catch (e) {}

  NS.app = { editor: editor, preview: preview, graph: graph, compile: compile,
             openGifPanel: openGifPanel, recordGif: recordGif, gifState: function () { return gif; },
             addProbe: addProbe, removeProbe: removeProbe, probes: function () { return probes; },
             windows: { preview: winPreview, graph: winGraph } };
})(window.ShaderSandbox);
