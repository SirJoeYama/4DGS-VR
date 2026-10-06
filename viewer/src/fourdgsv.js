// Loader for .4dgsv sequences written by 4DGaussians/export_vr.py.
// Decodes every frame straight into Spark's packed splat layout (4 x u32 per splat), so
// playback only swaps which Uint32Array the PackedSplats texture points at.
import * as THREE from "three";
import { utils } from "@sparkjsdev/spark";

const LN_SCALE_MIN = -12;
const LN_SCALE_MAX = 9;
const LN_SCALE_K = 254 / (LN_SCALE_MAX - LN_SCALE_MIN);

// fromHalf() for all 65536 bit patterns, then ln-scale byte per pattern (scales are positive).
const SCALE_BYTE = new Uint8Array(65536);
for (let h = 0; h < 65536; h++) {
  const s = utils.fromHalf(h);
  SCALE_BYTE[h] = !(s > 1e-20) ? 0
    : Math.min(255, Math.max(1, Math.round((Math.log(s) - LN_SCALE_MIN) * LN_SCALE_K) + 1));
}

export function parseHeader(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== "4DGV") throw new Error("Not a .4dgsv file");
  const len = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, len)));
  return { header, dataOffset: 8 + len };
}

/**
 * @param {ArrayBuffer} buffer
 * @param {number} maxSplats  capacity of each frame array (from utils.computeMaxSplats)
 * @param {(done: number, total: number) => void} onProgress
 */
export async function decodeFrames(buffer, maxSplats, onProgress) {
  const { header, dataOffset } = parseHeader(buffer);
  const n = header.numSplats;
  const rgba = new Uint32Array(buffer.slice(dataOffset, dataOffset + n * 4));
  const frameBytes = n * 16;
  const base = dataOffset + n * 4;
  const q = new THREE.Quaternion();
  const frames = [];

  for (let f = 0; f < header.numFrames; f++) {
    const off = base + f * frameBytes;
    const pos = new Uint16Array(buffer, off, n * 3);
    const scl = new Uint16Array(buffer, off + n * 6, n * 3);
    const quat = new Int8Array(buffer, off + n * 12, n * 4);
    const out = new Uint32Array(maxSplats * 4);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3, i4 = i * 4;
      q.set(quat[i4] / 127, quat[i4 + 1] / 127, quat[i4 + 2] / 127, quat[i4 + 3] / 127).normalize();
      const uq = utils.encodeQuatOctXy88R8(q);
      out[i4] = rgba[i];
      out[i4 + 1] = pos[i3] | (pos[i3 + 1] << 16);
      out[i4 + 2] = pos[i3 + 2] | ((uq & 255) << 16) | (((uq >>> 8) & 255) << 24);
      out[i4 + 3] = (SCALE_BYTE[scl[i3]] | (SCALE_BYTE[scl[i3 + 1]] << 8)
        | (SCALE_BYTE[scl[i3 + 2]] << 16) | (((uq >>> 16) & 255) << 24)) >>> 0;
    }
    frames.push(out);
    onProgress?.(f + 1, header.numFrames);
    // Yield so the page (and the progress text) stays responsive on Quest.
    if (f % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  return { header, frames };
}
