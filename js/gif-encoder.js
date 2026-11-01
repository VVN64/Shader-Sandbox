/* ShaderSandbox — dependency-free animated GIF89a encoder.
 *
 * NS.GifEncoder.buildPalette(frames, width, height, opts?) -> Uint8Array(768)
 *   Median cut (variance-minimising splits, weighted by pixel count) over a
 *   6-bit-per-channel histogram of sampled pixels from the given RGBA frames.
 *   opts.maxColors  (default 255; index 255 stays free for transparency)
 *   opts.sampleStep (default auto, so that <= ~200k pixels are sampled in total)
 *   The returned array also carries a non-standard `colorCount` property with
 *   the number of real colours (the rest of the 256 entries is zero padding).
 *
 * var enc = NS.GifEncoder.create({ width, height, delayCs, palette, dither, loop });
 *   delayCs : frame delay in 1/100 s (integer, 2..65535)
 *   palette : 256-entry RGB table (Uint8Array(768)), e.g. from buildPalette.
 *             Index 255 is reserved for transparency and never used for pixels.
 *   dither  : true (default) = ordered Bayer 8x8, amplitude derived from the
 *             palette's colour spacing; false = none; a number = peak-to-peak
 *             amplitude in 0..255 units.
 *   loop    : 0 (default) = loop forever, n > 0 = repeat n times,
 *             false / null / -1 = no NETSCAPE2.0 extension (play once).
 * enc.addFrame(rgba)  RGBA, top-down rows, length width*height*4 (alpha ignored)
 * enc.finish()        -> Uint8Array with the complete .gif file
 * enc.byteLength()    bytes produced so far
 *
 * Frames after the first are encoded as the bounding rectangle of pixels whose
 * palette index changed, with unchanged pixels written as transparent index 255
 * (disposal 1 = do not dispose). Change detection compares indices, which is
 * stable because ordered dithering depends only on pixel position.
 */
