// Image-processing filters applied to the stitched albedo before the puck is
// built. Output canvases replace the original albedo in the capture pipeline,
// so the filtered look persists through library save / STL export.

// Derive a grayscale bump map from a satellite albedo. The output is the
// high-frequency luminance variation (original luminance minus a heavily
// blurred version), recentered around mid-grey so positive deviations push
// "up" and negative ones push "down" in the shader's bumpMap interpretation.
// Forest canopies, building rooflines, road textures and field boundaries
// all show up as micro-relief on the puck top.
export function computeBumpFromAlbedo(srcCanvas, opts = {}) {
  const blurRadius = opts.blurRadius ?? 10;
  const intensity = opts.intensity ?? 2.6;

  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const ctx = srcCanvas.getContext('2d');
  const src = ctx.getImageData(0, 0, w, h).data;

  const N = w * h;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    lum[i] = 0.2126 * src[i * 4] + 0.7152 * src[i * 4 + 1] + 0.0722 * src[i * 4 + 2];
  }

  const blurred = separableBoxBlur(lum, w, h, blurRadius);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const outCtx = out.getContext('2d');
  const outImg = outCtx.createImageData(w, h);
  for (let i = 0; i < N; i++) {
    const hf = (lum[i] - blurred[i]) * intensity + 128;
    const v = hf < 0 ? 0 : hf > 255 ? 255 : hf;
    outImg.data[i * 4]     = v;
    outImg.data[i * 4 + 1] = v;
    outImg.data[i * 4 + 2] = v;
    outImg.data[i * 4 + 3] = 255;
  }
  outCtx.putImageData(outImg, 0, 0);
  return out;
}

// XDoG (Extended Difference of Gaussians) — classic pencil-sketch / inked
// line-art filter. Subtracts two gaussian-blurred copies at different scales
// to isolate edges, then soft-thresholds.
export function applySketch(srcCanvas, opts = {}) {
  const sigma1 = opts.sigma1 ?? 0.9;
  const sigma2 = opts.sigma2 ?? 1.6;
  const tau    = opts.tau    ?? 0.985;
  const phi    = opts.phi    ?? 180;
  const eps    = opts.eps    ?? 0.005;

  const w = srcCanvas.width, h = srcCanvas.height;
  const src = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;

  const N = w * h;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    lum[i] = (0.2126 * src[i * 4] + 0.7152 * src[i * 4 + 1] + 0.0722 * src[i * 4 + 2]) / 255;
  }

  const b1 = separableGaussian(lum, w, h, sigma1);
  const b2 = separableGaussian(lum, w, h, sigma2);

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const oCtx = out.getContext('2d');
  const oImg = oCtx.createImageData(w, h);
  for (let i = 0; i < N; i++) {
    const D = b1[i] - tau * b2[i];
    const t = D >= eps ? 1 : 1 + Math.tanh(phi * (D - eps));
    const v = t < 0 ? 0 : t > 1 ? 255 : t * 255;
    oImg.data[i * 4]     = v;
    oImg.data[i * 4 + 1] = v;
    oImg.data[i * 4 + 2] = v;
    oImg.data[i * 4 + 3] = 255;
  }
  oCtx.putImageData(oImg, 0, 0);
  return out;
}

