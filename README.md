# Shader Sandbox

A Book-of-Shaders–style GLSL playground. No build step and no dependencies: open `index.html` in Firefox or Chrome.

- **Editor** (main area): GLSL syntax highlighting. The shader recompiles automatically as you type. Errors appear inline on their line, and the last working shader keeps running in the preview until the error is fixed.
- **Preview** (floating window): a live WebGL render. Drag it by its title bar, resize it from the bottom-right corner, double-click the title bar to collapse it, and click × to hide it (bring it back with the toolbar's Preview button).
  - Uniforms: `u_time`, `u_resolution`, `u_mouse`.
  - Shadertoy-style aliases also work: `iTime`, `iResolution`, `iMouse`, `iFrame`.
- **Graph** (floating window): the plot is on the left; the sidebar on the right lists the equations `y = f(x)` and the value table.
  - Equations are GLSL-like expressions such as `smoothstep(0.,1.,x)`, `pow(x,5.)`, `sin(x*PI+t)` and `mod`/`fract`/`step`.
  - Equations can use other lines as inputs: `y1`, `y2`, … give that line's value at the same x (and t), e.g. `y2 = step(y3, 1.0)`. Loops (y2 uses y3, y3 uses y2) and missing lines are flagged in red. Removing a line rewrites references to it so the others keep their values.
  - Add equations with **+ Add equation** (or the header's +) and remove them with ✕, up to 16. Each has a visibility checkbox.
  - Drag the splitter to resize the sidebar; double-click it to reset.
  - The view defaults to 0→1; switch to −1→1 with the View toggle.
  - The table under the equations lists x across the view's range at the "Step" interval you set.
  - Wheel zooms. **Shift+wheel**, a sideways trackpad swipe, the **scrollbar under the plot**, or ←/→ scroll horizontally. Drag pans. Double-click, Reset or Home returns to the default view. Ctrl+wheel and Alt+wheel zoom only x or only y. The **?** button lists these controls.
  - Equations, view, step and sidebar width are remembered between visits.
- **Graph a shader value:** select a variable or expression in the editor (`color`, `st.x`, `smoothstep(0.1,0.9,st.x)`, …), then right-click and choose **Graph**, or press `Ctrl+G` to graph the selection or the variable under the cursor.
  - A float becomes one line. A `vec2`/`vec3`/`vec4` becomes 2/3/4 separate lines, one per component, each with its own table column.
  - Values are computed on the GPU from your actual shader. The value is captured right after the statement on that line and evaluated along one pixel row: graph x = `gl_FragCoord.x / u_resolution.x`, at the "row y" set in the graph (default 0.5).
  - The lines update live with `u_time` and `u_mouse`, and follow your code as you edit. Click ✕ on a chip to remove it.
  - Shift+right-click opens the browser's normal menu.
- **GIF export:** the toolbar's **▶ GIF** button records a 10-second looping GIF of the current shader and downloads `shader.gif`.
  - Frames are rendered off-screen at exact times, so playback is smooth regardless of how fast your machine is, and the preview keeps running.
  - Options: width (320/480/640), fps (10/20/25), start at the current time or t = 0, colours (32–255) and dithering.
  - Shaders where every pixel changes every frame (like Plasma) make big GIFs. Use 320px, fewer colours or 10 fps to keep them small.
- Window positions, your code and graphed values are saved in `localStorage`.

Shortcuts: `Ctrl+Enter` recompile · `Ctrl+G` graph selection · `Ctrl+P` play/pause · `Ctrl+/` toggle comment · `Tab`/`Shift+Tab` indent/outdent.

Layout: `js/editor.js`, `js/shader-preview.js`, `js/shader-probe.js` (value capture), `js/gif-encoder.js` (GIF writer), `js/graph-widget.js` and `js/window-manager.js` are independent modules on `window.ShaderSandbox`, and `js/app.js` wires them together. See `CONTRACT.md` for each module's API.
