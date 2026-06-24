// OSM building extrusions, draped on top of the puck terrain.
//
// Workflow:
//   1. fetchBuildings(bounds)  — hits our /api/buildings Overpass proxy.
//   2. buildBuildingGroup(overpass, geoParams)  — returns a THREE.Group of
//      merged extrusion meshes positioned in the puck's local coord system.
//
// Coordinate system (matches puck.js):
//   X = lon → west(-half) … east(+half)
//   Y = up
//   Z = lat → north(-half) … south(+half)
//   Units: cm, where the puck's footprint is PUCK_SIZE × PUCK_SIZE.
//
// Heights:
//   `height` tag wins (parsed as metres, "ft" suffix understood).
//   Else `building:levels` × 3 m.
//   Else DEFAULT_HEIGHT_M.
//   All converted m → cm via the puck's geographic scale, and multiplied by
//   the same z-exaggeration the terrain uses so buildings stay proportionate.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const LEVEL_HEIGHT_M     = 3.0;     // metres per "building:level"
const MAX_BUILDINGS      = 8000;    // protect the renderer + main thread

// Flat fallback when OSM provides no `height` and no `building:levels`. We
// deliberately do NOT guess based on `building=<type>` — type-based defaults
// are wrong too often (e.g. a single-storey rural school gets the same
// height as a multi-storey city one), and the resulting variation reads as
// "real data" when it isn't. A consistent low default is more honest:
// regions where every building looks the same height usually really *are*
// regions where every building's height is unknown.
const DEFAULT_HEIGHT_M   = 3.0;

// True-scale buildings on a 10 cm puck are basically microscopic. Architectural
// dioramas conventionally exaggerate vertical scale so structures actually
// read. This is INDEPENDENT of terrain Z-exaggeration: that's a topography
// knob, this is purely a visibility knob, and crucially it preserves the
// relative heights of buildings to each other.
//
// Calibration notes (10 cm puck, 1 cm = 1 mm increment on a typical print):
//   region  building   true        @ 3× boost
//   1 km    20 m       0.2 cm      0.6 cm  ← reads but not dominant
//   5 km    20 m       0.04 cm     0.12 cm ← just visible
//  10 km    20 m       0.02 cm     0.06 cm ← needs more
// So 3× is a sensible default for typical city captures; very large regions
// may want this pushed up. Easy to expose as a slider in the experimental
// panel if you find you're changing it often.
const BUILDING_VERTICAL_BOOST = 3.0;

export async function fetchBuildings(bounds) {
  const qs = new URLSearchParams({
    south: bounds.south, north: bounds.north,
    west: bounds.west, east: bounds.east,
  });
  const started = performance.now();
  console.log('[buildings] fetch start', bounds);
  const res = await fetch('/api/buildings?' + qs.toString());
  const dur = ((performance.now() - started) / 1000).toFixed(1);

  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    const parts = [];
    if (body?.error)  parts.push(body.error);
    if (body?.detail) parts.push(body.detail);
    if (body?.hint)   parts.push(body.hint);
    const detail = parts.join(' — ')
      || (await res.text().catch(() => '')).slice(0, 200);
    console.warn(`[buildings] fetch failed after ${dur}s:`, body || detail);
    throw new Error(`Building fetch failed (${res.status}) after ${dur}s: ${detail}`);
  }

  const json = await res.json();
  const mirror = res.headers.get('X-Overpass-Mirror') || '(unknown)';
  const count = (json.elements || []).length;
  console.log(`[buildings] fetch OK in ${dur}s via ${mirror}, ${count} OSM elements`);

  // An empty `elements` array combined with a `remark` field is Overpass's
  // way of saying "I tried but choked". Surface that as an error so the UI
  // doesn't just go quietly to 'no buildings found'.
  if (count === 0 && json.remark) {
    throw new Error(`Overpass returned no data with remark: "${json.remark}"`);
  }
  return json;
}