// Tritone — map image luminance through three colors (shadow / mid / highlight).
// Gives every puck a strong unified palette. Default is a warm "old-map" look.
export function applyTritone(srcCanvas, opts = {}) {
  const shadow    = opts.shadow    ?? [38, 50, 70];
  const mid       = opts.mid       ?? [185, 165, 130];
  const highlight = opts.highlight ?? [248, 240, 222];

  const w = srcCanvas.width, h = srcCanvas.height;
  const src = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const oCtx = out.getContext('2d');
  const oImg = oCtx.createImageData(w, h);
  const N = w * h;
  for (let i = 0; i < N; i++) {
    const r = src[i * 4], g = src[i * 4 + 1], b = src[i * 4 + 2];
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    let R, G, B;
    if (L < 0.5) {
      const t = L * 2;
      R = shadow[0] + (mid[0] - shadow[0]) * t;
      G = shadow[1] + (mid[1] - shadow[1]) * t;
      B = shadow[2] + (mid[2] - shadow[2]) * t;
    } else {
      const t = (L - 0.5) * 2;
      R = mid[0] + (highlight[0] - mid[0]) * t;
      G = mid[1] + (highlight[1] - mid[1]) * t;
      B = mid[2] + (highlight[2] - mid[2]) * t;
    }
    oImg.data[i * 4]     = R;
    oImg.data[i * 4 + 1] = G;
    oImg.data[i * 4 + 2] = B;
    oImg.data[i * 4 + 3] = 255;
  }
  oCtx.putImageData(oImg, 0, 0);
  return out;
}

// Topographic contour overlay. Traces elevation iso-lines from the heightmap
// via marching squares and draws them over a lightly-washed copy of the
// albedo. Every 5th line is an "index contour" — thicker & darker, just like
// a real topo map.
export function applyContours(srcCanvas, heightmap, opts = {}) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');

  ctx.drawImage(srcCanvas, 0, 0);
  // Subtle warm wash so the imagery reads as a "map" and the lines pop.
  ctx.fillStyle = opts.wash ?? 'rgba(244, 238, 226, 0.20)';
  ctx.fillRect(0, 0, w, h);

  if (!heightmap || !heightmap.values) return out;
  const { ncols, nrows, values } = heightmap;

  let minH = Infinity, maxH = -Infinity;
  for (const v of values) {
    if (v == null) continue;
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }
  if (!isFinite(minH) || maxH <= minH) return out;

  const numLevels = opts.levels ?? 16;
  const cellW = w / (ncols - 1);
  const cellH = h / (nrows - 1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let lvl = 1; lvl < numLevels; lvl++) {
    const t = minH + (maxH - minH) * (lvl / numLevels);
    const isIndex = (lvl % 5 === 0);
    ctx.strokeStyle = isIndex ? 'rgba(54, 38, 22, 0.72)' : 'rgba(72, 56, 38, 0.40)';
    ctx.lineWidth = isIndex ? Math.max(1.6, w / 850) : Math.max(0.7, w / 1900);
    ctx.beginPath();
    marchingSquares(values, ncols, nrows, t, ctx, cellW, cellH);
    ctx.stroke();
  }
  return out;
}

// Marching squares — appends contour line segments at `threshold` into the
// current ctx path. Standard 16-case lookup with linear edge interpolation.
function marchingSquares(values, ncols, nrows, threshold, ctx, cellW, cellH) {
  const lerpT = (a, b) => (a === b ? 0.5 : (threshold - a) / (b - a));
  for (let r = 0; r < nrows - 1; r++) {
    for (let c = 0; c < ncols - 1; c++) {
      const tl = values[r * ncols + c];
      const tr = values[r * ncols + c + 1];
      const br = values[(r + 1) * ncols + c + 1];
      const bl = values[(r + 1) * ncols + c];
      if (tl == null || tr == null || br == null || bl == null) continue;

      let idx = 0;
      if (tl > threshold) idx |= 1;
      if (tr > threshold) idx |= 2;
      if (br > threshold) idx |= 4;
      if (bl > threshold) idx |= 8;
      if (idx === 0 || idx === 15) continue;

      const x0 = c * cellW, y0 = r * cellH;
      const top    = () => [x0 + cellW * lerpT(tl, tr), y0];
      const right  = () => [x0 + cellW, y0 + cellH * lerpT(tr, br)];
      const bottom = () => [x0 + cellW * lerpT(bl, br), y0 + cellH];
      const left   = () => [x0, y0 + cellH * lerpT(tl, bl)];
      const seg = (a, b) => { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };

      switch (idx) {
        case 1: case 14: seg(left(), top()); break;
        case 2: case 13: seg(top(), right()); break;
        case 3: case 12: seg(left(), right()); break;
        case 4: case 11: seg(right(), bottom()); break;
        case 6: case 9:  seg(top(), bottom()); break;
        case 7: case 8:  seg(left(), bottom()); break;
        case 5:  seg(left(), top());  seg(right(), bottom()); break;
        case 10: seg(top(), right()); seg(left(), bottom());  break;
      }
    }
  }
}

