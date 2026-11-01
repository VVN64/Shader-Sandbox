/* Compact (phone) shell: an iOS-style navigation bar, tab bar, PiP preview, keyboard accessory bar,
 * sheets, action sheets and alerts, built on top of the existing desktop DOM.
 *
 * The shell is created lazily the first time the compact media query matches and the existing
 * #editor / #preview-canvas / #graph-body elements are re-parented into it (and moved back
 * when leaving compact mode). All styling lives in css/mobile.css under body.is-compact.
 * Depends on NS.app (js/app.js); every call into it is guarded. */
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) {
  'use strict';

  var MQ = '(max-width: 700px), (max-height: 500px) and (pointer: coarse)';
  var TAB_KEY = 'shadersandbox.m.tab';
  var PIP_KEY = 'shadersandbox.m.pip';
  var TABS = ['code', 'preview', 'graph'];

  var doc = document;
  var root = doc.documentElement;
  var body = doc.body;

  // ------------------------------------------------------------------ helpers
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { /* storage unavailable */ }
    return null;
  }
  function el(tag, cls, attrs) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }
  function app() { return NS.app || {}; }
  function fn(name) { var a = app(); return typeof a[name] === 'function' ? a[name].bind(a) : null; }
  function call(name) {
    var f = fn(name);
    return f ? f.apply(null, Array.prototype.slice.call(arguments, 1)) : undefined;
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function svg(inner, size, extra) {
    return '<svg class="m-ic" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true" focusable="false"' + (extra || '') + '>' + inner + '</svg>';
  }

  // Original line icons (24x24 grid).
  var IC = {
    code: '<path d="M8.5 7.5 3.8 12l4.7 4.5"/><path d="M15.5 7.5l4.7 4.5-4.7 4.5"/><path d="M13.2 5.2 10.8 18.8"/>',
    preview: '<rect x="2.8" y="5" width="18.4" height="14" rx="3.2"/><path class="m-play-tri" d="M10.2 9.3v5.4l4.5-2.7z"/>',
    graph: '<path d="M4.5 4.5v15h15"/><path d="M7.6 15.2c2.3-8.2 4.2-8.2 5.7-2.6 1.2 4.3 3 2.3 4.7-4.6"/>',
    play: '<path d="M7.5 5.2v13.6a.6.6 0 0 0 .9.5l11-6.8a.6.6 0 0 0 0-1l-11-6.8a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6.2" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.8" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
    share: '<path d="M12 14.8V3.8"/><path d="M8.2 7.4 12 3.6l3.8 3.8"/><path d="M8.6 10H7.2A2.2 2.2 0 0 0 5 12.2v6.6A2.2 2.2 0 0 0 7.2 21h9.6a2.2 2.2 0 0 0 2.2-2.2v-6.6a2.2 2.2 0 0 0-2.2-2.2h-1.4"/>',
    chevron: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    restart: '<path d="M4.6 12a7.4 7.4 0 1 0 2.3-5.4"/><path d="M4.4 4.2v4.4h4.4"/>',
    warn: '<path d="M12 3.6 2.9 19.4h18.2z"/><path d="M12 10v4.2"/><path d="M12 16.9v.1"/>',
    check: '<path d="m4.8 12.6 4.6 4.6 9.8-10.4"/>',
    graphkey: '<path d="M4.5 4.5v15h15"/><path d="M7.6 15.2c2.3-8.2 4.2-8.2 5.7-2.6 1.2 4.3 3 2.3 4.7-4.6"/>'
  };

  // ------------------------------------------------------------------ state
  var mq = null;
  var compact = false;
  var built = false;
  var shell, els = {};
  var tab = 'code';
  var origins = {};            // key -> { node, parent, next }
  var statusState = { ok: true, errors: [] };
  var playing = true;
  var overlays = [];           // open sheets / menus / alerts
  var restH = 0;               // visual-viewport height with no keyboard
  var kbOpen = false;
  var meterRaf = 0;

  // ------------------------------------------------------------------ shell construction
  function build() {
    if (built) return;
    built = true;

    shell = el('div', 'm-shell');
    shell.setAttribute('data-tab', tab);

    // --- navigation bar
    var nav = el('header', 'm-nav');
    var navL = el('div', 'm-nav-side m-nav-lead');
    var titleBtn = el('button', 'm-title', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Examples' });
    titleBtn.innerHTML = '<span class="m-title-text">Untitled Shader</span>' + svg(IC.chevron, 12, ' class="m-chev"');
    var navR = el('div', 'm-nav-side m-nav-trail');
    var playBtn = el('button', 'm-icon-btn m-play', { type: 'button', 'aria-label': 'Pause' });
    var shareBtn = el('button', 'm-icon-btn m-share', { type: 'button', 'aria-label': 'Share', 'aria-haspopup': 'dialog' });
    shareBtn.innerHTML = svg(IC.share, 24);
    navR.appendChild(playBtn); navR.appendChild(shareBtn);
    nav.appendChild(navL); nav.appendChild(titleBtn); nav.appendChild(navR);

    // --- stage with the three views + compile banner
    var stage = el('div', 'm-stage');
    var views = el('div', 'm-views');

    var vCode = el('section', 'm-view m-view-code', { 'data-view': 'code' });
    var codeHost = el('div', 'm-code-host');
    var pipCard = el('div', 'm-pip', { role: 'button', tabindex: '0', 'aria-label': 'Preview. Tap to open full preview' });
    var pipCanvasHost = el('div', 'm-pip-canvas');
    var pipGrab = el('span', 'm-pip-grab', { 'aria-hidden': 'true' });
    pipCard.appendChild(pipCanvasHost); pipCard.appendChild(pipGrab);
    vCode.appendChild(codeHost); vCode.appendChild(pipCard);

    var vPrev = el('section', 'm-view m-view-preview', { 'data-view': 'preview' });
    var prevHost = el('div', 'm-preview-host');
    var capsule = el('div', 'm-capsule', { role: 'group', 'aria-label': 'Playback controls' });
    var capPlay = el('button', 'm-icon-btn m-cap-play', { type: 'button', 'aria-label': 'Pause' });
    var capReset = el('button', 'm-icon-btn m-cap-reset', { type: 'button', 'aria-label': 'Restart time' });
    capReset.innerHTML = svg(IC.restart, 22);
    var capRead = el('div', 'm-readout', { 'aria-live': 'off' });
    capRead.textContent = 't 0.0s · 0 fps';
    capsule.appendChild(capPlay); capsule.appendChild(capReset);
    capsule.appendChild(el('span', 'm-capsule-sep', { 'aria-hidden': 'true' }));
    capsule.appendChild(capRead);
    vPrev.appendChild(prevHost); vPrev.appendChild(capsule);

    var vGraph = el('section', 'm-view m-view-graph', { 'data-view': 'graph' });
    var graphHost = el('div', 'm-graph-host');
    vGraph.appendChild(graphHost);

    views.appendChild(vCode); views.appendChild(vPrev); views.appendChild(vGraph);

    var banner = el('button', 'm-banner', { type: 'button', 'aria-hidden': 'true', tabindex: '-1' });
    banner.innerHTML = svg(IC.warn, 16) + '<span class="m-banner-text"></span>';
    stage.appendChild(views); stage.appendChild(banner);

    // --- keyboard accessory bar
    var kb = el('div', 'm-kbbar', { role: 'toolbar', 'aria-label': 'Code keys' });
    var kbScroll = el('div', 'm-kb-scroll');
    var kbTab = keyButton('Tab', 'Insert tab', 'm-key m-key-wide');
    kbScroll.appendChild(kbTab);
    '{ } ( ) [ ] ; . , = + - * / < > # _'.split(' ').forEach(function (s) {
      var k = keyButton(s, 'Insert ' + s, 'm-key m-key-sym');
      k.setAttribute('data-ins', s);
      kbScroll.appendChild(k);
    });
    var kbGraph = keyButton('', 'Graph selection', 'm-key m-key-act m-key-graph');
    kbGraph.innerHTML = svg(IC.graphkey, 18) + '<span>Graph</span>';
    kbGraph.disabled = true;
    var kbDone = keyButton('Done', 'Dismiss keyboard', 'm-key m-key-act m-key-done');
    var kbTrail = el('div', 'm-kb-trail');
    kbTrail.appendChild(kbGraph); kbTrail.appendChild(kbDone);
    kb.appendChild(kbScroll); kb.appendChild(kbTrail);

    // --- tab bar
    var tabbar = el('nav', 'm-tabbar', { role: 'tablist', 'aria-label': 'Views' });
    var tabLabels = { code: 'Code', preview: 'Preview', graph: 'Graph' };
    var tabBtns = {};
    TABS.forEach(function (t) {
      var b = el('button', 'm-tab', { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-tab': t, id: 'm-tab-' + t });
      b.innerHTML = svg(IC[t], 26) + '<span class="m-tab-label">' + tabLabels[t] + '</span>';
      tabBtns[t] = b;
      tabbar.appendChild(b);
    });

    var layer = el('div', 'm-layer');

    shell.appendChild(nav);
    shell.appendChild(stage);
    shell.appendChild(kb);
    shell.appendChild(tabbar);
    shell.appendChild(layer);
    body.appendChild(shell);

    els = {
      nav: nav, titleBtn: titleBtn, titleText: titleBtn.querySelector('.m-title-text'), playBtn: playBtn,
      shareBtn: shareBtn, stage: stage, views: views, viewCode: vCode, viewPrev: vPrev, viewGraph: vGraph,
      codeHost: codeHost, pip: pipCard, pipCanvas: pipCanvasHost, prevHost: prevHost, graphHost: graphHost,
      capPlay: capPlay, capReset: capReset, capRead: capRead, banner: banner,
      bannerText: banner.querySelector('.m-banner-text'), kb: kb, kbGraph: kbGraph, kbDone: kbDone,
      tabbar: tabbar, tabBtns: tabBtns, layer: layer
    };
    var views_ = { code: vCode, preview: vPrev, graph: vGraph };
    els.viewMap = views_;

    wireNav();
    wireTabs();
    wireKeyboardBar(kbScroll, kbTab);
    wirePip();
    wireStatus();
    syncPlay();
    refreshTitle();
  }

  function keyButton(label, aria, cls) {
    var b = el('button', cls, { type: 'button', 'aria-label': aria, tabindex: '-1' });
    if (label) b.textContent = label;
    // Keep focus in the textarea (and the keyboard up) while a key is pressed.
    b.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    return b;
  }

  // ------------------------------------------------------------------ enter / exit
  function remember(key, node) {
    if (!node) return;
    origins[key] = { node: node, parent: node.parentNode, next: node.nextSibling };
  }
  function restore(key) {
    var o = origins[key];
    if (!o || !o.parent) return;
    var ref = o.next && o.next.parentNode === o.parent ? o.next : null;
    o.parent.insertBefore(o.node, ref);
  }

  function enter() {
    if (compact) return;
    build();
    compact = true;
    remember('editor', doc.getElementById('editor'));
    remember('canvas', doc.getElementById('preview-canvas'));
    remember('graph', doc.getElementById('graph-body'));
    root.classList.add('is-compact-root');
    body.classList.add('is-compact');
    if (origins.editor) els.codeHost.appendChild(origins.editor.node);
    if (origins.graph) els.graphHost.appendChild(origins.graph.node);
    var g = app().graph;
    if (g && typeof g.setCompact === 'function') g.setCompact(true);
    restH = 0;
    body.classList.toggle('has-banner', !statusState.ok && (statusState.errors || []).length > 0);
    setTab(tab, true);
    attachViewport();
    pipLayout(false);
    settle();
  }

  function exit() {
    if (!compact) return;
    compact = false;
    closeAll(true);
    detachViewport();
    stopMeter();
    var ta = textarea();
    if (ta && doc.activeElement === ta) ta.blur();
    restore('graph');
    restore('canvas');
    restore('editor');
    body.classList.remove('is-compact');
    root.classList.remove('is-compact-root');
    shell.classList.remove('kb-open', 'has-kb-bar');
    body.classList.remove('has-banner');
    var g = app().graph;
    if (g && typeof g.setCompact === 'function') g.setCompact(false);
    settle();
  }

  // After re-parenting, let layout happen then tell the widgets their new size.
  function settle() {
    function go() {
      var a = app();
      if (a.preview && a.preview.resize) a.preview.resize();
      if (a.editor && a.editor.refresh) a.editor.refresh();
      if (a.graph && a.graph.resize) a.graph.resize();
    }
    go();
    requestAnimationFrame(function () { go(); setTimeout(go, 120); });
  }

  // ------------------------------------------------------------------ tabs
  function setTab(name, instant) {
    if (TABS.indexOf(name) < 0) name = 'code';
    var prev = tab;
    tab = name;
    store(TAB_KEY, name);
    shell.setAttribute('data-tab', name);
    shell.classList.toggle('no-anim', !!instant);
    TABS.forEach(function (t) {
      var on = t === name;
      els.viewMap[t].classList.toggle('is-active', on);
      els.viewMap[t].setAttribute('aria-hidden', on ? 'false' : 'true');
      if (on) els.viewMap[t].removeAttribute('inert'); else els.viewMap[t].setAttribute('inert', '');
      els.tabBtns[t].setAttribute('aria-selected', on ? 'true' : 'false');
      els.tabBtns[t].tabIndex = on ? 0 : -1;
    });
    // The canvas lives in the PiP card on the Code tab, otherwise in the full-size preview host.
    var canvas = origins.canvas && origins.canvas.node;
    if (canvas) {
      var want = name === 'code' ? els.pipCanvas : els.prevHost;
      if (canvas.parentNode !== want) want.appendChild(canvas);
    }
    if (name !== 'code') {
      var ta = textarea();
      if (ta && doc.activeElement === ta) ta.blur();
    }
    if (name === 'preview') startMeter(); else stopMeter();
    updateKbBar();
    if (instant) { void shell.offsetWidth; shell.classList.remove('no-anim'); }
    settle();
    if (name === 'code' && prev !== 'code') pipLayout(false);
    return name;
  }

  function wireTabs() {
    TABS.forEach(function (t) {
      els.tabBtns[t].addEventListener('click', function () {
        if (tab === t) {
          // Re-tapping the selected tab: iOS scrolls to top; nothing to do here besides haptics-free no-op.
          return;
        }
        setTab(t);
      });
    });
    els.tabbar.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var i = TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
      i = (i + TABS.length) % TABS.length;
      setTab(TABS[i]);
      els.tabBtns[TABS[i]].focus();
    });
  }

  // ------------------------------------------------------------------ navigation bar
  function wireNav() {
    els.titleBtn.addEventListener('click', openExamples);
    els.playBtn.addEventListener('click', togglePlay);
    els.capPlay.addEventListener('click', togglePlay);
    els.capReset.addEventListener('click', function () {
      if (!call('resetTime') && app().preview && app().preview.resetTime) app().preview.resetTime();
      updateMeter();
    });
    els.shareBtn.addEventListener('click', openShare);
  }

  function isPlaying() {
    var f = fn('isPlaying');
    if (f) return !!f();
    var p = app().preview;
    return p && p.isPlaying ? !!p.isPlaying() : true;
  }
  function togglePlay() {
    if (!call('togglePlay')) {
      var b = doc.getElementById('btn-play');
      if (b) b.click();
    }
    syncPlay();
  }
  function syncPlay() {
    if (!built) return;
    playing = isPlaying();
    var label = playing ? 'Pause' : 'Play';
    var icon = svg(playing ? IC.pause : IC.play, 24);
    els.playBtn.innerHTML = icon;
    els.capPlay.innerHTML = svg(playing ? IC.pause : IC.play, 22);
    els.playBtn.setAttribute('aria-label', label);
    els.capPlay.setAttribute('aria-label', label);
  }

  function exampleNames() {
    var f = fn('exampleNames');
    if (f) return f() || [];
    return (NS.examples || []).map(function (e) { return e.name; });
  }
  function currentExample() {
    var f = fn('currentExample');
    if (f) return f();
    var a = app();
    if (!a.editor || !NS.examples) return -1;
    var v = a.editor.getValue();
    for (var i = 0; i < NS.examples.length; i++) if (NS.examples[i].code === v) return i;
    return -1;
  }
  function refreshTitle() {
    if (!built) return;
    var i = currentExample();
    var names = exampleNames();
    var t = i >= 0 && names[i] ? names[i] : 'Untitled Shader';
    if (els.titleText.textContent !== t) els.titleText.textContent = t;
  }

  // ------------------------------------------------------------------ compile status banner
  function wireStatus() {
    var f = fn('onStatus');
    if (f) {
      f(onStatus);
    } else {
      // Fallback: derive from the desktop status bar text.
      var se = doc.getElementById('status'), sm = doc.getElementById('status-msg');
      var read = function () {
        if (!se) return;
        var ok = !/err/.test(se.className);
        var errs = [];
        if (!ok) {
          var m = /line (\d+): (.*)$/.exec(sm ? sm.textContent : '');
          var n = parseInt(se.textContent.replace(/\D+/g, ''), 10) || 1;
          for (var i = 0; i < n; i++) errs.push(i === 0 && m ? { line: +m[1], message: m[2] } : { line: m ? +m[1] : 1, message: '' });
        }
        onStatus({ ok: ok, errors: errs });
      };
      if (typeof MutationObserver === 'function' && se) {
        var mo = new MutationObserver(read);
        mo.observe(se, { attributes: true, childList: true, characterData: true, subtree: true });
        if (sm) mo.observe(sm, { childList: true, characterData: true, subtree: true });
      }
      read();
    }
    var pf = fn('onPlayState');
    if (pf) pf(function () { syncPlay(); });
  }

  function onStatus(s) {
    statusState = s || { ok: true, errors: [] };
    refreshTitle();
    if (!built) return;
    var errs = statusState.errors || [];
    var show = !statusState.ok && errs.length > 0;
    if (show) {
      var first = errs[0];
      var msg = String(first.message || '').split('\n')[0];
      var n = errs.length;
      els.bannerText.textContent = n + (n === 1 ? ' error' : ' errors') + ' · line ' + first.line + (msg ? ': ' + msg : '');
    }
    els.banner.classList.toggle('is-on', show);
    els.banner.setAttribute('aria-hidden', show ? 'false' : 'true');
    els.banner.tabIndex = show ? 0 : -1;
    body.classList.toggle('has-banner', show && compact);
    pipLayout(true);
  }

  function bannerTap() {
    var first = statusState.errors && statusState.errors[0];
    setTab('code');
    var ed = app().editor;
    if (first && ed && typeof ed.revealLine === 'function') ed.revealLine(first.line);
  }

  // ------------------------------------------------------------------ playback capsule readout
  function startMeter() {
    if (meterRaf) return;
    var last = 0;
    (function tick(ts) {
      meterRaf = requestAnimationFrame(tick);
      if (ts - last < 100) return;
      last = ts;
      updateMeter();
    })(0);
  }
  function stopMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = 0;
  }
  function updateMeter() {
    if (!built) return;
    var a = app(), t = 0, fps = 0;
    try { t = a.preview.getUniformState().time || 0; } catch (e) { /* ignore */ }
    var meta = doc.getElementById('preview-meta');
    var m = meta && /(\d+)\s*fps/.exec(meta.textContent);
    if (m) fps = +m[1];
    var txt = 't ' + t.toFixed(1) + 's · ' + (playing ? fps + ' fps' : 'paused');
    if (els.capRead.textContent !== txt) els.capRead.textContent = txt;
  }

  // ------------------------------------------------------------------ keyboard accessory bar + visual viewport
  function textarea() {
    var ed = app().editor;
    return ed && typeof ed.getTextarea === 'function' ? ed.getTextarea() : null;
  }
  function coarse() {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
  }
  var forceKbBar = false;      // tests
  function updateKbBar() {
    if (!built) return;
    var ta = textarea();
    var focused = !!ta && doc.activeElement === ta && tab === 'code';
    var show = focused && (coarse() || forceKbBar);
    var changed = show !== shell.classList.contains('has-kb-bar');
    shell.classList.toggle('has-kb-bar', show);
    var hasSel = !!ta && ta.selectionStart !== ta.selectionEnd;
    if (els.kbGraph.disabled === hasSel) els.kbGraph.disabled = !hasSel;
    if (changed) pipLayout(true);
  }

  function wireKeyboardBar(scroller, tabKey) {
    var ta = textarea();
    function insert(str) {
      var ed = app().editor;
      if (!ed) return;
      if (typeof ed.insertText === 'function') ed.insertText(str);
      else if (ta) {
        ta.setRangeText(str, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    scroller.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      if (b === tabKey) {
        var ed = app().editor;
        var t = textarea();
        if (ed && typeof ed.indentSelection === 'function' && t && t.selectionStart !== t.selectionEnd) ed.indentSelection(1);
        else insert('    ');
      } else if (b.getAttribute('data-ins')) {
        insert(b.getAttribute('data-ins'));
      }
    });
    els.kbGraph.addEventListener('click', function () {
      var r = call('graphSelection', false);
      if (r !== false) setTab('graph');
    });
    els.kbDone.addEventListener('click', function () {
      var t = textarea();
      if (t) t.blur();
    });
    if (ta) {
      ta.addEventListener('focus', function () { updateKbBar(); vvUpdate(); });
      ta.addEventListener('blur', function () { setTimeout(function () { updateKbBar(); vvUpdate(); }, 60); });
      ['select', 'keyup', 'pointerup', 'touchend', 'input'].forEach(function (ev) {
        ta.addEventListener(ev, function () { setTimeout(updateKbBar, 0); });
      });
    }
    doc.addEventListener('selectionchange', function () { if (compact) updateKbBar(); });
  }

  var vvBound = false;
  function attachViewport() {
    if (vvBound) return;
    vvBound = true;
    var vv = window.visualViewport;
    if (vv) { vv.addEventListener('resize', vvUpdate); vv.addEventListener('scroll', vvUpdate); }
    window.addEventListener('resize', vvUpdate);
    window.addEventListener('orientationchange', function () { restH = 0; setTimeout(vvUpdate, 300); });
    vvUpdate();
  }
  function detachViewport() {
    if (!vvBound) return;
    vvBound = false;
    var vv = window.visualViewport;
    if (vv) { vv.removeEventListener('resize', vvUpdate); vv.removeEventListener('scroll', vvUpdate); }
    window.removeEventListener('resize', vvUpdate);
    shell.style.removeProperty('--vvh');
    shell.style.removeProperty('--vvt');
  }
  var lastW = 0;
  function vvUpdate() {
    if (!compact || !built) return;
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight;
    var top = vv ? vv.offsetTop : 0;
    var w = vv ? vv.width : window.innerWidth;
    if (Math.abs(w - lastW) > 40) { restH = 0; lastW = w; }   // orientation / size class change
    var ta = textarea();
    var focused = !!ta && doc.activeElement === ta;
    if (!focused || !restH) restH = Math.max(h, focused ? restH : 0);
    var open = focused && restH - h > 120;
    shell.style.setProperty('--vvh', Math.round(h) + 'px');
    shell.style.setProperty('--vvt', Math.round(top) + 'px');
    if (open !== kbOpen) { kbOpen = open; }
    shell.classList.toggle('kb-open', open);
    if (window.pageYOffset || window.pageXOffset) window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ PiP preview card
  var pip = { c: 'tr', s: null, w: 0, h: 0, vw: 0, vh: 0, x: 0, y: 0, drag: null, laidOut: false };
  var PIP_MARGIN = 16, PIP_GRAB = 32, DECEL = 0.998;

  (function loadPip() {
    var s = store(PIP_KEY);
    if (s && /^[tb][lr]$/.test(s.c)) { pip.c = s.c; pip.s = s.s === 'left' || s.s === 'right' ? s.s : null; }
  })();

  function pipTopInset() { return statusState && !statusState.ok && (statusState.errors || []).length ? 36 : 0; }

  function pipMetrics() {
    var r = els.viewCode.getBoundingClientRect();
    pip.vw = r.width; pip.vh = r.height;
    var w = Math.min(pip.vw * 0.38, pip.vh * 0.46 * 4 / 3, 224);
    pip.w = Math.round(Math.max(w, 104));
    pip.h = Math.round(pip.w * 0.75);                         // 4:3, stable
    els.pip.style.width = pip.w + 'px';
    els.pip.style.height = pip.h + 'px';
  }
  function pipCorner(c) {
    var top = PIP_MARGIN + pipTopInset();
    return {
      x: c.charAt(1) === 'l' ? PIP_MARGIN : pip.vw - pip.w - PIP_MARGIN,
      y: c.charAt(0) === 't' ? top : pip.vh - pip.h - PIP_MARGIN
    };
  }
  function pipRest() {
    var p = pipCorner(pip.c);
    if (pip.s === 'left') p.x = -(pip.w - PIP_GRAB);
    else if (pip.s === 'right') p.x = pip.vw - PIP_GRAB;
    return p;
  }
  function pipSet(x, y, animate) {
    pip.x = x; pip.y = y;
    var s = els.pip.style;
    s.transition = animate && !reducedMotion() ? 'transform .45s var(--ios-ease)' : 'none';
    s.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  }
  function pipClasses() {
    els.pip.classList.toggle('is-stashed', !!pip.s);
    els.pip.classList.toggle('is-stash-left', pip.s === 'left');
    els.pip.classList.toggle('is-stash-right', pip.s === 'right');
    els.pip.setAttribute('aria-label', pip.s ? 'Preview hidden at the edge. Tap to bring it back'
      : 'Preview. Tap to open full preview');
  }
  function pipLayout(animate) {
    if (!built || !compact || pip.drag) return;
    pipMetrics();
    if (!pip.vw || !pip.vh) return;
    var p = pipRest();
    pipSet(p.x, p.y, animate && pip.laidOut);
    pipClasses();
    pip.laidOut = true;
  }

  function wirePip() {
    var card = els.pip;
    card.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || pip.drag) return;
      pip.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: pip.x, y0: pip.y, moved: false,
        samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
      try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      // Freeze mid-flight animations at the current visual position.
      var m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(card.style.transform || '');
      try {
        var cs = getComputedStyle(card).transform;
        if (cs && cs !== 'none') { var mm = new DOMMatrixReadOnly(cs); pip.drag.x0 = mm.m41; pip.drag.y0 = mm.m42; }
        else if (m) { pip.drag.x0 = +m[1]; pip.drag.y0 = +m[2]; }
      } catch (err) { /* ignore */ }
      card.style.transition = 'none';
      card.style.transform = 'translate3d(' + pip.drag.x0 + 'px,' + pip.drag.y0 + 'px,0)';
    });
    card.addEventListener('pointermove', function (e) {
      var d = pip.drag;
      if (!d || e.pointerId !== d.id) return;
      var dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < 6) return;
        d.moved = true;
        card.classList.add('is-dragging');
      }
      var x = clamp(d.x0 + dx, -(pip.w - PIP_GRAB), pip.vw - PIP_GRAB);
      var y = clamp(d.y0 + dy, 4, pip.vh - pip.h - 4);
      pip.x = x; pip.y = y;
      card.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      d.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > 100) d.samples.shift();
    });
    function end(e, cancelled) {
      var d = pip.drag;
      if (!d || e.pointerId !== d.id) return;
      pip.drag = null;
      try { card.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      card.classList.remove('is-dragging');
      if (!d.moved) {
        pipLayout(false);
        if (cancelled) return;
        if (pip.s) { pip.s = null; savePip(); pipLayout(true); }
        else setTab('preview');
        return;
      }
      var vx = 0, vy = 0, s = d.samples, a = s[0], b = s[s.length - 1];
      if (!cancelled && b.t - a.t > 8) { vx = (b.x - a.x) / (b.t - a.t); vy = (b.y - a.y) / (b.t - a.t); }
      var k = DECEL / (1 - DECEL);                                  // UIScrollView-style projection, v in px/ms
      var px = pip.x + clamp(vx * k, -pip.vw, pip.vw);
      var py = pip.y + clamp(vy * k, -pip.vh, pip.vh);
      var cx = px + pip.w / 2;
      var vert = (py + pip.h / 2) < pip.vh / 2 ? 't' : 'b';
      if (cx < 0) { pip.s = 'left'; pip.c = vert + 'l'; }
      else if (cx > pip.vw) { pip.s = 'right'; pip.c = vert + 'r'; }
      else {
        pip.s = null;
        var best = null, bd = Infinity;
        ['tl', 'tr', 'bl', 'br'].forEach(function (c) {
          var p = pipCorner(c), dd = Math.hypot(p.x - px, p.y - py);
          if (dd < bd) { bd = dd; best = c; }
        });
        pip.c = best;
      }
      savePip();
      pipLayout(true);
    }
    card.addEventListener('pointerup', function (e) { end(e, false); });
    card.addEventListener('pointercancel', function (e) { end(e, true); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (pip.s) { pip.s = null; savePip(); pipLayout(true); } else setTab('preview');
      }
    });
    // Block the browser's own touch handling; the canvas must not receive pointer events here.
    card.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(function () { pipLayout(true); });
      ro.observe(els.viewCode);
    }
    els.banner.addEventListener('click', bannerTap);
  }
  function savePip() { store(PIP_KEY, { c: pip.c, s: pip.s }); }

  // ------------------------------------------------------------------ overlays: sheets, menus, alerts
  function inertBackground(on) {
    [els.nav, els.stage, els.kb, els.tabbar].forEach(function (n) {
      if (!n) return;
      if (on) n.setAttribute('inert', ''); else n.removeAttribute('inert');
    });
  }

  function present(entry) {
    var wasEditor = doc.activeElement === textarea();
    entry.restoreFocus = wasEditor ? null : doc.activeElement;
    if (wasEditor) textarea().blur();
    els.layer.appendChild(entry.wrap);
    overlays.push(entry);
    inertBackground(true);
    void entry.wrap.offsetWidth;                         // commit initial styles
    entry.wrap.classList.add('is-in');
    (entry.focusEl || entry.panel).focus({ preventScroll: true });
    return entry;
  }

  function dismiss(entry, immediate) {
    if (!entry || entry.closing) return;
    entry.closing = true;
    var i = overlays.indexOf(entry);
    if (i >= 0) overlays.splice(i, 1);
    if (!overlays.length) inertBackground(false);
    entry.wrap.classList.remove('is-in');
    entry.wrap.classList.add('is-out');
    var done = function () {
      if (entry.done) return;
      entry.done = true;
      if (entry.wrap.parentNode) entry.wrap.parentNode.removeChild(entry.wrap);
      var rf = entry.restoreFocus;
      if (rf && rf.focus && doc.contains(rf)) { try { rf.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      if (entry.onClose) entry.onClose();
    };
    if (immediate || reducedMotion()) { done(); return; }
    entry.panel.addEventListener('transitionend', function te(ev) {
      if (ev.target !== entry.panel) return;
      entry.panel.removeEventListener('transitionend', te);
      done();
    });
    setTimeout(done, 520);
  }
  function closeAll(immediate) {
    overlays.slice().forEach(function (o) { dismiss(o, immediate); });
  }

  function trapKeys(entry) {
    entry.wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); dismiss(entry); return; }
      if (e.key !== 'Tab') return;
      var f = entry.panel.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (doc.activeElement === first || doc.activeElement === entry.panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /** Bottom sheet with grabber, title row, Done button and swipe-down dismissal. */
  function openSheet(opts) {
    var wrap = el('div', 'm-ov m-sheet-wrap');
    var backdrop = el('div', 'm-backdrop');
    var panel = el('div', 'm-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Sheet', tabindex: '-1' });
    var head = el('div', 'm-sheet-head');
    head.appendChild(el('span', 'm-grabber', { 'aria-hidden': 'true' }));
    var row = el('div', 'm-sheet-title-row');
    row.appendChild(el('span', 'm-sheet-spacer'));
    var title = el('h2', 'm-sheet-title'); title.textContent = opts.title || '';
    row.appendChild(title);
    var done = el('button', 'm-sheet-done', { type: 'button' }); done.textContent = 'Done';
    row.appendChild(done);
    head.appendChild(row);
    var content = el('div', 'm-sheet-body');
    if (opts.content) content.appendChild(opts.content);
    panel.appendChild(head); panel.appendChild(content);
    wrap.appendChild(backdrop); wrap.appendChild(panel);

    var entry = { wrap: wrap, panel: panel, content: content, onClose: opts.onClose, focusEl: done,
      close: function () { dismiss(entry); } };
    backdrop.addEventListener('click', entry.close);
    done.addEventListener('click', entry.close);
    trapKeys(entry);

    // swipe-down to dismiss, from the grabber / header
    var drag = null;
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('button')) return;
      drag = { id: e.pointerId, y0: e.clientY, last: [{ t: e.timeStamp, y: e.clientY }], dy: 0 };
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      panel.style.transition = 'none';
      backdrop.style.transition = 'none';
    });
    head.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dy = e.clientY - drag.y0;
      // rubber-band upward drags
      drag.dy = dy < 0 ? -Math.pow(-dy, 0.6) : dy;
      panel.style.transform = 'translate3d(0,' + drag.dy + 'px,0)';
      backdrop.style.opacity = String(clamp(1 - drag.dy / panel.offsetHeight, 0, 1));
      drag.last.push({ t: e.timeStamp, y: e.clientY });
      while (drag.last.length > 2 && e.timeStamp - drag.last[0].t > 100) drag.last.shift();
    });
    function up(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag; drag = null;
      var a = d.last[0], b = d.last[d.last.length - 1];
      var v = b.t - a.t > 8 ? (b.y - a.y) / (b.t - a.t) : 0;      // px/ms
      var far = d.dy > panel.offsetHeight * 0.4;
      if (d.dy > 0 && (v > 0.5 || far)) {
        panel.style.transition = ''; backdrop.style.transition = '';
        panel.style.transform = ''; backdrop.style.opacity = '';
        dismiss(entry);
      } else {
        panel.style.transition = 'transform .35s var(--ios-ease)';
        backdrop.style.transition = 'opacity .35s var(--ios-ease)';
        panel.style.transform = ''; backdrop.style.opacity = '';
        setTimeout(function () { panel.style.transition = ''; backdrop.style.transition = ''; }, 380);
      }
    }
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
    return present(entry);
  }

  /** iOS action sheet: grouped actions plus a separate Cancel button. */
  function openActionSheet(opts) {
    var wrap = el('div', 'm-ov m-as-wrap');
    var backdrop = el('div', 'm-backdrop');
    var panel = el('div', 'm-as', { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Actions', tabindex: '-1' });
    var group = el('div', 'm-as-group');
    if (opts.title || opts.message) {
      var hd = el('div', 'm-as-head');
      if (opts.title) { var t = el('div', 'm-as-title'); t.textContent = opts.title; hd.appendChild(t); }
      if (opts.message) { var m = el('div', 'm-as-msg'); m.textContent = opts.message; hd.appendChild(m); }
      group.appendChild(hd);
    }
    var entry = { wrap: wrap, panel: panel, onClose: opts.onClose, close: function () { dismiss(entry); } };
    var firstBtn = null;
    opts.actions.forEach(function (a) {
      var b = el('button', 'm-as-btn' + (a.style === 'destructive' ? ' is-destructive' : ''), { type: 'button' });
      b.textContent = a.label;
      b.addEventListener('click', function () {
        // Run the handler inside the user gesture (Web Share / file picker need it), then close.
        try { if (a.handler) a.handler(); } finally { dismiss(entry); }
      });
      group.appendChild(b);
      if (!firstBtn) firstBtn = b;
    });
    var cancel = el('button', 'm-as-cancel', { type: 'button' });
    cancel.textContent = opts.cancelLabel || 'Cancel';
    cancel.addEventListener('click', entry.close);
    panel.appendChild(group);
    panel.appendChild(cancel);
    wrap.appendChild(backdrop); wrap.appendChild(panel);
    backdrop.addEventListener('click', entry.close);
    entry.focusEl = firstBtn || cancel;
    trapKeys(entry);
    return present(entry);
  }

  /** iOS alert: centered 270pt dialog. */
  function openAlert(opts) {
    var wrap = el('div', 'm-ov m-alert-wrap');
    var backdrop = el('div', 'm-backdrop');
    var panel = el('div', 'm-alert', { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': opts.title, tabindex: '-1' });
    var txt = el('div', 'm-alert-text');
    var t = el('div', 'm-alert-title'); t.textContent = opts.title; txt.appendChild(t);
    if (opts.message) { var m = el('div', 'm-alert-msg'); m.textContent = opts.message; txt.appendChild(m); }
    var btns = el('div', 'm-alert-btns' + (opts.actions.length > 2 ? ' is-stacked' : ''));
    var entry = { wrap: wrap, panel: panel, onClose: opts.onClose, close: function () { dismiss(entry); } };
    var focusBtn = null;
    opts.actions.forEach(function (a) {
      var b = el('button', 'm-alert-btn' + (a.style === 'destructive' ? ' is-destructive' : '') + (a.bold ? ' is-bold' : ''), { type: 'button' });
      b.textContent = a.label;
      b.addEventListener('click', function () { dismiss(entry); if (a.handler) a.handler(); });
      btns.appendChild(b);
      if (a.bold || !focusBtn) focusBtn = b;
    });
    panel.appendChild(txt); panel.appendChild(btns);
    wrap.appendChild(backdrop); wrap.appendChild(panel);
    entry.focusEl = focusBtn;
    trapKeys(entry);
    return present(entry);
  }

  /** Pull-down menu anchored under a button. items: [{label, checked, handler}] */
  function openMenu(anchor, items, opts) {
    opts = opts || {};
    var wrap = el('div', 'm-ov m-menu-wrap');
    var backdrop = el('div', 'm-backdrop m-backdrop-clear');
    var panel = el('div', 'm-menu', { role: 'menu', 'aria-label': opts.label || 'Menu', tabindex: '-1' });
    var entry = { wrap: wrap, panel: panel, onClose: opts.onClose, close: function () { dismiss(entry); } };
    var current = null;
    items.forEach(function (it) {
      var b = el('button', 'm-menu-item' + (it.checked ? ' is-checked' : ''), { type: 'button', role: 'menuitemradio', 'aria-checked': it.checked ? 'true' : 'false' });
      b.innerHTML = '<span class="m-menu-check">' + (it.checked ? svg(IC.check, 16) : '') + '</span><span class="m-menu-label"></span>';
      b.querySelector('.m-menu-label').textContent = it.label;
      b.addEventListener('click', function () { dismiss(entry); if (it.handler) it.handler(); });
      panel.appendChild(b);
      if (it.checked) current = b;
    });
    wrap.appendChild(backdrop); wrap.appendChild(panel);
    backdrop.addEventListener('click', entry.close);
    trapKeys(entry);
    // position under the anchor, clamped to the shell
    els.layer.appendChild(wrap);
    var sr = shell.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    var pw = Math.min(288, sr.width - 16);
    panel.style.width = pw + 'px';
    var cx = ar.left + ar.width / 2 - sr.left;
    var left = clamp(cx - pw / 2, 8, sr.width - pw - 8);
    var top = ar.bottom - sr.top + 6;
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.maxHeight = Math.max(160, sr.height - top - 16 - (parseFloat(getComputedStyle(shell).getPropertyValue('--safe-bottom')) || 0)) + 'px';
    panel.style.transformOrigin = (cx - left) + 'px 0';
    entry.focusEl = current || panel.firstChild || panel;
    els.layer.removeChild(wrap);
    present(entry);
    if (current) current.scrollIntoView({ block: 'center' });
    return entry;
  }

  // ------------------------------------------------------------------ app-level flows
  function openExamples() {
    var names = exampleNames();
    if (!names.length) return;
    var cur = currentExample();
    els.titleBtn.setAttribute('aria-expanded', 'true');
    openMenu(els.titleBtn, names.map(function (n, i) {
      return { label: n, checked: i === cur, handler: function () { chooseExample(i); } };
    }), { label: 'Examples', onClose: function () { els.titleBtn.setAttribute('aria-expanded', 'false'); } });
  }

  function chooseExample(i) {
    var f = fn('loadExample');
    if (!f) {
      var ed = app().editor;
      if (ed && NS.examples && NS.examples[i]) { ed.setValue(NS.examples[i].code); if (app().compile) app().compile(); }
      refreshTitle();
      return;
    }
    if (f(i, false) === false) {
      openAlert({
        title: 'Replace your code?',
        message: 'Loading “' + (exampleNames()[i] || 'this example') + '” will overwrite your changes.',
        actions: [
          { label: 'Cancel', bold: true },
          { label: 'Replace', style: 'destructive', handler: function () { f(i, true); refreshTitle(); } }
        ]
      });
    } else refreshTitle();
  }

  function openGifSheet() {
    var host = el('div', 'm-gif-host');
    var mount = null;
    var entry = openSheet({
      title: 'Record GIF',
      content: host,
      onClose: function () { try { if (mount && mount.unmount) mount.unmount(); } catch (e) { /* ignore */ } mount = null; }
    });
    var f = fn('mountGifPanel');
    if (f) { try { mount = f(host); } catch (e) { mount = null; } }
    if (!mount) {
      var p = el('p', 'm-empty'); p.textContent = 'GIF recording isn’t available.';
      host.appendChild(p);
    }
    return entry;
  }

  function openShare() {
    var actions = [];
    if (fn('mountGifPanel')) actions.push({ label: 'Record GIF…', handler: function () { setTimeout(openGifSheet, 60); } });
    if (fn('sharePNG')) actions.push({ label: 'Share Image…', handler: function () { call('sharePNG'); } });
    if (fn('downloadFrag')) actions.push({ label: 'Save Shader File', handler: function () { call('downloadFrag'); } });
    if (fn('openFile')) actions.push({ label: 'Open Shader File…', handler: function () { call('openFile'); } });
    if (!actions.length) {
      var b = doc.getElementById('btn-snapshot');
      if (b) actions.push({ label: 'Save Image', handler: function () { b.click(); } });
      var d = doc.getElementById('btn-download');
      if (d) actions.push({ label: 'Save Shader File', handler: function () { d.click(); } });
    }
    return openActionSheet({ actions: actions, cancelLabel: 'Cancel' });
  }

  // ------------------------------------------------------------------ boot
  function onMq() { if (mq.matches) enter(); else exit(); }

  function boot() {
    var saved = store(TAB_KEY);
    if (TABS.indexOf(saved) >= 0) tab = saved;
    try { mq = window.matchMedia(MQ); } catch (e) { return; }
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    onMq();
    // Offline support; never on file://
    try {
      if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ });
        });
      }
    } catch (e) { /* ignore */ }
  }

  NS.mobile = {
    enter: enter,
    exit: exit,
    isCompact: function () { return compact; },
    setTab: function (t) { if (!compact) return t; return setTab(t); },
    currentTab: function () { return tab; },
    openShare: function () { return compact ? openShare() : null; },
    openExamples: function () { return compact ? openExamples() : null; },
    openGif: function () { return compact ? openGifSheet() : null; },
    alert: function (o) { return compact ? openAlert(o) : null; },
    sheet: function (o) { return compact ? openSheet(o) : null; },
    pipState: function () { return { corner: pip.c, stash: pip.s, x: pip.x, y: pip.y, w: pip.w, h: pip.h }; },
    forceKeyboardBar: function (on) { forceKbBar = !!on; updateKbBar(); },
    closeAll: closeAll
  };

  if (NS.app || doc.readyState !== 'loading') boot(); else doc.addEventListener('DOMContentLoaded', boot);
})(window.ShaderSandbox);