window.ShaderSandbox = window.ShaderSandbox || {};
(function (NS) {
  'use strict';

  var TRANSPARENT = 255;
  var WR = 2, WG = 4, WB = 3;          // colour distance weights
  var MAX_SAMPLES = 200000;

  var BAYER8 = [
     0, 32,  8, 40,  2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44,  4, 36, 14, 46,  6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
     3, 35, 11, 43,  1, 33,  9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47,  7, 39, 13, 45,  5, 37,
    63, 31, 55, 23, 61, 29, 53, 21
  ];

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  function checkSize(width, height, where) {
    if (!isInt(width) || !isInt(height) || width < 1 || height < 1 || width > 65535 || height > 65535) {
      throw new Error(where + ': width and height must be integers in 1..65535 (got ' + width + '×' + height + ')');
    }
  }

  function checkFrame(rgba, width, height, where) {
    if (!rgba || typeof rgba.length !== 'number' || !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray)) {
      throw new Error(where + ': frame must be a Uint8Array or Uint8ClampedArray of RGBA pixels');
    }
    if (rgba.length !== width * height * 4) {
      throw new Error(where + ': frame length ' + rgba.length + ' does not match ' + width + '×' + height + '×4 = ' + (width * height * 4));
    }
  }

  // ------------------------------------------------------------------ palette

  function buildPalette(frames, width, height, opts) {
    opts = opts || {};
    checkSize(width, height, 'GifEncoder.buildPalette');
    if (!frames || typeof frames.length !== 'number' || frames.length === 0) {
      throw new Error('GifEncoder.buildPalette: frames must be a non-empty array of RGBA frames');
    }
    for (var f = 0; f < frames.length; f++) checkFrame(frames[f], width, height, 'GifEncoder.buildPalette (frame ' + f + ')');

    var maxColors = opts.maxColors == null ? 255 : opts.maxColors;
    if (!isInt(maxColors) || maxColors < 1 || maxColors > 256) {
      throw new Error('GifEncoder.buildPalette: maxColors must be an integer in 1..256');
    }
    var npix = width * height;
    var step = opts.sampleStep;
    if (step == null) {
      step = Math.max(1, Math.ceil(npix * frames.length / MAX_SAMPLES));
      if (step > 1 && width % step === 0) step++;     // avoid sampling whole columns only
    } else if (!isInt(step) || step < 1) {
      throw new Error('GifEncoder.buildPalette: sampleStep must be a positive integer');
    }

    // 6-bit histogram with exact colour sums per bucket.
    var HN = 1 << 18;
    var hCount = new Uint32Array(HN), hR = new Uint32Array(HN), hG = new Uint32Array(HN), hB = new Uint32Array(HN);
    for (f = 0; f < frames.length; f++) {
      var px = frames[f];
      for (var p = f % step; p < npix; p += step) {
        var i = p << 2, r = px[i], g = px[i + 1], b = px[i + 2];
        var k = ((r & 0xFC) << 10) | ((g & 0xFC) << 4) | (b >> 2);
        hCount[k]++; hR[k] += r; hG[k] += g; hB[k] += b;
      }
    }

    // Compact non-empty buckets.
    var n = 0, k2;
    for (k2 = 0; k2 < HN; k2++) if (hCount[k2]) n++;
    var eCount = new Float64Array(n), eSum = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    var eMean = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    var eCoord = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    var j = 0;
    for (k2 = 0; k2 < HN; k2++) {
      var c = hCount[k2];
      if (!c) continue;
      eCount[j] = c;
      eSum[0][j] = hR[k2]; eSum[1][j] = hG[k2]; eSum[2][j] = hB[k2];
      eMean[0][j] = hR[k2] / c; eMean[1][j] = hG[k2] / c; eMean[2][j] = hB[k2] / c;
      eCoord[0][j] = k2 >> 12; eCoord[1][j] = (k2 >> 6) & 63; eCoord[2][j] = k2 & 63;
      j++;
    }
    var order = new Int32Array(n), tmp = new Int32Array(n);
    for (j = 0; j < n; j++) order[j] = j;
    var W = [WR, WG, WB];

    function makeBox(lo, hi) {
      var cnt = 0, s = [0, 0, 0], sq = [0, 0, 0];
      for (var q = lo; q < hi; q++) {
        var e = order[q], w = eCount[e];
        cnt += w;
        for (var ch = 0; ch < 3; ch++) { var m = eMean[ch][e]; s[ch] += w * m; sq[ch] += w * m * m; }
      }
      var best = -1, bestErr = -1, total = 0;
      for (ch = 0; ch < 3; ch++) {
        var err = W[ch] * Math.max(0, sq[ch] - s[ch] * s[ch] / cnt);
        total += err;
        // Only axes with more than one distinct bucket coordinate can be split.
        if (err > bestErr && hasSpread(lo, hi, ch)) { bestErr = err; best = ch; }
      }
      return { lo: lo, hi: hi, err: hi - lo > 1 && best >= 0 ? total : -1, axis: best };
    }

    function hasSpread(lo, hi, ch) {
      var co = eCoord[ch], v = co[order[lo]];
      for (var q = lo + 1; q < hi; q++) if (co[order[q]] !== v) return true;
      return false;
    }

    var bucketStart = new Int32Array(65);
    function splitBox(box) {
      var lo = box.lo, hi = box.hi, ch = box.axis, co = eCoord[ch], q, v;
      // Counting sort of order[lo..hi) by the bucket coordinate on the axis.
      bucketStart.fill(0);
      for (q = lo; q < hi; q++) bucketStart[co[order[q]] + 1]++;
      for (v = 0; v < 64; v++) bucketStart[v + 1] += bucketStart[v];
      for (q = lo; q < hi; q++) { var e = order[q]; tmp[lo + bucketStart[co[e]]++] = e; }
      for (q = lo; q < hi; q++) order[q] = tmp[q];
      // Choose the boundary between distinct coordinates that minimises the
      // summed squared error along the axis (maximise sL²/nL + sR²/nR).
      var totC = 0, totS = 0;
      for (q = lo; q < hi; q++) { e = order[q]; totC += eCount[e]; totS += eCount[e] * eMean[ch][e]; }
      var cL = 0, sL = 0, bestQ = -1, bestScore = -Infinity;
      for (q = lo; q < hi - 1; q++) {
        e = order[q];
        cL += eCount[e]; sL += eCount[e] * eMean[ch][e];
        if (co[order[q + 1]] === co[e]) continue;
        var cR = totC - cL, sR = totS - sL;
        var score = sL * sL / cL + sR * sR / cR;
        if (score > bestScore) { bestScore = score; bestQ = q + 1; }
      }
      if (bestQ < 0) return null;
      return [makeBox(lo, bestQ), makeBox(bestQ, hi)];
    }

    var boxes = n ? [makeBox(0, n)] : [];
    while (boxes.length < maxColors) {
      var bi = -1, bestErr = 0;
      for (var t = 0; t < boxes.length; t++) if (boxes[t].err > bestErr) { bestErr = boxes[t].err; bi = t; }
      if (bi < 0) break;
      var parts = splitBox(boxes[bi]);
      if (!parts) { boxes[bi].err = -1; continue; }
      boxes[bi] = parts[0];
      boxes.push(parts[1]);
    }

    var pal = new Uint8Array(768);
    for (t = 0; t < boxes.length; t++) {
      var bx = boxes[t], cnt = 0, sr = 0, sg = 0, sb = 0;
      for (var q = bx.lo; q < bx.hi; q++) {
        var e2 = order[q]; cnt += eCount[e2]; sr += eSum[0][e2]; sg += eSum[1][e2]; sb += eSum[2][e2];
      }
      pal[t * 3] = Math.round(sr / cnt); pal[t * 3 + 1] = Math.round(sg / cnt); pal[t * 3 + 2] = Math.round(sb / cnt);
    }
    pal.colorCount = Math.max(1, boxes.length);
    return pal;
  }

  // Median distance from each palette colour to its nearest neighbour.
  function paletteSpacing(pal, count) {
    if (count < 2) return 16;
    var d = [];
    for (var a = 0; a < count; a++) {
      var best = Infinity;
      for (var b = 0; b < count; b++) {
        if (a === b) continue;
        var dr = pal[a * 3] - pal[b * 3], dg = pal[a * 3 + 1] - pal[b * 3 + 1], db = pal[a * 3 + 2] - pal[b * 3 + 2];
        var dist = dr * dr + dg * dg + db * db;
        if (dist > 0 && dist < best) best = dist;
      }
      if (best < Infinity) d.push(Math.sqrt(best));
    }
    if (!d.length) return 16;
    d.sort(function (x, y) { return x - y; });
    return d[d.length >> 1];
  }

  // ------------------------------------------------------------------ encoder

  function ByteSink() {
    this.chunks = [];
    this.length = 0;
  }
  ByteSink.prototype.push = function (u8) { this.chunks.push(u8); this.length += u8.length; };
  ByteSink.prototype.concat = function () {
    var out = new Uint8Array(this.length), o = 0;
    for (var i = 0; i < this.chunks.length; i++) { out.set(this.chunks[i], o); o += this.chunks[i].length; }
    return out;
  };

  function create(opts) {
    opts = opts || {};
    var width = opts.width, height = opts.height;
    checkSize(width, height, 'GifEncoder.create');
    var delay = opts.delayCs;
    if (!isInt(delay) || delay < 2 || delay > 65535) {
      throw new Error('GifEncoder.create: delayCs must be an integer in 2..65535 (got ' + delay + ')');
    }
    var palette = opts.palette;
    if (!palette || typeof palette.length !== 'number' || palette.length < 768) {
      throw new Error('GifEncoder.create: palette must be a 256-entry RGB table (length 768), e.g. from GifEncoder.buildPalette');
    }
    var colorCount = opts.colorCount != null ? opts.colorCount : (palette.colorCount != null ? palette.colorCount : 255);
    if (!isInt(colorCount) || colorCount < 1) throw new Error('GifEncoder.create: invalid colorCount');
    colorCount = Math.min(colorCount, 255);           // index 255 is the transparent index
    var loop = opts.loop === undefined ? 0 : opts.loop;
    if (loop !== false && loop !== null && loop !== -1 && (!isInt(loop) || loop < 0 || loop > 65535)) {
      throw new Error('GifEncoder.create: loop must be 0 (forever), 1..65535, or false/-1 (no looping)');
    }

    var pal = new Uint8Array(768);
    for (var i = 0; i < 768; i++) pal[i] = palette[i];
    var palR = new Int32Array(colorCount), palG = new Int32Array(colorCount), palB = new Int32Array(colorCount);
    for (i = 0; i < colorCount; i++) { palR[i] = pal[i * 3]; palG[i] = pal[i * 3 + 1]; palB[i] = pal[i * 3 + 2]; }

    // Ordered-dither offsets (same offset on all three channels).
    var dither = opts.dither === undefined ? true : opts.dither;
    var amp = 0;
    if (dither === true) amp = Math.max(8, Math.min(28, Math.round(paletteSpacing(pal, colorCount))));
    else if (typeof dither === 'number' && isFinite(dither) && dither > 0) amp = Math.min(dither, 120);
    else if (dither !== false && dither !== 0 && dither != null) throw new Error('GifEncoder.create: dither must be a boolean or a number');
    var ditherOff = new Int32Array(64);
    for (i = 0; i < 64; i++) ditherOff[i] = Math.round(((BAYER8[i] + 0.5) / 64 - 0.5) * amp);
    var CLO = 64;                                     // clamp table offset
    var clamp = new Uint8Array(256 + 2 * CLO);
    for (i = 0; i < clamp.length; i++) clamp[i] = Math.max(0, Math.min(255, i - CLO));

    // Lazily filled nearest-colour cache on 6 bits per channel (cells are
    // evaluated at their centre). Misses are resolved against a short list of
    // candidate colours per coarse 3-bit cell, also built lazily: a colour is a
    // candidate if its minimum distance to the coarse box does not exceed the
    // smallest maximum distance of any colour to that box.
    var lut = new Int16Array(1 << 18).fill(-1);
    var cand = new Array(512);
    var candTmp = new Uint8Array(256), candMin = new Int32Array(256);
    function candidates(cell) {
      var rlo = (cell >> 6) * 32 + 2, glo = ((cell >> 3) & 7) * 32 + 2, blo = (cell & 7) * 32 + 2;
      var rhi = rlo + 28, ghi = glo + 28, bhi = blo + 28, c, n = 0, limit = 0x7FFFFFFF;
      for (c = 0; c < colorCount; c++) {
        var r = palR[c], g = palG[c], b = palB[c];
        var nr = r < rlo ? rlo - r : (r > rhi ? r - rhi : 0);
        var ng = g < glo ? glo - g : (g > ghi ? g - ghi : 0);
        var nb = b < blo ? blo - b : (b > bhi ? b - bhi : 0);
        var fr = r - rlo > rhi - r ? r - rlo : rhi - r;
        var fg = g - glo > ghi - g ? g - glo : ghi - g;
        var fb = b - blo > bhi - b ? b - blo : bhi - b;
        var far = WR * fr * fr + WG * fg * fg + WB * fb * fb;
        if (far < limit) limit = far;
        candMin[c] = WR * nr * nr + WG * ng * ng + WB * nb * nb;
      }
      for (c = 0; c < colorCount; c++) if (candMin[c] <= limit) candTmp[n++] = c;
      return (cand[cell] = candTmp.slice(0, n));
    }
    function nearest(key) {
      var r6 = key >> 12, g6 = (key >> 6) & 63, b6 = key & 63;
      var cell = ((r6 >> 3) << 6) | ((g6 >> 3) << 3) | (b6 >> 3);
      var list = cand[cell] || candidates(cell);
      var r = (r6 << 2) + 2, g = (g6 << 2) + 2, b = (b6 << 2) + 2;
      var best = 0, bestD = 0x7FFFFFFF;
      for (var j = 0; j < list.length; j++) {
        var c = list[j], dr = palR[c] - r, dg = palG[c] - g, db = palB[c] - b;
        var d = WR * dr * dr + WG * dg * dg + WB * db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      lut[key] = best;
      return best;
    }

    var npix = width * height;
    var cur = new Uint8Array(npix), prev = new Uint8Array(npix);
    var rect = new Uint8Array(npix);
    var lzwOut = new Uint8Array(Math.ceil(npix * 1.52) + 64);
    var dict = new Uint32Array(1 << 20);              // (generation << 12) | code
    var gen = 0;

    var sink = new ByteSink();
    var frameCount = 0, finished = false, result = null;

    // Header, logical screen descriptor, global colour table, loop extension.
    (function () {
      var hasLoop = !(loop === false || loop === null || loop === -1);
      var h = new Uint8Array(13 + 768 + (hasLoop ? 19 : 0)), o = 0;
      var sig = 'GIF89a';
      for (var s = 0; s < 6; s++) h[o++] = sig.charCodeAt(s);
      h[o++] = width & 255; h[o++] = width >> 8;
      h[o++] = height & 255; h[o++] = height >> 8;
      h[o++] = 0xF7;                                  // GCT present, 8-bit colour res, 256 entries
      h[o++] = 0;                                     // background colour index
      h[o++] = 0;                                     // pixel aspect ratio
      h.set(pal, o); o += 768;
      if (hasLoop) {
        h[o++] = 0x21; h[o++] = 0xFF; h[o++] = 11;
        var app = 'NETSCAPE2.0';
        for (s = 0; s < 11; s++) h[o++] = app.charCodeAt(s);
        h[o++] = 3; h[o++] = 1; h[o++] = loop & 255; h[o++] = (loop >> 8) & 255; h[o++] = 0;
      }
      sink.push(h);
    })();

    function quantize(rgba) {
      var p = 0, i4 = 0;
      for (var y = 0; y < height; y++) {
        var row = (y & 7) << 3;
        for (var x = 0; x < width; x++, p++, i4 += 4) {
          var off = ditherOff[row | (x & 7)] + CLO;
          var key = ((clamp[rgba[i4] + off] & 0xFC) << 10) |
                    ((clamp[rgba[i4 + 1] + off] & 0xFC) << 4) |
                    (clamp[rgba[i4 + 2] + off] >> 2);
          var v = lut[key];
          cur[p] = v >= 0 ? v : nearest(key);
        }
      }
    }

    // Variable-width LZW (min code size 8) of src[0..n) into lzwOut; returns byte count.
    function lzw(src, n) {
      var CLEAR = 256, EOI = 257;
      var size = 9, next = 258, out = lzwOut, o = 0, acc = 0, bits = 0;
      gen++;
      if (gen > 0xFFFFF) { dict.fill(0); gen = 1; }
      var stamp = gen << 12;

      acc = CLEAR; bits = size;
      var prefix = src[0];
      for (var i = 1; i < n; i++) {
        var k = src[i];
        var key = (prefix << 8) | k;
        var e = dict[key];
        if ((e >>> 12) === gen) { prefix = e & 4095; continue; }
        acc |= prefix << bits; bits += size;
        while (bits >= 8) { out[o++] = acc & 255; acc >>>= 8; bits -= 8; }
        if (next < 4096) {
          dict[key] = (stamp | next) >>> 0;
          next++;
          if (next > (1 << size) && size < 12) size++;
        } else {
          acc |= CLEAR << bits; bits += size;
          while (bits >= 8) { out[o++] = acc & 255; acc >>>= 8; bits -= 8; }
          size = 9; next = 258;
          gen++;
          if (gen > 0xFFFFF) { dict.fill(0); gen = 1; }
          stamp = gen << 12;
        }
        prefix = k;
      }
      acc |= prefix << bits; bits += size;
      while (bits >= 8) { out[o++] = acc & 255; acc >>>= 8; bits -= 8; }
      // The decoder adds an entry after this code and may widen before EOI.
      if (next < 4096) { next++; if (next > (1 << size) && size < 12) size++; }
      acc |= EOI << bits; bits += size;
      while (bits > 0) { out[o++] = acc & 255; acc >>>= 8; bits -= 8; }
      return o;
    }

    function writeFrame(left, top, w, h, transparent, src, n) {
      var raw = lzw(src, n);
      var blocks = Math.ceil(raw / 255);
      var buf = new Uint8Array(8 + 10 + 1 + raw + blocks + 1), o = 0;
      // Graphic Control Extension: disposal 1 (do not dispose), optional transparency.
      buf[o++] = 0x21; buf[o++] = 0xF9; buf[o++] = 4;
      buf[o++] = (1 << 2) | (transparent ? 1 : 0);
      buf[o++] = delay & 255; buf[o++] = delay >> 8;
      buf[o++] = transparent ? TRANSPARENT : 0;
      buf[o++] = 0;
      // Image descriptor (no local colour table, not interlaced).
      buf[o++] = 0x2C;
      buf[o++] = left & 255; buf[o++] = left >> 8;
      buf[o++] = top & 255; buf[o++] = top >> 8;
      buf[o++] = w & 255; buf[o++] = w >> 8;
      buf[o++] = h & 255; buf[o++] = h >> 8;
      buf[o++] = 0;
      buf[o++] = 8;                                   // LZW minimum code size
      for (var s = 0; s < raw; s += 255) {
        var len = Math.min(255, raw - s);
        buf[o++] = len;
        buf.set(lzwOut.subarray(s, s + len), o); o += len;
      }
      buf[o++] = 0;                                   // block terminator
      sink.push(buf);
    }

    function addFrame(rgba) {
      if (finished) throw new Error('GifEncoder: addFrame() called after finish()');
      checkFrame(rgba, width, height, 'GifEncoder.addFrame');
      quantize(rgba);

      if (frameCount === 0) {
        writeFrame(0, 0, width, height, false, cur, npix);
      } else {
        // Bounding rectangle of changed indices.
        var minX = width, maxX = -1, minY = -1, maxY = -1, p = 0, x, y;
        for (y = 0; y < height; y++) {
          var rowStart = p, rowEnd = p + width;
          for (; p < rowEnd; p++) if (cur[p] !== prev[p]) break;
          if (p === rowEnd) continue;
          var fx = p - rowStart;
          var lx = width - 1;
          while (cur[rowStart + lx] === prev[rowStart + lx]) lx--;
          if (fx < minX) minX = fx;
          if (lx > maxX) maxX = lx;
          if (minY < 0) minY = y;
          maxY = y;
          p = rowEnd;
        }
        if (maxX < 0) {
          rect[0] = TRANSPARENT;
          writeFrame(0, 0, 1, 1, true, rect, 1);
        } else {
          var rw = maxX - minX + 1, rh = maxY - minY + 1, o = 0;
          for (y = minY; y <= maxY; y++) {
            var base = y * width + minX;
            for (x = 0; x < rw; x++) {
              var c = cur[base + x];
              rect[o++] = c === prev[base + x] ? TRANSPARENT : c;
            }
          }
          writeFrame(minX, minY, rw, rh, true, rect, rw * rh);
        }
      }
      var t = prev; prev = cur; cur = t;
      frameCount++;
    }

    function finish() {
      if (finished) return result;
      if (frameCount === 0) throw new Error('GifEncoder.finish: no frames were added');
      sink.push(new Uint8Array([0x3B]));
      finished = true;
      result = sink.concat();
      sink.chunks = [];
      lut = dict = cur = prev = rect = lzwOut = null;
      return result;
    }

    return {
      addFrame: addFrame,
      finish: finish,
      byteLength: function () { return finished ? result.length : sink.length; },
      frameCount: function () { return frameCount; }
    };
  }

  NS.GifEncoder = {
    buildPalette: buildPalette,
    create: create
  };
})(window.ShaderSandbox);
