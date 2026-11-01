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
