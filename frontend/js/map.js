// Map setup + capture. All tile traffic is routed through the local Flask
// proxy (/api/tile/<provider>/...) so we avoid cross-origin tainting when we
// stitch the capture into a canvas - and so we can swap providers freely.

// `hidden: true` keeps the entry registered (so saved pucks that reference
// it still load + render correctly) but omits it from any picker UI.
const PROVIDERS = {
  esri: {
    name: 'ESRI World Imagery',
    maxZoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
};

const DEFAULT_PROVIDER = 'esri';

let activeProvider = DEFAULT_PROVIDER;
let currentLayer = null;

export function getProviders() {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => !p.hidden)
    .map(([key, p]) => ({ key, name: p.name }));
}

export function getActiveProvider() {
  return activeProvider;
}

export function getActiveImageryMaxZoom() {
  return PROVIDERS[activeProvider].maxZoom;
}

export function getProviderMaxZoom(providerKey) {
  return PROVIDERS[providerKey]?.maxZoom ?? 20;
}

// The stitch always renders into this square px canvas regardless of source
// zoom. Promoted from a local magic number so the zoom-range math below stays
// in sync with the actual output resolution.
export const STITCH_OUT_PX = 4096;

// "Saturation zoom": the (fractional) zoom at which the captured region's
// native tile pixels span ~STITCH_OUT_PX - i.e. tiles map ~1:1 onto the
// output. Longitude is linear in Web-Mercator tile-x, so this is exact for
// the horizontal axis. Beyond this zoom we fetch more tiles than the output
// can show (pure waste) and risk requesting zoom levels the provider doesn't
// stock for this location (→ blank/black tiles).
export function saturationZoom(bounds) {
  const lonSpan = Math.abs(bounds.east - bounds.west);
  if (!(lonSpan > 0)) return 18;
  return Math.log2((STITCH_OUT_PX * 360) / (256 * lonSpan));
}

// Realistic, region-aware zoom range for the resolution control.
//   hi = finest that's actually useful (saturation), capped at provider max
//   lo = several steps coarser, for deliberately low-res / stylised stitches
// Always widened to include `captureZoom` so the current level is selectable
// even if the original capture happened to overshoot saturation.
export function usefulZoomRange(bounds, provider, captureZoom, coarseSteps = 5) {
  const providerMax = getProviderMaxZoom(provider);
  const sat = saturationZoom(bounds);
  let hi = Math.min(providerMax, Math.max(1, Math.ceil(sat)));
  let lo = Math.max(1, hi - coarseSteps);
  if (captureZoom != null) {
    hi = Math.max(hi, captureZoom);
    lo = Math.min(lo, captureZoom);
  }
  return { lo, hi, sat, providerMax };
}

// Re-stitch just the albedo for an already-captured puck at a new zoom level.
// Used by the post-capture Resolution control - no heightmap re-query.
export async function refetchAlbedo(bounds, provider, captureZoom, onProgress) {
  const name = PROVIDERS[provider]?.name || provider;
  onProgress?.(`Re-stitching ${name} at z${captureZoom}…`);
  return stitchTiles(bounds, captureZoom, provider);
}

export function setupMap(elId, providerKey = DEFAULT_PROVIDER) {
  const map = L.map(elId, {
    zoomControl: true,
    worldCopyJump: true,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    wheelPxPerZoomLevel: 120,
  }).setView([50, 45], 4);  // wide view spanning Europe → Central Asia
  setImagery(map, providerKey);
  // Country lines + place labels on top of the satellite imagery so the user
  // can orient themselves before drawing a capture box. Esri's transparent
  // reference layer - already attributed via the underlying imagery layer.
  const labelsLayer = L.tileLayer('/api/tile/esri-labels/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: '',
    opacity: 1.0,
    pane: 'overlayPane',
  });
  labelsLayer.addTo(map);
  return map;
}

// Width in meters of the geographic region currently framed by the on-screen
// square - depends on map zoom, center latitude, and the square's pixel size.
export function getRegionWidthMeters(map, squareEl) {
  const mapRect = map.getContainer().getBoundingClientRect();
  const sq = squareEl.getBoundingClientRect();
  const nw = map.containerPointToLatLng([sq.left - mapRect.left, sq.top - mapRect.top]);
  const se = map.containerPointToLatLng([sq.right - mapRect.left, sq.bottom - mapRect.top]);
  const midLat = (nw.lat + se.lat) / 2;
  return (se.lng - nw.lng) * 111320 * Math.cos(midLat * Math.PI / 180);
}

export function setImagery(map, providerKey) {
  if (!PROVIDERS[providerKey]) return;
  if (currentLayer) map.removeLayer(currentLayer);
  const p = PROVIDERS[providerKey];
  currentLayer = L.tileLayer(`/api/tile/${providerKey}/{z}/{y}/{x}`, {
    maxZoom: p.maxZoom,
    attribution: p.attribution,
  }).addTo(map);
  activeProvider = providerKey;
}