// Watercolor — smoothed colour "washes", pigment darkening pooling at edges,
// a saturation lift, and fine paper grain. Downsamples large albedos first
// (the multi-channel gaussian is too heavy at full 4096² resolution, and the
// stylized result doesn't need that detail anyway).
export function applyWatercolor(srcCanvas, opts = {}) {
  const maxDim = opts.maxDim ?? 1600;
  let work = srcCanvas;
  const srcMax = Math.max(srcCanvas.width, srcCanvas.height);
  if (srcMax > maxDim) {
    const scale = maxDim / srcMax;
    work = document.createElement('canvas');
    work.width = Math.round(srcCanvas.width * scale);
    work.height = Math.round(srcCanvas.height * scale);
    const wctx = work.getContext('2d');
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';
    wctx.drawImage(srcCanvas, 0, 0, work.width, work.height);
  }

  const w = work.width, h = work.height;
  const src = work.getContext('2d').getImageData(0, 0, w, h).data;
  const N = w * h;

  const r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    r[i] = src[i * 4]; g[i] = src[i * 4 + 1]; b[i] = src[i * 4 + 2];
  }

  // The wash: smooth each channel.
  const sigma = opts.sigma ?? 4.5;
  const rS = separableGaussian(r, w, h, sigma);
  const gS = separableGaussian(g, w, h, sigma);
  const bS = separableGaussian(b, w, h, sigma);

  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    lum[i] = (0.2126 * rS[i] + 0.7152 * gS[i] + 0.0722 * bS[i]) / 255;
  }

  const satBoost = opts.saturation ?? 1.35;
  const grainAmt = opts.grain ?? 13;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const oCtx = out.getContext('2d');
  const oImg = oCtx.createImageData(w, h);

  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;

      let R = rS[i], G = gS[i], B = bS[i];

      // Edge pigment-pooling: darken proportionally to local luminance gradient.
      const gx = lum[y * w + xp] - lum[y * w + xm];
      const gy = lum[yp * w + x] - lum[ym * w + x];
      const edge = Math.sqrt(gx * gx + gy * gy);
      const darken = 1.0 - Math.min(0.5, edge * 2.4);
      R *= darken; G *= darken; B *= darken;

      // Saturation lift.
      const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      R = L + (R - L) * satBoost;
      G = L + (G - L) * satBoost;
      B = L + (B - L) * satBoost;

      // Paper grain.
      const grain = (waterHash(x, y) - 0.5) * grainAmt;
      oImg.data[i * 4]     = clamp(R + grain);
      oImg.data[i * 4 + 1] = clamp(G + grain);
      oImg.data[i * 4 + 2] = clamp(B + grain);
      oImg.data[i * 4 + 3] = 255;
    }
  }
  oCtx.putImageData(oImg, 0, 0);
  return out;
}

function waterHash(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return (h >>> 0) / 4294967295;
}