// Resolve a real-world height in metres for an OSM building element.
// Priority:
//   1. explicit `height` tag (parsed for "m"/"ft" suffix)
//   2. `building:levels` * LEVEL_HEIGHT_M
//   3. DEFAULT_HEIGHT_M flat fallback
// No type-based guessing and no jitter — see the comment on DEFAULT_HEIGHT_M
// for why we treat "no data" as visibly uniform rather than fake-varied.
function resolveHeightM(element) {
  const tags = element?.tags || {};

  if (tags.height) {
    const m = String(tags.height).match(/([\d.]+)\s*(m|ft)?/i);
    if (m) {
      const v = parseFloat(m[1]);
      if (isFinite(v)) return (m[2] || '').toLowerCase() === 'ft' ? v * 0.3048 : v;
    }
  }
  const lv = tags['building:levels'];
  if (lv != null) {
    const v = parseFloat(lv);
    if (isFinite(v)) return v * LEVEL_HEIGHT_M;
  }

  return DEFAULT_HEIGHT_M;
}

// Sample the heightmap at a (lon, lat) — returns puck-local Y in cm,
// matching the same formula used by buildTerrainBoxGeometry in puck.js.
function makeTerrainSampler(geoParams) {
  const { bounds, heightmap, baseThickness, terrainHeightCm, minH, heightRange } = geoParams;
  const { ncols, nrows, values } = heightmap;

  return function sampleTerrainY(lon, lat) {
    const cx = clamp01((lon - bounds.west)  / (bounds.east  - bounds.west));
    const cy = clamp01((bounds.north - lat) / (bounds.north - bounds.south));
    // Bilinear sample for smoother base placement than nearest-neighbour.
    const fx = cx * (ncols - 1);
    const fy = cy * (nrows - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(ncols - 1, x0 + 1);
    const y1 = Math.min(nrows - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const v00 = sample(values, y0 * ncols + x0);
    const v10 = sample(values, y0 * ncols + x1);
    const v01 = sample(values, y1 * ncols + x0);
    const v11 = sample(values, y1 * ncols + x1);
    const a = v00 * (1 - tx) + v10 * tx;
    const b = v01 * (1 - tx) + v11 * tx;
    const v = a * (1 - ty) + b * ty;
    const norm = (v - minH) / heightRange;
    return baseThickness + norm * terrainHeightCm;
  };
}
function sample(values, i) { const v = values[i]; return v == null ? 0 : v; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Convert an OSM way's geometry (array of {lat, lon}) into puck-local
// (x, z) cm coordinates + a centroid for terrain sampling.
function project(geometry, geoParams) {
  const { bounds, size } = geoParams;
  const half = size / 2;
  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  const pts = [];
  let cLon = 0, cLat = 0;
  for (const p of geometry) {
    const x = ((p.lon - bounds.west) / lonSpan) * size - half;
    const z = ((bounds.north - p.lat) / latSpan) * size - half;
    pts.push({ x, z, lon: p.lon, lat: p.lat });
    cLon += p.lon; cLat += p.lat;
  }
  const n = geometry.length;
  return { pts, centroidLon: cLon / n, centroidLat: cLat / n };
}

// Collect all building outlines from the Overpass response. For relations we
// just extract their member ways with role=outer; we deliberately don't
// support inner holes in v1 (most relations render fine without them).
// Each outline carries enough to compute a height (`element` for tags + id).
function collectOutlines(overpass) {
  const outlines = [];
  for (const el of overpass?.elements || []) {
    if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3) {
      outlines.push({ geometry: el.geometry, element: el });
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      // Synthesize a per-member element so each part gets a stable id for
      // the jitter, but shares the relation's tags (esp. building=type).
      for (const m of el.members) {
        if (m.type === 'way' && (m.role === 'outer' || !m.role) && Array.isArray(m.geometry) && m.geometry.length >= 3) {
          outlines.push({
            geometry: m.geometry,
            element: { tags: el.tags || {}, id: el.id * 1000 + (m.ref || 0) },
          });
        }
      }
    }
  }
  return outlines;
}

// Overwrite a geometry's UVs with a global top-down planar projection that
// matches the terrain's UV convention exactly:
//   u = (x + half) / size
//   v = (half - z) / size   (so north → v=1, south → v=0)
// Roofs sample the satellite pixel directly above them; side walls share the
// same XZ so they pick up a vertical streak of that pixel — intentionally
// messy, gives the buildings an organic painted-from-above look.
function applyPlanarXZUVs(geom, size) {
  const half = size / 2;
  const pos = geom.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    uv[i * 2 + 0] = (x + half) / size;
    uv[i * 2 + 1] = (half - z) / size;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// Per-vertex 0..1 "how high up the building's body am I?" — 0 at the base
// (sits on the terrain), 1 at the roof. The merged geometry preserves this
// per-building, so the shader can drive a ground-shade gradient that's
// anchored to each individual building's height rather than to global Y.
function applyVerticality(geom, baseY, heightCm) {
  const pos = geom.attributes.position;
  const v = new Float32Array(pos.count);
  const range = Math.max(heightCm, 0.0001);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - baseY) / range;
    v[i] = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  geom.setAttribute('aVerticality', new THREE.BufferAttribute(v, 1));
}

export function buildBuildingGroup(overpass, geoParams, opts = {}) {
  const sampleTerrainY = makeTerrainSampler(geoParams);
  const { size, widthM, albedoCanvas } = geoParams;
  const projectTexture = opts.projectTexture !== false; // default true
  const wallsOffWhite  = opts.wallsOffWhite === true;   // default false

  // Real metres → puck cm at true scale, then * BUILDING_VERTICAL_BOOST so
  // buildings actually read at puck scale. Z-exaggeration is deliberately
  // NOT applied: that's a topographic-stylisation knob, not a scene-wide
  // vertical scale — buildings keep their proportions to each other when
  // the surrounding terrain is stretched.
  const mToPuckCm = (size / widthM) * BUILDING_VERTICAL_BOOST;

  const outlines = collectOutlines(overpass);
  if (outlines.length > MAX_BUILDINGS) {
    console.warn(`OSM returned ${outlines.length} buildings — clipping to ${MAX_BUILDINGS} to stay performant`);
    outlines.length = MAX_BUILDINGS;
  }

  const geoms = [];
  let included = 0;

  for (const o of outlines) {
    const { pts, centroidLon, centroidLat } = project(o.geometry, geoParams);
    if (pts.length < 3) continue;

    // Cull buildings whose centroid falls outside the puck footprint —
    // Overpass can return ways whose bbox just touches our region.
    const half = size / 2;
    if (Math.abs(pts[0].x) > half + 0.1 && Math.abs(pts[0].z) > half + 0.1) continue;

    const heightM = resolveHeightM(o.element);
    const heightCm = Math.max(0.02, heightM * mToPuckCm);

    // Shape is built in (X, -Z) so that after rotateX(-π/2) the polygon
    // sits in the world XZ plane with its lat axis pointing the right way.
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, -pts[0].z);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
    shape.closePath();

    let g;
    try {
      g = new THREE.ExtrudeGeometry(shape, { depth: heightCm, bevelEnabled: false });
    } catch {
      continue; // degenerate polygon — skip
    }
    g.rotateX(-Math.PI / 2);

    // Lift to terrain top at this building's footprint. We sample the
    // centroid; for very large footprints this slightly floats one corner,
    // but it's vastly better than placing every building at z=0.
    const baseY = sampleTerrainY(centroidLon, centroidLat);
    g.translate(0, baseY, 0);

    // Planar UVs computed AFTER rotate+translate so they reflect the
    // building's final XZ position in puck space (XZ is unaffected by the
    // Y-translate so the order's mostly cosmetic, but be explicit).
    applyPlanarXZUVs(g, size);
    applyVerticality(g, baseY, heightCm);

    geoms.push(g);
    included++;
  }

  const group = new THREE.Group();
  group.name = 'osm-buildings';

  if (!geoms.length) return group;

  // Merge into one buffer per material — single draw call for the whole city.
  const merged = mergeGeometries(geoms, false);
  const mat = makeBuildingMaterial(projectTexture ? albedoCanvas : null, { wallsOffWhite });
  // mergeGeometries returns null if the inputs are inconsistent; fall back
  // to a non-indexed concat by adding each geom individually. Rare.
  if (!merged) {
    for (const g of geoms) group.add(new THREE.Mesh(g, mat));
  } else {
    group.add(new THREE.Mesh(merged, mat));
    for (const g of geoms) g.dispose();
  }

  group.userData.buildingCount = included;
  return group;
}

// Build the building material with two stylising shader patches:
//   1. Ground-shade gradient — anchored to each building's own height via the
//      per-vertex aVerticality attribute. The bottom of every building is
//      multiplied by uGroundShade (default 0.55), fading smoothly to no
//      darkening by roughly half the building's height. Gives the AO-at-base
//      look that osmbuildings.org has.
//   2. Optional off-white walls — when uWallsOffWhite is on, side faces
//      (those whose world-space normal points sideways) replace the planar-
//      projected texture with a flat warm off-white. Roof faces (normal.y
//      near +1) keep the satellite texture as before.
// flatShading is OFF because ExtrudeGeometry already duplicates vertices
// per face, so the per-face input normals carry through cleanly — and we
// need them as a world-space varying for the roof/wall discrimination.
const GROUND_SHADE_DEFAULT = 0.55;

function makeBuildingMaterial(albedoCanvas, { wallsOffWhite = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: albedoCanvas ? makeAlbedoTex(albedoCanvas) : null,
    color: albedoCanvas ? 0xe8e4dc : 0xdcd6c8,
    roughness: 0.85,
    metalness: 0.0,
    envMapIntensity: 0.5,
  });

  mat.userData.uGroundShade   = { value: GROUND_SHADE_DEFAULT };
  mat.userData.uWallsOffWhite = { value: wallsOffWhite ? 1.0 : 0.0 };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGroundShade   = mat.userData.uGroundShade;
    shader.uniforms.uWallsOffWhite = mat.userData.uWallsOffWhite;

    // ---- vertex: ship aVerticality and world-space normal as varyings ----
    shader.vertexShader =
      `attribute float aVerticality;
       varying   float vVerticality;
       varying   vec3  vWorldNormalB;
       ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>
       vVerticality  = aVerticality;
       vWorldNormalB = normalize(mat3(modelMatrix) * normal);`,
    );

    // ---- fragment: apply roof/wall split, then the ground-shade gradient ---
    shader.fragmentShader =
      `uniform float uGroundShade;
       uniform float uWallsOffWhite;
       varying float vVerticality;
       varying vec3  vWorldNormalB;
       ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>

       // Off-white walls: blend the textured colour toward a warm off-white
       // for faces whose world normal isn't pointing up. Roofs (normal.y
       // close to +1) stay fully textured; walls (normal.y near 0) flip to
       // the flat colour.
       if (uWallsOffWhite > 0.5) {
         float roofness = smoothstep(0.45, 0.85, vWorldNormalB.y);
         vec3 wallColor = vec3(0.93, 0.92, 0.89);
         diffuseColor.rgb = mix(wallColor, diffuseColor.rgb, roofness);
       }

       // Ground-shade gradient: bottom of each building darkened down to
       // uGroundShade, fading back to 1.0 by ~half-height. Anchored per
       // building via vVerticality so heights mix correctly.
       float shade = mix(uGroundShade, 1.0, smoothstep(0.0, 0.5, vVerticality));
       diffuseColor.rgb *= shade;
      `,
    );
  };
  return mat;
}

function makeAlbedoTex(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function disposeBuildingGroup(group) {
  if (!group) return;
  group.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material?.dispose();
    }
  });
}
