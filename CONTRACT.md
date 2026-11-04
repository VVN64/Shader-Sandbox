# ShaderSandbox — module contract

Plain HTML/CSS/JS, **no build step, no ES modules** (must work when `index.html` is opened via `file://`).
Every JS file is a classic `<script>` that attaches to a single global namespace:

```js
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) { ... NS.createX = function (...) {...}; })(window.ShaderSandbox);
```

No external libraries / CDNs. Must work in current Firefox and Chrome.

## Files

| File | Owner | Exposes |
|---|---|---|
| `index.html` | shell | layout, loads everything below |
| `css/base.css` | shell | theme variables, layout, floating windows |
| `js/window-manager.js` | shell | `NS.makeFloatingWindow(el, opts)` |
| `js/app.js` | shell | wiring |
| `js/editor.js` + `css/editor.css` | editor agent | `NS.createEditor` |
| `js/glsl.js` (+ `tests/glsl.test.js`) | editor agent | `NS.glsl` — GLSL vocabulary + autocomplete logic (pure, no DOM) |
| `js/shader-preview.js` | preview agent | `NS.createShaderPreview` |
| `js/graph-widget.js` + `css/graph.css` | graph agent | `NS.createGraphWidget` |

## Theme (defined on `:root` in `css/base.css` — use these, don't redefine)

```
--bg: #0f1115;         /* page */
--panel: #161a21;      /* panel / window body */
--panel-2: #1d222b;    /* inputs, headers */
--border: #2a313c;
--text: #d7dce4;
--text-dim: #8a93a3;
--accent: #6cb6ff;
--error: #ff6b6b;
--ok: #5fd38d;
--mono: "JetBrains Mono", "Fira Code", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
--sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--radius: 8px;
```

## `NS.createEditor(container, options)` — `js/editor.js`

`container`: an empty block element that the shell sizes (fills the main area; width/height 100%).
`options`: `{ value: string, onChange: (code) => void }` — `onChange` is called on every edit (shell debounces).

Returns:
```js
{
  getValue(): string,
  setValue(code: string): void,        // does NOT fire onChange
  setErrors(errors: Array<{line:number, message:string}>): void, // 1-based lines in the user's code; [] clears
  focus(): void,
  refresh(): void                       // call after container resize
}
```

## `NS.glsl` — `js/glsl.js`

Pure data + functions, shared by the editor's highlighter and its autocomplete popup.
**Must not touch the DOM** (or `document`/`localStorage`): `tests/glsl.test.js` loads it in Node via `vm` with only
`window.ShaderSandbox` defined. Run `node --test tests/glsl.test.js`. Must load **before** `js/editor.js` in `index.html`.

```js
NS.glsl = {
  KEYWORDS, TYPES, BUILTINS, CONSTANTS, UNIFORM_ALIASES: string[], // vocabulary (highlighter + completion)
  SIGNATURES: { [builtin: string]: string },  // e.g. smoothstep -> "smoothstep(edge0, edge1, x)"
  VARIABLES:  { [name: string]: string },     // u_time / iTime / gl_FragCoord … -> detail, e.g. "float · seconds since start"
  wordAt(text, pos): { start, end, prefix }, // identifier span touching pos; prefix = text[start..pos)
  inComment(text, pos): boolean,    // pos is inside // or /* */
  completionContext(text, pos): null | { start, end, prefix },
    // null in a comment, a number, or for the word directly after '#' or '.' ('#define SMOO' -> SMOO is completable)
  documentIdentifiers(text): string[], // names declared in the code (whole file, not scope-aware)
  suggest(text, pos, { minPrefix?, limit? }):
    null | { start, end, prefix, items: Array<{ text, kind, detail }> }
    // [start,end) = whole word to replace on accept; null = show nothing
}
```

Editor behaviour: popup after 2+ identifier chars or `Ctrl+Space`; ↑/↓ select; `Tab`/`Enter` accept (undo-able,
replaces the whole word); if the highlighted item equals the typed word, `Enter` inserts a newline and `Tab` just
closes; `Escape` closes (and must not reach the document-level Escape handlers); click accepts.