function separableGaussian(src, w, h, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const tmp = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -radius; j <= radius; j++) {
        const xx = x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j;
        s += src[row + xx] * k[j + radius];
      }
      tmp[row + x] = s;
    }
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -radius; j <= radius; j++) {
        const yy = y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j;
        s += tmp[yy * w + x] * k[j + radius];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

// Texture-intensity map for displacement. Computes the local stddev of
// luminance over a sliding window, then smooths the result heavily so the
// output describes "how textured is this region" rather than individual
// pixel variation. Forests / urban areas come out bright, water / fields /
// snow stay dark. The grayscale canvas is suitable for vertex displacement —
// brighter values raise the surface.
export function computeTextureIntensity(srcCanvas, opts = {}) {
  const varRadius    = opts.varRadius    ?? 14;   // local variance window
  const smoothRadius = opts.smoothRadius ?? 28;   // post-blur for smoothness

  const w = srcCanvas.width, h = srcCanvas.height;
  const src = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const N = w * h;

  const lum = new Float32Array(N);
  const lumSq = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const L = (0.2126 * src[i * 4] + 0.7152 * src[i * 4 + 1] + 0.0722 * src[i * 4 + 2]) / 255;
    lum[i] = L;
    lumSq[i] = L * L;
  }

  const meanL  = separableBoxBlur(lum,   w, h, varRadius);
  const meanSq = separableBoxBlur(lumSq, w, h, varRadius);

  const variance = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    variance[i] = Math.max(0, meanSq[i] - meanL[i] * meanL[i]);
  }
  const smoothed = separableBoxBlur(variance, w, h, smoothRadius);

  // Take sqrt for perceptual scaling (stddev rather than variance), and
  // normalize to 0..1 by the max found in the map.
  let maxV = 0;
  for (let i = 0; i < N; i++) {
    const s = Math.sqrt(smoothed[i]);
    if (s > maxV) maxV = s;
  }
  const invMax = maxV > 0 ? 1 / maxV : 1;

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const oCtx = out.getContext('2d');
  const oImg = oCtx.createImageData(w, h);
  for (let i = 0; i < N; i++) {
    const v = Math.sqrt(smoothed[i]) * invMax;
    const px = v < 0 ? 0 : v > 1 ? 255 : v * 255;
    oImg.data[i * 4]     = px;
    oImg.data[i * 4 + 1] = px;
    oImg.data[i * 4 + 2] = px;
    oImg.data[i * 4 + 3] = 255;
  }
  oCtx.putImageData(oImg, 0, 0);
  return out;
}

function separableBoxBlur(src, w, h, radius) {
  const divisor = radius * 2 + 1;
  const tmp = new Float32Array(src.length);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += src[row + Math.max(0, Math.min(w - 1, x))];
    }
    tmp[row] = sum / divisor;
    for (let x = 1; x < w; x++) {
      sum += src[row + Math.min(w - 1, x + radius)];
      sum -= src[row + Math.max(0, x - radius - 1)];
      tmp[row + x] = sum / divisor;
    }
  }

  const out = new Float32Array(src.length);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    }
    out[x] = sum / divisor;
    for (let y = 1; y < h; y++) {
      sum += tmp[Math.min(h - 1, y + radius) * w + x];
      sum -= tmp[Math.max(0, y - radius - 1) * w + x];
      out[y * w + x] = sum / divisor;
    }
  }
  return out;
}

