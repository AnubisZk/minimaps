// 3D model exporters - STL for 3D printing, OBJ for editors (Blender/Maya/etc),
// GLB for textured-3D distribution (web, Unity, Unreal, Blender import).

import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportSTL(puck, name) {
  const exporter = new STLExporter();
  const result = exporter.parse(puck.mesh, { binary: true });
  download(new Blob([result], { type: 'application/octet-stream' }),
           (name || 'minimap-puck') + '.stl');
}

export function exportOBJ(puck, name) {
  const exporter = new OBJExporter();
  const text = exporter.parse(puck.mesh);
  download(new Blob([text], { type: 'text/plain' }),
           (name || 'minimap-puck') + '.obj');
}

// GLB is the binary glTF container. Includes geometry, materials, AND the
// embedded texture (albedo) - recipients get a fully self-contained model
// that opens in any glTF-capable viewer / engine.
export function exportGLB(puck, name) {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      puck.mesh,
      (result) => {
        download(new Blob([result], { type: 'model/gltf-binary' }),
                 (name || 'minimap-puck') + '.glb');
        resolve();
      },
      (err) => reject(err),
      { binary: true, embedImages: true },
    );
  });
}