Compact mode (`body.is-compact`): the popup is `position: absolute` inside `.sse-editor` (never `fixed` — the
`.m-shell` transform would offset it), stacked above the PiP card, rows ≥ 44px. Tapping an item accepts without
blurring the textarea (keyboard stays up). `Enter`/Return never accepts — it closes the popup and inserts a newline.
The popup closes on `replaceRangeLive` (dials), `insertText` (accessory bar) and textarea blur (tab switch).

## `NS.createShaderPreview(canvas, options)` — `js/shader-preview.js`

`canvas`: a `<canvas>` whose CSS size is controlled by the shell (it lives in a resizable floating window).
`options`: `{ onFps?: (fps:number) => void }`

Returns:
```js
{
  setSource(fragSrc: string): { ok: boolean, errors: Array<{line:number, message:string}> },
  // compiles; on failure keeps rendering the last good program. Lines are 1-based in fragSrc as given.
  play(): void, pause(): void, isPlaying(): boolean,
  resetTime(): void,
  resize(): void,          // re-reads canvas.clientWidth/Height * devicePixelRatio
  destroy(): void
}
```

Uniforms (Book of Shaders convention): `uniform vec2 u_resolution; uniform vec2 u_mouse; uniform float u_time;`
(also aliases `iTime`, `iResolution` (vec3), `iMouse` (vec4) are set if the user declares them).

## `NS.createGraphWidget(container, options)` — `js/graph-widget.js`

`container`: body element of a floating window (shell sizes it; default ~720×420, resizable).
Self-contained UI (see graph agent brief). Returns `{ resize(): void, destroy(): void }`.

---

# Feature 2 — "Graph this shader value" (right-click a selection in the editor)

Flow: user selects `color` (or `st.x`, `smoothstep(0.1,0.9,st.x)`, …) in the editor → right-click → "Graph `color`".
The app asks the **probe engine** to build an instrumented copy of the shader that captures the value of that
expression right after the statement on that line, renders it along one pixel row into a float target, and reads it
back. The **graph widget** shows each component (1 for float, 2/3/4 for vecN) as its own line, live-updating.

Mapping: graph x ↦ `gl_FragCoord.x = x * u_resolution.x`; the row is `gl_FragCoord.y = rowY * u_resolution.y`
(rowY in 0..1, default 0.5, owned by the graph widget). `u_resolution`, `u_time`, `u_mouse`, frame are copied
from the live preview so the probe sees exactly what the preview sees.

## Preview addition — `js/shader-preview.js`

`preview.getUniformState()` → `{ time:number, resolution:[w,h], mouse:[x,y], click:[cx,cy,down01], frame:number }`
(the exact values the preview would set this frame; px, origin bottom-left).

## `NS.createProbeEngine(options)` — `js/shader-probe.js` (new)

`options`: `{ getUniforms: () => preview.getUniformState() }`. Owns its own hidden offscreen WebGL context.

`engine.compile(source, expr, lineHint)` →
```js
{
  ok: boolean,
  error: string,            // human message when !ok (e.g. "‘foo’ is not in scope on line 12", "can't find ‘color’ anymore", driver log line)
  line: number,             // 1-based line actually used (re-located if code moved)
  type: 'float'|'vec2'|'vec3'|'vec4'|'int'|'ivec2'|...|'bool'|...,
  components: 1..4,
  sample(xmin, xmax, n, rowY): Float32Array[] | null,  // one array per component, length n; x_i = xmin + i*(xmax-xmin)/(n-1) (n==1 → xmin)
  dispose(): void
}
```
`expr` is the selected text, already trimmed by the app. `lineHint` is the 1-based line of the selection start.

## Graph widget additions — `js/graph-widget.js`

`createGraphWidget(container, { onRemoveProbe?: (id) => void, ... })` and on the returned object:

```js
setProbes(probes: Array<{
  id: string,
  label: string,                   // e.g. "color" (the expression)
  type: string,                    // e.g. "vec3"
  components: Array<{ label: string, color: string }>, // e.g. [{label:'color.x', color:'#ff6b6b'}, ...]
  sample: (xmin, xmax, n, rowY) => Float32Array[] | null,
  error?: string                   // if set: show row as stale/errored (dim, title=error), keep last good data if any
}>): void,
invalidate(): void                 // probe data changed (time ticked / mouse moved / recompiled): resample + redraw next rAF
```

---

# Feature 3 — Compact (phone) UI following Apple's Human Interface Guidelines

Desktop layout stays exactly as is. A phone-sized viewport switches to a native-feeling iOS-style shell.

**Compact mode** = `matchMedia('(max-width: 700px), (max-height: 500px) and (pointer: coarse)')`. The shell
(`js/mobile.js`) toggles `body.is-compact` live (rotation / resize) and re-parents existing elements; all compact
CSS is scoped under `body.is-compact` in `css/mobile.css` (graph styles in `css/graph.css` under `.sgw-compact`).
Design tokens: the `--ios-*` and `--safe-*` variables on `:root` in `css/base.css` (dark appearance only).

## Shell structure (owned by `js/mobile.js` + `css/mobile.css`, built in JS on first enter)
- **Navigation bar** (top, translucent material, safe-area aware): title button = current example name + chevron
  (opens example menu/sheet), trailing: Play/Pause, Share (action sheet: Record GIF…, Share PNG…, Save .frag, Open File…).
- **Compile status**: error banner under the nav bar (red, first error, tap → `editor.revealLine(line)`).
- **Tab bar** (bottom, material, safe-area aware, 49pt + inset): Code · Preview · Graph.
- **Code tab**: hosts `#editor`; a **PiP preview card** (the same `#preview-canvas`) floats over it — draggable,
  snaps to the nearest corner with momentum, can be flicked to the side edge to stash; tap → Preview tab.
- **Preview tab**: `#preview-canvas` full-bleed; floating control capsule (play/pause, restart time, time/fps readout).
- **Graph tab**: hosts `#graph-body` (the graph widget root) and calls `graph.setCompact(true)`.
- **Keyboard accessory bar** above the iOS keyboard while the editor is focused (visualViewport-positioned):
  Tab, common GLSL symbols, and a **Graph** button enabled when the editor has a selection (`NS.app.graphSelection()`).
- **Sheets**: bottom sheets with grabber, swipe-down to dismiss, backdrop; used for GIF recorder (`NS.app.mountGifPanel`),
  examples list, action sheets, alerts (replace native `confirm`).
- Desktop chrome (`.topbar`, `.statusbar`, `.fwin` windows, `.gif-panel` popover, `.ctx-menu`) is hidden in compact mode.
- On leaving compact mode everything is moved back and `graph.setCompact(false)`, `preview.resize()`, `editor.refresh()`.

## `NS.app` API used by the shell (implemented in `js/app.js`)
```js
togglePlay(), isPlaying(), resetTime()
onStatus(cb)        // cb({ ok, errors:[{line,message}] }) after every compile; also called immediately with current state
onPlayState(cb)     // cb(isPlaying) whenever it changes; called immediately
exampleNames()      // ['Hello gradient', ...]
currentExample()    // index, or -1 when the code isn't an unmodified example
loadExample(i, force) // returns false (and does nothing) if it would overwrite user-edited code and !force
downloadFrag(), openFile()
sharePNG()          // Web Share sheet with a PNG file if supported, else download; returns Promise
mountGifPanel(container) // renders the GIF recorder UI into container (embedded mode: no auto-download,
                         // result offers "Share…" via Web Share files API or "Save"); returns { unmount() }
graphSelection(expandWord) // graph the editor selection (or word at caret); returns bool
toast(msg, isErr)
editor, preview, graph, windows   // existing objects
```
Editor additions: `editor.insertText(str)` (undo-friendly), `editor.revealLine(n)`, `editor.indentSelection(dir)`.
Autocomplete popup (editor-owned, see `NS.glsl`): absolute inside the editor, above the PiP card, 44px rows, tap-only accept (Return = newline); closed by dial edits, accessory-bar inserts and tab switches — no shell API needed.
Graph addition: `graph.setCompact(bool)`.