// Generalized Kuwahara filter — 8 angular sectors around each pixel, output is
// the mean of the lowest-variance sector. Preserves edges while flattening
// uniform regions into "brushstroke" patches, giving a painterly look.
//
// Downsamples large canvases to keep the algorithm tractable in pure JS;
// painterly output doesn't benefit from very high resolution since the whole
// point is replacing detail with stylized patches.
export async function applyKuwahara(srcCanvas, opts = {}) {
  const radius   = opts.radius   ?? 3;          // 7x7 kernel by default
  const sectors  = opts.sectors  ?? 8;
  const maxDim   = opts.maxDim   ?? 1280;
  const onProgress = opts.onProgress;

  // 1. Downsample if the source is bigger than maxDim along either axis.
  let work = srcCanvas;
  const srcMax = Math.max(srcCanvas.width, srcCanvas.height);
  if (srcMax > maxDim) {
    const scale = maxDim / srcMax;
    work = document.createElement('canvas');
    work.width  = Math.round(srcCanvas.width  * scale);
    work.height = Math.round(srcCanvas.height * scale);
    const wctx = work.getContext('2d');
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';
    wctx.drawImage(srcCanvas, 0, 0, work.width, work.height);
  }

  const w = work.width, h = work.height;
  const wctx = work.getContext('2d');
  const src = wctx.getImageData(0, 0, w, h).data;

  const out = new ImageData(w, h);
  const dst = out.data;

  // 2. Precompute which sector each kernel offset belongs to.
  const kDim = 2 * radius + 1;
  const sectorLut = new Int8Array(kDim * kDim);
  const TWO_PI = Math.PI * 2;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const idx = (dy + radius) * kDim + (dx + radius);
      if (dx === 0 && dy === 0) {
        sectorLut[idx] = -1;   // center pixel: belongs to no sector
        continue;
      }
      let t = (Math.atan2(dy, dx) + Math.PI) / TWO_PI; // 0..1
      if (t >= 1) t = 0;
      sectorLut[idx] = Math.floor(t * sectors);
    }
  }

  // 3. Per-pixel inner loop. Reusable accumulators kept outside the loop.
  const sumR  = new Float32Array(sectors);
  const sumG  = new Float32Array(sectors);
  const sumB  = new Float32Array(sectors);
  const sumR2 = new Float32Array(sectors);
  const sumG2 = new Float32Array(sectors);
  const sumB2 = new Float32Array(sectors);
  const cnt   = new Int32Array(sectors);

  const CHUNK_ROWS = 32;

  for (let yStart = 0; yStart < h; yStart += CHUNK_ROWS) {
    const yEnd = Math.min(yStart + CHUNK_ROWS, h);
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < w; x++) {
        sumR.fill(0);  sumG.fill(0);  sumB.fill(0);
        sumR2.fill(0); sumG2.fill(0); sumB2.fill(0);
        cnt.fill(0);

        // Walk the kernel; accumulate into the corresponding sector.
        for (let dy = -radius; dy <= radius; dy++) {
          const py = y + dy;
          if (py < 0 || py >= h) continue;
          const pyRow = py * w;
          const lutRow = (dy + radius) * kDim;
          for (let dx = -radius; dx <= radius; dx++) {
            const px = x + dx;
            if (px < 0 || px >= w) continue;
            const sec = sectorLut[lutRow + (dx + radius)];
            if (sec < 0) continue;
            const i = (pyRow + px) * 4;
            const r = src[i], g = src[i + 1], b = src[i + 2];
            sumR[sec]  += r;     sumG[sec]  += g;     sumB[sec]  += b;
            sumR2[sec] += r * r; sumG2[sec] += g * g; sumB2[sec] += b * b;
            cnt[sec]++;
          }
        }

        // Pick the sector with the lowest combined-channel variance.
        let bestVar = Infinity, bR = 0, bG = 0, bB = 0;
        for (let s = 0; s < sectors; s++) {
          const c = cnt[s];
          if (c === 0) continue;
          const mR = sumR[s] / c, mG = sumG[s] / c, mB = sumB[s] / c;
          const vR = sumR2[s] / c - mR * mR;
          const vG = sumG2[s] / c - mG * mG;
          const vB = sumB2[s] / c - mB * mB;
          const v = vR + vG + vB;
          if (v < bestVar) {
            bestVar = v;
            bR = mR; bG = mG; bB = mB;
          }
        }

        const oi = (y * w + x) * 4;
        dst[oi]     = bR;
        dst[oi + 1] = bG;
        dst[oi + 2] = bB;
        dst[oi + 3] = 255;
      }
    }
    if (onProgress) onProgress(yEnd / h);
    // Yield to the event loop so the busy-spinner can update.
    await new Promise(r => setTimeout(r, 0));
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  outCanvas.getContext('2d').putImageData(out, 0, 0);
  return outCanvas;
}