// Compute the bounds covered by the on-screen square, stitch tiles at zoom+1
// for higher detail, request the heightmap.
export async function capture(map, squareEl, demtype, onProgress, captureZoomOverride) {
  const mapEl = map.getContainer();
  const mapRect = mapEl.getBoundingClientRect();
  const sq = squareEl.getBoundingClientRect();

  const x1 = sq.left - mapRect.left;
  const y1 = sq.top - mapRect.top;
  const x2 = sq.right - mapRect.left;
  const y2 = sq.bottom - mapRect.top;

  const nw = map.containerPointToLatLng([x1, y1]);
  const se = map.containerPointToLatLng([x2, y2]);
  const bounds = { north: nw.lat, south: se.lat, west: nw.lng, east: se.lng };

  const provider = activeProvider;
  const maxZ = PROVIDERS[provider].maxZoom;
  // Snap to integer - fractional zoom is fine for display (Leaflet upscales
  // integer tiles) but tile requests must use integer z.
  const baseZoom = Math.round(map.getZoom());
  const captureZoom = captureZoomOverride != null
    ? Math.max(0, Math.min(maxZ, Math.round(captureZoomOverride)))
    : Math.min(baseZoom + 3, maxZ);

  onProgress?.('Stitching tiles…');
  const albedo = await stitchTiles(bounds, captureZoom, provider);

  onProgress?.('Fetching elevation data…');
  const heightmap = await fetchHeightmap(bounds, demtype, onProgress);

  // Region width in meters - passed through for the scale-aware shader.
  const midLat = (bounds.north + bounds.south) / 2;
  const regionWidthM = (bounds.east - bounds.west) * 111320 * Math.cos(midLat * Math.PI / 180);

  return { albedo, heightmap, bounds, demtype, captureZoom, provider, regionWidthM };
}

function lonToTileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
function latToTileY(lat, z) {
  const rad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
}

async function stitchTiles(bounds, z, provider) {
  const TS = 256;
  const xMinF = lonToTileX(bounds.west, z);
  const xMaxF = lonToTileX(bounds.east, z);
  const yMinF = latToTileY(bounds.north, z);
  const yMaxF = latToTileY(bounds.south, z);

  const xMin = Math.floor(xMinF);
  const xMax = Math.floor(xMaxF);
  const yMin = Math.floor(yMinF);
  const yMax = Math.floor(yMaxF);

  const fullW = (xMax - xMin + 1) * TS;
  const fullH = (yMax - yMin + 1) * TS;

  const stitch = document.createElement('canvas');
  stitch.width = fullW;
  stitch.height = fullH;
  const ctx = stitch.getContext('2d');

  const jobs = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      const xx = x, yy = y;
      jobs.push(() => loadTile(provider, xx, yy, z).then(img => {
        if (img) ctx.drawImage(img, (xx - xMin) * TS, (yy - yMin) * TS);
      }));
    }
  }
  await runWithConcurrency(jobs, 8);

  const cropX = (xMinF - xMin) * TS;
  const cropY = (yMinF - yMin) * TS;
  const cropW = (xMaxF - xMinF) * TS;
  const cropH = (yMaxF - yMinF) * TS;

  const OUT = 4096;
  const out = document.createElement('canvas');
  out.width = OUT;
  out.height = OUT;
  out.getContext('2d').drawImage(stitch, cropX, cropY, cropW, cropH, 0, 0, OUT, OUT);
  return out;
}

// Tile loader with retry + backoff. Returns null after exhausting retries so
// one dropped tile doesn't abort the whole stitch - leaves a small dark patch
// in the texture, which is preferable to the entire capture failing.
function loadTile(provider, x, y, z, attempt = 0) {
  const MAX_ATTEMPTS = 3;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = 250 * (attempt + 1) + Math.random() * 200;
        setTimeout(() => {
          loadTile(provider, x, y, z, attempt + 1).then(resolve);
        }, delay);
      } else {
        console.warn(`Tile gave up: ${provider} ${z}/${y}/${x}`);
        resolve(null);
      }
    };
    img.src = `/api/tile/${provider}/${z}/${y}/${x}`;
  });
}

// Bounded-parallel runner - keeps at most `limit` jobs in flight at once.
async function runWithConcurrency(jobFactories, limit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobFactories.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= jobFactories.length) return;
      await jobFactories[i]();
    }
  });
  await Promise.all(workers);
}

// localStorage key for the user's OpenTopography API key. The key never
// leaves the browser except to be forwarded to our own /api/heightmap proxy,
// which relays it on to opentopography.org.
const OPENTOPO_KEY_STORAGE = 'minimap_opentopo_key';

export function getOpentopoKey() {
  try { return localStorage.getItem(OPENTOPO_KEY_STORAGE) || ''; }
  catch { return ''; }
}

export function setOpentopoKey(key) {
  try {
    if (key) localStorage.setItem(OPENTOPO_KEY_STORAGE, key);
    else     localStorage.removeItem(OPENTOPO_KEY_STORAGE);
  } catch {}
}

// Thrown when /api/heightmap needs a key and we don't have one (or the user's
// key was rejected upstream). The UI catches this to pop the key dialog.
export class NeedsOpentopoKeyError extends Error {
  constructor(message) { super(message); this.name = 'NeedsOpentopoKeyError'; }
}

