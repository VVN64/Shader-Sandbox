/* Floating window manager: drag by title bar, resize from corner, collapse, hide,
 * bring-to-front, viewport clamping and per-window persistence. */
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) {
  'use strict';

  var zTop = 20;
  var MIN_VISIBLE = 60; // px of the title bar that must stay on screen

  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }

  /**
   * @param {HTMLElement} el  .fwin element
   * @param {{id:string, x:number, y:number, w:number, h:number, minW?:number, minH?:number,
   *          onResize?:Function, onVisibility?:Function}} opts
   *        x/y may be negative = offset from right/bottom edge.
   */
  NS.makeFloatingWindow = function (el, opts) {
    var key = 'shadersandbox.win.' + opts.id;
    var minW = opts.minW || 220, minH = opts.minH || 120;
    var bar = el.querySelector('.fwin-bar');
    var grip = el.querySelector('.fwin-resize');
    var state = store(key) || {};

    var vw = window.innerWidth, vh = window.innerHeight;
    var w = state.w || opts.w, h = state.h || opts.h;
    var x = state.x != null ? state.x : (opts.x < 0 ? vw + opts.x - w : opts.x);
    var y = state.y != null ? state.y : (opts.y < 0 ? vh + opts.y - h : opts.y);
    var collapsed = !!state.collapsed;
    var hidden = !!state.hidden;

    function apply() {
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.classList.toggle('is-collapsed', collapsed);
      el.classList.toggle('is-hidden', hidden);
    }
    function clamp() {
      var vw = window.innerWidth, vh = window.innerHeight;
      w = Math.max(minW, Math.min(w, vw));
      h = Math.max(minH, Math.min(h, vh));
      x = Math.min(Math.max(x, MIN_VISIBLE - w), vw - MIN_VISIBLE);
      y = Math.min(Math.max(y, 0), vh - 30);
    }
    function save() {
      store(key, { x: x, y: y, w: w, h: h, collapsed: collapsed, hidden: hidden });
    }
    function front() {
      if (+el.style.zIndex !== zTop) el.style.zIndex = ++zTop;
      document.querySelectorAll('.fwin.is-active').forEach(function (n) { n.classList.remove('is-active'); });
      el.classList.add('is-active');
    }
    function resized() { if (opts.onResize) opts.onResize(); }

    el.addEventListener('pointerdown', front, true);

    // ---- drag ----
    bar.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('.fwin-btn')) return;
      e.preventDefault();
      var sx = e.clientX - x, sy = e.clientY - y;
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      el.classList.add('is-dragging');
      function move(ev) {
        x = ev.clientX - sx; y = ev.clientY - sy;
        clamp(); apply();
      }
      function up() {
        el.classList.remove('is-dragging');
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        save();
      }
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
    bar.addEventListener('dblclick', function (e) {
      if (!e.target.closest('.fwin-btn')) api.setCollapsed(!collapsed);
    });

    // ---- resize ----
    grip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      var sx = e.clientX, sy = e.clientY, sw = w, sh = h;
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      el.classList.add('is-resizing');
      function move(ev) {
        w = Math.max(minW, Math.min(sw + ev.clientX - sx, window.innerWidth - x));
        h = Math.max(minH, Math.min(sh + ev.clientY - sy, window.innerHeight - y));
        apply(); resized();
      }
      function up() {
        el.classList.remove('is-resizing');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        save();
      }
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });

    // ---- buttons ----
    el.querySelectorAll('.fwin-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.action === 'collapse') api.setCollapsed(!collapsed);
        if (b.dataset.action === 'close') api.setHidden(true);
      });
    });

    window.addEventListener('resize', function () { clamp(); apply(); });

    var api = {
      el: el,
      setHidden: function (v) {
        hidden = !!v; apply(); save();
        if (!hidden) { front(); resized(); }
        if (opts.onVisibility) opts.onVisibility(!hidden);
      },
      isHidden: function () { return hidden; },
      setCollapsed: function (v) {
        collapsed = !!v; apply(); save();
        if (!collapsed) resized();
      },
      front: front,
      reset: function () {
        try { localStorage.removeItem(key); } catch (e) {}
        var vw = window.innerWidth, vh = window.innerHeight;
        w = opts.w; h = opts.h;
        x = opts.x < 0 ? vw + opts.x - w : opts.x;
        y = opts.y < 0 ? vh + opts.y - h : opts.y;
        collapsed = false; clamp(); apply(); resized();
      }
    };

    clamp(); apply();
    if (!hidden) front();
    return api;
  };
})(window.ShaderSandbox);
