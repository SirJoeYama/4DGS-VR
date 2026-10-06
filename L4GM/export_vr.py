"""Convert L4GM per-frame Gaussians (saved by infer_4d.py) into a .4dgsv v2 sequence.

Usage:
  python export_vr.py results/w_interp_<name>_gaussians.pt --out ../viewer/public/scenes/<name>.4dgsv

v2 layout (little endian): "4DGV" | u32 header_len | header JSON (padded to 4 bytes), then per frame:
  pos f16 [N*3] | scale f16 [N*3] | quat i8 [N*4] (x,y,z,w * 127) | rgba u8 [N*4]
L4GM predicts every frame independently, so colour and opacity are stored per frame.
"""
import argparse
import json
import os
import struct

import numpy as np
import torch

ap = argparse.ArgumentParser()
ap.add_argument("gaussians", help="*_gaussians.pt written by infer_4d.py")
ap.add_argument("--out", required=True)
ap.add_argument("--min_opacity", type=float, default=0.02,
                help="drop splats whose opacity stays below this in every frame")
ap.add_argument("--max_frames", type=int, default=0, help="0 = all")
ap.add_argument("--halo", type=float, default=0.85,
                help="drop faint splats (max opacity < 0.5) whose mean colour is brighter than this; "
                     "they are white-background fringes. 1 disables")
args = ap.parse_args()

data = torch.load(args.gaussians, map_location="cpu", weights_only=True)
g = data["gaussians"][0].float()  # [T, N, 14]: pos3 opacity1 scale3 rot4(wxyz) rgb3
if args.max_frames:
    g = g[: args.max_frames]
T = g.shape[0]

max_opacity = g[:, :, 3].amax(0)
keep = max_opacity >= args.min_opacity
if args.halo < 1:
    keep &= ~((g[:, :, 11:14].mean((0, 2)) > args.halo) & (max_opacity < 0.5))
g = g[:, keep]
n = g.shape[1]
print(f"Keeping {n}/{keep.numel()} splats over {T} frames")

pos = g[..., 0:3]
lo = pos.reshape(-1, 3).amin(0).tolist()
hi = pos.reshape(-1, 3).amax(0).tolist()

header = json.dumps({
    "version": 2,
    "numSplats": n,
    "numFrames": T,
    "fps": data["fps"],
    "bboxMin": lo,
    "bboxMax": hi,
    "upAxis": "y",  # LGM/L4GM object space is y-up
    "source": os.path.basename(args.gaussians).replace("_gaussians.pt", ""),
}).encode()
header += b" " * (-len(header) % 4)

os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
with open(args.out, "wb") as f:
    f.write(b"4DGV" + struct.pack("<I", len(header)) + header)
    for t in range(T):
        fr = g[t]
        q = torch.nn.functional.normalize(fr[:, 7:11], dim=1)[:, [1, 2, 3, 0]]
        rgba = torch.cat([fr[:, 11:14].clamp(0, 1), fr[:, 3:4].clamp(0, 1)], dim=1)
        f.write(fr[:, 0:3].numpy().astype(np.float16).tobytes())
        f.write(fr[:, 4:7].numpy().astype(np.float16).tobytes())
        f.write((q * 127).round().clamp(-127, 127).to(torch.int8).numpy().tobytes())
        f.write((rgba * 255).round().to(torch.uint8).numpy().tobytes())
print(f"Wrote {args.out}: {n} splats x {T} frames @ {data['fps']:.1f} fps, "
      f"{os.path.getsize(args.out) / 1e6:.1f} MB")
