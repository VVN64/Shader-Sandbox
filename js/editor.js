/* ShaderSandbox — GLSL code editor (no external libraries).
 *
 * Technique: a transparent <textarea> sits exactly on top of a syntax-highlighted
 * <pre><code> mirror. The textarea owns input, caret, selection and native undo;
 * the mirror, a line-number gutter and a background "bands" layer (active line,
 * error lines) follow the textarea's scroll position via transforms.
 *
 * NS.createEditor(container, { value, onChange }) ->
 *   { getValue, setValue, setErrors, focus, refresh }
 */
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) {
  'use strict';

  var INDENT = '    ';
  var INDENT_SIZE = INDENT.length;

  function wordSet(str) {
    var o = Object.create(null);
    str.split(/\s+/).forEach(function (w) { if (w) o[w] = true; });
    return o;
  }

  // Vocabulary lives in js/glsl.js (must be loaded before this file). Missing
  // arrays degrade to empty sets rather than throwing at load time.
  var GLSL = NS.glsl || {};
  function glslWords(name) {
    var a = GLSL[name];
    return wordSet(a && a.join ? a.join(' ') : '');
  }
  var KEYWORDS = glslWords('KEYWORDS');
  var TYPES = glslWords('TYPES');
  var BUILTINS = glslWords('BUILTINS');
  var CONSTANTS = glslWords('CONSTANTS');
  var UNIFORM_ALIASES = glslWords('UNIFORM_ALIASES');

  // Single-pass tokenizer. Groups:
  //  1 line comment, 2 block comment (may be unterminated -> runs to end of input),
  //  3 preprocessor / precision statement (stops before a trailing comment),
  //  4 number, 5 identifier.
  var TOKEN_RE = new RegExp(
    '(\\/\\/[^\\n]*)' +
    '|(\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S])))' +
    '|(^[ \\t]*(?:#|precision\\b)[^\\n]*?(?=\\/\\/|\\/\\*|$))' +
    '|(0[xX][0-9a-fA-F]+[uU]?|(?:\\d+\\.\\d*|\\.\\d+|\\d+)(?:[eE][+-]?\\d+)?[fFuU]?)' +
    '|([A-Za-z_]\\w*)',
    'gm'
  );

  function classifyIdent(w) {
    if (KEYWORDS[w]) return 'kw';
    if (TYPES[w]) return 'ty';
    if (BUILTINS[w]) return 'fn';
    if (CONSTANTS[w]) return 'num';
    if (w.charCodeAt(0) === 103 /* g */ && w.indexOf('gl_') === 0) return 'gl';
    if (w.indexOf('u_') === 0 || UNIFORM_ALIASES[w]) return 'uni';
    return null;
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  // Returns an array of HTML strings, one per source line (spans never cross lines).
  function highlightLines(text) {
    var lines = [];
    var cur = '';
    function emit(str, cls) {
      var parts = str.split('\n');
      for (var i = 0; i < parts.length; i++) {
        if (i > 0) { lines.push(cur); cur = ''; }
        var p = parts[i];
        if (!p) continue;
        cur += cls ? '<span class="sse-t-' + cls + '">' + esc(p) + '</span>' : esc(p);
      }
    }
    var last = 0;
    var m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      if (m.index > last) emit(text.slice(last, m.index), null);
      var cls;
      if (m[1] !== undefined || m[2] !== undefined) cls = 'com';
      else if (m[3] !== undefined) cls = 'pre';
      else if (m[4] !== undefined) cls = 'num';
      else cls = classifyIdent(m[5]);
      emit(m[0], cls);
      last = TOKEN_RE.lastIndex;
    }
    if (last < text.length) emit(text.slice(last), null);
    lines.push(cur);
    return lines;
  }

  function lineStartOf(v, pos) { return v.lastIndexOf('\n', pos - 1) + 1; }
  function lineEndOf(v, pos) { var i = v.indexOf('\n', pos); return i < 0 ? v.length : i; }
  function lineIndexAt(v, pos) {
    var n = 0, i = -1;
    while ((i = v.indexOf('\n', i + 1)) !== -1 && i < pos) n++;
    return n; // 0-based
  }
  function leadingWs(s) { return s.match(/^[ \t]*/)[0]; }

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  NS.createEditor = function (container, options) {
    options = options || {};
    var onChange = typeof options.onChange === 'function' ? options.onChange : function () {};

    // ---- DOM -------------------------------------------------------------
    var root = el('div', 'sse-editor');
    var gutter = el('div', 'sse-gutter');
    var gutterInner = el('div', 'sse-gutter-inner');
    var main = el('div', 'sse-main');
    var bands = el('div', 'sse-bands');
    var bandsInner = el('div', 'sse-bands-inner');
    var activeBand = el('div', 'sse-band sse-band-active');
    var errBands = el('div', 'sse-band-errs');
    var hl = el('div', 'sse-hl');
    var pre = el('pre', 'sse-pre sse-text');
    var code = el('code');
    var ta = el('textarea', 'sse-ta sse-text');

    ta.setAttribute('wrap', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('aria-label', 'GLSL fragment shader source');
    pre.setAttribute('aria-hidden', 'true');

    gutter.appendChild(gutterInner);
    bandsInner.appendChild(errBands);
    bandsInner.appendChild(activeBand);
    bands.appendChild(bandsInner);
    pre.appendChild(code);
    hl.appendChild(pre);
    main.appendChild(bands);
    main.appendChild(hl);
    main.appendChild(ta);
    root.appendChild(gutter);
    root.appendChild(main);
    container.appendChild(root);

    // ---- state -----------------------------------------------------------
    var lineHeight = 21;
    var padTop = 10;
    var lineCount = 0;
    var activeLine = -1;           // 1-based
    var errorMap = Object.create(null); // line -> [messages]
    var errorsDirty = true;
    var gutterLineCount = -1;

    ta.value = options.value != null ? String(options.value) : '';

    function measure() {
      var cs = window.getComputedStyle(ta);
      var lh = parseFloat(cs.lineHeight);
      var pt = parseFloat(cs.paddingTop);
      if (lh > 0) lineHeight = lh;
      if (pt >= 0 && !isNaN(pt)) padTop = pt;
    }

    // ---- rendering -------------------------------------------------------
    function render() {
      var text = ta.value;
      var lines = highlightLines(text);
      var n = lines.length;
      var lineCountChanged = n !== lineCount;
      lineCount = n;

      // Inline error messages, appended at the end of their line.
      for (var key in errorMap) {
        var ln = +key;
        if (ln >= 1 && ln <= n) {
          lines[ln - 1] += '<span class="sse-errmsg">    ' + esc(errorMap[key].join('  ·  ')) + '</span>';
        }
      }
      // A trailing newline would otherwise collapse the last (empty) line in <pre>.
      code.innerHTML = lines.join('\n') + '\n';

      if (lineCountChanged || errorsDirty) {
        renderGutter();
        renderErrorBands();
        errorsDirty = false;
      }
    }

    function renderGutter() {
      var n = lineCount;
      root.style.setProperty('--sse-digits', String(Math.max(2, String(n).length)));
      var html = '';
      for (var i = 1; i <= n; i++) {
        var errs = errorMap[i];
        var cls = 'sse-ln';
        if (errs) cls += ' sse-ln-err';
        if (i === activeLine) cls += ' sse-ln-active';
        html += '<div class="' + cls + '"' +
          (errs ? ' title="' + escAttr(errs.join('\n')) + '"' : '') + '>' + i + '</div>';
      }
      gutterInner.innerHTML = html;
      gutterLineCount = n;
    }

    function renderErrorBands() {
      var html = '';
      for (var key in errorMap) {
        var ln = +key;
        if (ln >= 1 && ln <= lineCount) {
          html += '<div class="sse-band sse-band-err" style="top:' +
            (padTop + (ln - 1) * lineHeight) + 'px"></div>';
        }
      }
      errBands.innerHTML = html;
    }

    function caretPos() {
      return ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
    }

    function updateActiveLine(force) {
      var line = lineIndexAt(ta.value, caretPos()) + 1;
      if (line === activeLine && !force) return;
      var kids = gutterInner.children;
      if (activeLine >= 1 && kids[activeLine - 1]) kids[activeLine - 1].classList.remove('sse-ln-active');
      activeLine = line;
      if (kids[line - 1]) kids[line - 1].classList.add('sse-ln-active');
      activeBand.style.top = (padTop + (line - 1) * lineHeight) + 'px';
    }

    function syncScroll() {
      var x = ta.scrollLeft, y = ta.scrollTop;
      pre.style.transform = 'translate(' + (-x) + 'px,' + (-y) + 'px)';
      gutterInner.style.transform = 'translateY(' + (-y) + 'px)';
      bandsInner.style.transform = 'translateY(' + (-y) + 'px)';
    }

    function fullRefresh() {
      measure();
      errorsDirty = true;
      render();
      updateActiveLine(true);
      syncScroll();
    }

    // ---- editing helpers -------------------------------------------------
    // Replace [start,end) with text, preserving native undo where possible,
    // then set the selection to [selStart, selEnd].
    function replaceRange(start, end, text, selStart, selEnd) {
      if (start === end && !text) return;
      if (document.activeElement !== ta) ta.focus();
      ta.setSelectionRange(start, end);
      var ok = false;
      try {
        ok = text ? document.execCommand('insertText', false, text)
                  : document.execCommand('delete', false);
      } catch (e) { ok = false; }
      if (!ok) {
        ta.setRangeText(text, start, end, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (selStart != null) {
        ta.setSelectionRange(selStart, selEnd != null ? selEnd : selStart);
      }
      updateActiveLine();
    }

    // Lines touched by the selection. A selection ending at column 0 of a line
    // does not include that line.
    function selectedBlock() {
      var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
      var e2 = e;
      if (e2 > s && v.charAt(e2 - 1) === '\n') e2--;
      var bs = lineStartOf(v, s);
      var be = lineEndOf(v, e2);
      return { v: v, s: s, e: e, bs: bs, be: be, lines: v.slice(bs, be).split('\n') };
    }

    function indentSelection() {
      var b = selectedBlock();
      var deltas = b.lines.map(function (l) { return (l.length || b.lines.length === 1) ? INDENT_SIZE : 0; });
      var out = b.lines.map(function (l, i) { return deltas[i] ? INDENT + l : l; }).join('\n');
      var total = deltas.reduce(function (a, d) { return a + d; }, 0);
      var ns = b.s === b.bs ? b.bs : b.s + deltas[0];
      replaceRange(b.bs, b.be, out, ns, b.e + total);
    }

    function outdentSelection() {
      var b = selectedBlock();
      var removed = [];
      var out = b.lines.map(function (l) {
        var m = l.match(/^( {1,4}|\t)/);
        var r = m ? m[0].length : 0;
        removed.push(r);
        return l.slice(r);
      }).join('\n');
      var total = removed.reduce(function (a, d) { return a + d; }, 0);
      if (!total) return;
      var ns = b.s - Math.min(removed[0], b.s - b.bs);
      var ne = Math.max(ns, b.e - total);
      replaceRange(b.bs, b.be, out, ns, ne);
    }

    function toggleComment() {
      var b = selectedBlock();
      var nonEmpty = b.lines.filter(function (l) { return l.trim().length > 0; });
      var all = nonEmpty.length > 0 && nonEmpty.every(function (l) { return /^\s*\/\//.test(l); });
      var deltas = [];
      var out;
      if (all) {
        out = b.lines.map(function (l) {
          var m = l.match(/^(\s*)\/\/ ?/);
          if (!m) { deltas.push(0); return l; }
          deltas.push(-(m[0].length - m[1].length));
          return m[1] + l.slice(m[0].length);
        });
      } else {
        var minInd = Infinity;
        (nonEmpty.length ? nonEmpty : b.lines).forEach(function (l) {
          minInd = Math.min(minInd, leadingWs(l).length);
        });
        if (!isFinite(minInd)) minInd = 0;
        out = b.lines.map(function (l) {
          if (!l.trim().length && nonEmpty.length) { deltas.push(0); return l; }
          deltas.push(3);
          return l.slice(0, minInd) + '// ' + l.slice(minInd);
        });
      }
      var total = deltas.reduce(function (a, d) { return a + d; }, 0);
      var ns = b.s === b.bs && b.s !== b.e ? b.bs : Math.max(b.bs, b.s + deltas[0]);
      var ne = b.s === b.e ? ns : Math.max(ns, b.e + total);
      replaceRange(b.bs, b.be, out.join('\n'), ns, ne);
    }

    function insertSoftTab() {
      var v = ta.value, s = ta.selectionStart;
      var col = s - lineStartOf(v, s);
      var n = INDENT_SIZE - (col % INDENT_SIZE);
      var spaces = INDENT.slice(0, n);
      replaceRange(s, ta.selectionEnd, spaces, s + n);
    }

    function newlineWithIndent() {
      var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
      var ls = lineStartOf(v, s);
      var before = v.slice(ls, s);
      var indent = leadingWs(before);
      var after = v.slice(e, lineEndOf(v, e));
      if (/\{\s*$/.test(before)) {
        var closeMatch = after.match(/^[ \t]*\}/);
        if (closeMatch) {
          var ws = closeMatch[0].length - 1;
          var text = '\n' + indent + INDENT + '\n' + indent;
          replaceRange(s, e + ws, text, s + 1 + indent.length + INDENT_SIZE);
        } else {
          var t = '\n' + indent + INDENT;
          replaceRange(s, e, t, s + t.length);
        }
      } else {
        var t2 = '\n' + indent;
        replaceRange(s, e, t2, s + t2.length);
      }
    }

    // Indentation of the line holding the '{' that a '}' typed at pos would close.
    function matchingOpenIndent(v, pos) {
      var depth = 0;
      for (var i = pos - 1; i >= 0; i--) {
        var c = v.charAt(i);
        if (c === '}') depth++;
        else if (c === '{') {
          if (depth === 0) return leadingWs(v.slice(lineStartOf(v, i), i));
          depth--;
        }
      }
      return null;
    }

    function closeBrace() {
      var v = ta.value, s = ta.selectionStart;
      if (s !== ta.selectionEnd) return false;
      var ls = lineStartOf(v, s);
      var before = v.slice(ls, s);
      if (!/^[ \t]+$/.test(before)) return false;
      var target = matchingOpenIndent(v, ls);
      if (target == null || target.length >= before.length) {
        target = before.replace(/( {1,4}|\t)$/, '');
      }
      replaceRange(ls, s, target + '}', ls + target.length + 1);
      return true;
    }

    // ---- events ----------------------------------------------------------
    ta.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      var mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Tab' && !mod && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) { outdentSelection(); return; }
        var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (sel.indexOf('\n') !== -1) indentSelection();
        else insertSoftTab();
        return;
      }
      if (e.key === 'Enter' && !mod && !e.altKey) {
        e.preventDefault();
        newlineWithIndent();
        return;
      }
      if (e.key === '}' && !mod && !e.altKey) {
        if (closeBrace()) e.preventDefault();
        return;
      }
      if (mod && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
        e.preventDefault();
        toggleComment();
        return;
      }
    });

    ta.addEventListener('input', function () {
      render();
      updateActiveLine();
      syncScroll();
      onChange(ta.value);
    });

    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keyup', function () { updateActiveLine(); });
    ta.addEventListener('mouseup', function () { updateActiveLine(); });
    ta.addEventListener('select', function () { updateActiveLine(); });
    ta.addEventListener('focus', function () { root.classList.add('sse-focused'); updateActiveLine(); });
    ta.addEventListener('blur', function () { root.classList.remove('sse-focused'); });
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === ta) updateActiveLine();
    });

    // Clicking a line number selects that line.
    gutter.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var rect = gutter.getBoundingClientRect();
      var y = e.clientY - rect.top + ta.scrollTop - padTop;
      var line = Math.max(0, Math.min(lineCount - 1, Math.floor(y / lineHeight)));
      var v = ta.value;
      var start = 0;
      for (var i = 0; i < line; i++) start = v.indexOf('\n', start) + 1;
      var end = lineEndOf(v, start);
      ta.focus();
      ta.setSelectionRange(start, end < v.length ? end + 1 : end);
      updateActiveLine();
    });

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { syncScroll(); }).observe(main);
    }

    fullRefresh();

    // ---- public API ------------------------------------------------------
    return {
      getValue: function () { return ta.value; },
      setValue: function (codeStr) {
        ta.value = codeStr != null ? String(codeStr) : '';
        render();
        updateActiveLine(true);
        syncScroll();
      },
      setErrors: function (errors) {
        var map = Object.create(null);
        (errors || []).forEach(function (er) {
          if (!er) return;
          var ln = Math.floor(Number(er.line));
          if (!(ln >= 1)) return;
          var msg = String(er.message == null ? '' : er.message).split('\n')[0].trim();
          (map[ln] = map[ln] || []).push(msg || 'error');
        });
        errorMap = map;
        errorsDirty = true;
        render();
        updateActiveLine(true);
      },
      focus: function () { ta.focus(); },
      refresh: fullRefresh,
      /**
       * Current selection. With `expandWord` and an empty selection, grows to the identifier
       * chain under the caret (e.g. `color.rg`, `st.x`). line/column are 1-based (selection start).
       */
      getSelection: function (expandWord) {
        var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        if (s === e && expandWord) {
          var isW = function (c) { return /[\w.]/.test(c || ''); };
          while (s > 0 && isW(v[s - 1])) s--;
          while (e < v.length && isW(v[e])) e++;
          while (s < e && v[s] === '.') s++;
          while (e > s && v[e - 1] === '.') e--;
          if (!/^[A-Za-z_]/.test(v.slice(s, e))) { s = e = ta.selectionStart; }
        }
        var before = v.slice(0, s);
        var line = before.split('\n').length;
        return { text: v.slice(s, e), start: s, end: e, line: line,
                 column: s - before.lastIndexOf('\n') };
      },
      getTextarea: function () { return ta; },
      /** Insert text at the caret / over the selection (undo-friendly). */
      insertText: function (text) {
        text = String(text == null ? '' : text);
        var st = ta.selectionStart, en = ta.selectionEnd;
        replaceRange(st, en, text, st + text.length);
      },
      /**
       * Fast, non-undoable replacement for high-frequency edits (e.g. scrubbing a number with a dial).
       * Keeps focus/keyboard as-is, sets the selection, re-renders and fires onChange once.
       */
      replaceRangeLive: function (start, end, text, selStart, selEnd) {
        var keepTop = ta.scrollTop, keepLeft = ta.scrollLeft;
        ta.setRangeText(String(text), start, end, 'preserve');
        if (selStart != null) ta.setSelectionRange(selStart, selEnd != null ? selEnd : selStart);
        ta.scrollTop = keepTop; ta.scrollLeft = keepLeft;
        render();
        updateActiveLine();
        syncScroll();
        onChange(ta.value);
      },
      /** dir > 0: indent (soft tab when nothing is selected); dir < 0: outdent. */
      indentSelection: function (dir) {
        if (dir < 0) outdentSelection();
        else if (ta.selectionStart === ta.selectionEnd) insertSoftTab();
        else indentSelection();
      },
      /** Select line n (1-based) and scroll it into view, without forcing the keyboard open. */
      revealLine: function (n) {
        var v = ta.value, lines = v.split('\n');
        n = Math.max(1, Math.min(lines.length, Math.floor(n) || 1));
        var start = 0;
        for (var i = 0; i < n - 1; i++) start += lines[i].length + 1;
        ta.setSelectionRange(start, start + lines[n - 1].length);
        var target = padTop + (n - 1) * lineHeight - ta.clientHeight / 3;
        ta.scrollTop = Math.max(0, target);
        ta.scrollLeft = 0;
        syncScroll();
        updateActiveLine(true);
        activeBand.classList.remove('sse-flash');
        void activeBand.offsetWidth;            // restart the flash animation
        activeBand.classList.add('sse-flash');
      }
    };
  };
})(window.ShaderSandbox);