async function fetchHeightmap(bounds, demtype, onProgress) {
  if (demtype === 'aws-terrain') {
    return fetchAwsTerrain(bounds);
  }
  const qs = new URLSearchParams({
    south: bounds.south, north: bounds.north,
    west: bounds.west, east: bounds.east,
    demtype,
  });
  const key = getOpentopoKey();
  if (key) qs.set('key', key);

  const res = await fetch('/api/heightmap?' + qs.toString());
  if (res.ok) {
    const hm = await res.json();
    hm.demtypeUsed = demtype;
    return hm;
  }

  let body = null;
  try { body = await res.json(); } catch {}

  // Key problem → re-open the key dialog.
  if (body?.needs_key) {
    throw new NeedsOpentopoKeyError(body.detail || 'OpenTopography API key required.');
  }

  // No silent substitution. Surface exactly what happened - including the
  // coverage-gap case (e.g. SRTM has no data above 60°N) - so the user can
  // make an informed choice about which DEM to switch to.
  const parts = [];
  if (body?.error)  parts.push(body.error);
  if (body?.detail) parts.push(body.detail);
  if (body?.head)   parts.push('Response head: ' + body.head);
  const detail = parts.join(' - ') || (await res.text().catch(() => '')).slice(0, 400);
  throw new Error(`Heightmap fetch failed (${res.status}): ${detail}`);
}

// AWS Open Terrain Tiles (Terrarium format) - PNG tiles where RGB encodes
// signed elevation in meters as: (R*256 + G + B/256) - 32768.
// Free, no key, no rate limit, served from S3. Same tile-fetch pattern as
// satellite imagery - goes through our /api/tile proxy.
async function fetchAwsTerrain(bounds) {
  const midLat = (bounds.north + bounds.south) / 2;
  const widthM = (bounds.east - bounds.west) * 111320 * Math.cos(midLat * Math.PI / 180);

  // Pick a zoom level so the bounds map to ~384 native pixels per side. Clamped
  // to [10, 15] - z15 is the global max for Terrarium, z10 keeps tile counts
  // sane for huge captures.
  const mPerPxAtZ0 = 156543.03 * Math.cos(midLat * Math.PI / 180);
  const TARGET_NATIVE = 512;       // max useful for both display and 3D-printable mesh
  const idealZoom = Math.log2(mPerPxAtZ0 * TARGET_NATIVE / widthM);
  const zoom = Math.max(10, Math.min(15, Math.round(idealZoom)));

  const TS = 256;
  const xMinF = lonToTileX(bounds.west, zoom);
  const xMaxF = lonToTileX(bounds.east, zoom);
  const yMinF = latToTileY(bounds.north, zoom);
  const yMaxF = latToTileY(bounds.south, zoom);

  const xMin = Math.floor(xMinF);
  const xMax = Math.floor(xMaxF);
  const yMin = Math.floor(yMinF);
  const yMax = Math.floor(yMaxF);

  const fullW = (xMax - xMin + 1) * TS;
  const fullH = (yMax - yMin + 1) * TS;

  const stitch = document.createElement('canvas');
  stitch.width = fullW;
  stitch.height = fullH;
  const ctx = stitch.getContext('2d');

  const jobs = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      const xx = x, yy = y;
      jobs.push(() => loadTile('aws-terrain', xx, yy, zoom).then(img => {
        if (img) ctx.drawImage(img, (xx - xMin) * TS, (yy - yMin) * TS);
      }));
    }
  }
  await runWithConcurrency(jobs, 8);

  // Crop to the bounds at NATIVE resolution. No upscale → no bilinear smearing
  // of elevation values across tile boundaries or missing-tile pixels.
  const cropX = Math.max(0, Math.round((xMinF - xMin) * TS));
  const cropY = Math.max(0, Math.round((yMinF - yMin) * TS));
  const cropW = Math.max(1, Math.round((xMaxF - xMinF) * TS));
  const cropH = Math.max(1, Math.round((yMaxF - yMinF) * TS));

  const cropped = document.createElement('canvas');
  cropped.width = cropW;
  cropped.height = cropH;
  const cctx = cropped.getContext('2d');
  cctx.imageSmoothingEnabled = false;
  cctx.drawImage(stitch, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  const pixels = cctx.getImageData(0, 0, cropW, cropH).data;
  const n = cropW * cropH;
  const values = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    // (0,0,0) = elevation -32768, which is the sentinel for missing data
    // (failed tile fetch left the canvas black). Treat as null.
    if (r === 0 && g === 0 && b === 0) {
      values[i] = null;
    } else {
      values[i] = (r * 256 + g + b / 256) - 32768;
    }
  }

  return {
    ncols: cropW,
    nrows: cropH,
    cellsize: (bounds.east - bounds.west) / cropW,
    xllcorner: bounds.west,
    yllcorner: bounds.south,
    values,
    source: 'aws-terrain',
    sourceZoom: zoom,
  };
}
