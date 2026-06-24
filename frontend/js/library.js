// Puck library — persisted via IndexedDB so storage isn't capped at the
// ~5 MB localStorage limit. On first run we auto-migrate any pucks that were
// saved under the old localStorage scheme so nothing is lost.

const DB_NAME = 'minimap-pucks';
const DB_VERSION = 1;
const STORE = 'pucks';
const LEGACY_KEY = 'minimap_pucks_v1';

let dbPromise = null;
function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = async () => {
      const db = req.result;
      try { await migrateLegacyIfNeeded(db); } catch (e) { console.warn(e); }
      resolve(db);
    };
  });
  return dbPromise;
}

async function migrateLegacyIfNeeded(db) {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  let old;
  try { old = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(old) || old.length === 0) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const entry of old) {
      try { store.put(entry); } catch {}
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  localStorage.removeItem(LEGACY_KEY);
  console.info(`Migrated ${old.length} pucks from localStorage → IndexedDB`);
}

export async function loadLibrary() {
  let db;
  try { db = await getDB(); }
  catch { return []; }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const items = req.result || [];
      items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      resolve(items);
    };
    req.onerror = () => resolve([]);
  });
}

export async function saveToLibrary(puck, providedName, defaultNameHint) {
  const albedo = puck.data.albedo;
  const albedoCanvas = albedo instanceof HTMLCanvasElement ? albedo : null;
  const albedoSerialized = albedoCanvas ? encodeAlbedo(albedoCanvas) : albedo;

  const water = puck.data.waterMask;
  const waterSerialized = water instanceof HTMLCanvasElement
    ? water.toDataURL('image/png')
    : (water || null);

  const thumbnail = albedoCanvas ? thumbnailFromCanvas(albedoCanvas) : albedoSerialized;

  // defaultNameHint comes from the caller — typically a reverse-geocoded
  // place name like 'Ronda, Andalusia'. Falls back to the generic
  // 'Puck <date>' string if the caller has nothing better to offer.
  const promptDefault = (defaultNameHint && defaultNameHint.trim()) || defaultName();
  const name = providedName ?? prompt('Name this puck:', promptDefault);
  if (name === null) return null;

  const entry = {
    id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: name || promptDefault,
    thumbnail,
    createdAt: new Date().toISOString(),
    data: {
      bounds: puck.data.bounds,
      demtype: puck.data.demtype,
      captureZoom: puck.data.captureZoom,
      heightmap: puck.data.heightmap,
      albedo: albedoSerialized,
      waterMask: waterSerialized,
      center: puck.data.center,
      geo: puck.data.geo,
      provider: puck.data.provider,
      regionWidthM: puck.data.regionWidthM,
      filters: puck.data.filters || null,
    },
    zExaggeration: puck.zExaggeration,
    displacement: puck.displacement || 0,
  };

  try {
    const db = await getDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return entry;
  } catch (e) {
    alert('Could not save to library: ' + (e?.message || e));
    return null;
  }
}

export async function deleteFromLibrary(id) {
  const db = await getDB();
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
  });
}

function encodeAlbedo(canvas) {
  const webp = canvas.toDataURL('image/webp', 0.86);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', 0.85);
}

function thumbnailFromCanvas(canvas) {
  const t = document.createElement('canvas');
  t.width = 200;
  t.height = 200;
  t.getContext('2d').drawImage(canvas, 0, 0, 200, 200);
  return t.toDataURL('image/jpeg', 0.7);
}

function defaultName() {
  return 'Puck ' + new Date().toLocaleString();
}
