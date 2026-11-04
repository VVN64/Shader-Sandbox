# Shader Sandbox

A Book-of-Shaders–style GLSL playground. No build step and no dependencies: open `index.html` in Firefox or Chrome.

- **Editor** (main area): GLSL syntax highlighting. The shader recompiles automatically as you type. Errors appear inline on their line, and the last working shader keeps running in the preview until the error is fixed.
  - Autocomplete: type two letters of a name and a list of matches appears — names declared in your code, the uniforms (`u_time`, `iTime`, …), `gl_FragCoord`/`gl_FragColor`, built-in functions with their signatures, types and keywords. `Ctrl+Space` opens it at any time. ↑/↓ choose, `Tab` or `Enter` insert, `Esc` closes, or click an entry. If you've already typed the whole name, `Enter` starts a new line as usual. No suggestions inside comments or numbers, or for the word right after a `#` or `.` (`#define SMOO` still suggests for `SMOO`).
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
- **On phones** (narrow screens, or landscape phones), the app switches to an iOS-style interface that follows Apple's Human Interface Guidelines:
  - A tab bar with **Code / Preview / Graph**, and a navigation bar with the example picker, play/pause and a **Share** button (Record GIF…, Share Image…, Save / Open Shader File).
  - While you code, the preview floats as a picture-in-picture card. Drag it to any corner, flick it to the side to tuck it away, or tap it to go full screen.
  - Compile errors show as a red banner; tap it to jump to the line.
  - **Code keyboard:** tapping the editor opens a keyboard made for GLSL instead of the phone's own, so more of your code stays visible. Tap anywhere in the code to move the cursor.
    - **ABC**: QWERTY. Tap ⇧ for one capital letter, double-tap it for caps lock, tap again to turn it off.
    - **ƒ(x)**: `sin`, `cos`, `pow`, `smoothstep`, `mix`, `clamp`, `fract`, `length`, `vec3`, … A function key inserts `sin()` with the cursor between the brackets, or wraps the selected text: select `st.x`, tap **sin** → `sin(st.x)`.
    - **123 π**: digits, operators, `π` and `τ` (inserted as numbers), `0.5`/`1.0`/`2.0`, swizzles (`.x`, `.xy`, `.rgb`), `u_time` and `st`.
    - Keys type as soon as you touch them. Hold ⌫, ← or → to repeat. Return starts a new line with the current indent.
  - A symbol bar above the keyboard has Tab, common GLSL symbols, **Graph** for the selected text and **Done** to hide the keyboard. Its keyboard key switches to your phone's own keyboard (for dictation, emoji or other languages) and back; the choice is remembered. A hardware keyboard always works.
  - Autocomplete: the list opens under the word as you type. Tap an entry to insert it; the keyboard stays up. Return always starts a new line and closes the list. Turning a dial, tapping a symbol or switching tabs closes it.
  - **Number dials:** put the cursor on a number (e.g. `1.0`) and two dials appear above the keyboard. Turn **Fine** for small steps (0.01; 1 for whole numbers) and **Coarse** for large ones (0.1; 10 for whole numbers). The code and preview update live as you turn, and **Reset** restores the original value.
  - The graph supports drag to pan, pinch to zoom and double-tap to reset; touch and hold to read values. **Equations** and **Table** switch with a segmented control.
  - Images and GIFs go through the iOS Share sheet (Save Image, Files, AirDrop…).
  - Add it to the Home Screen (Share → Add to Home Screen) to run it full-screen like an app. Offline caching works when the app is served over http(s).
- Window positions, your code and graphed values are saved in `localStorage`.

Shortcuts: `Ctrl+Enter` recompile · `Ctrl+G` graph selection · `Ctrl+P` play/pause · `Ctrl+/` toggle comment · `Ctrl+Space` autocomplete · `Tab`/`Shift+Tab` indent/outdent.

Layout: `js/editor.js`, `js/glsl.js` (GLSL vocabulary and autocomplete), `js/shader-preview.js`, `js/shader-probe.js` (value capture), `js/gif-encoder.js` (GIF writer), `js/graph-widget.js`, `js/window-manager.js` and `js/code-keyboard.js` (phone code keyboard) are independent modules on `window.ShaderSandbox`, `js/app.js` wires them together and `js/mobile.js` builds the phone interface. See `CONTRACT.md` for each module's API. `tests/` holds Node tests for `js/glsl.js` and `js/code-keyboard.js`.

Tests: `node --test tests/glsl.test.js tests/code-keyboard.test.js` (Node 18 or newer, nothing to install).
