"""Bake a trained 4DGaussians model into a .4dgsv sequence for the WebXR viewer.

Usage:
  python export_vr.py --model_path output/dnerf/jumpingjacks --configs arguments/dnerf/jumpingjacks.py \
      --frames 100 --fps 25 --out ../viewer/public/scenes/jumpingjacks.4dgsv

File layout (little endian):
  "4DGV" | u32 header_len | header JSON (padded to 4 bytes)
  rgba   u8  [N*4]                      colour (SH DC) + opacity, constant over time
  frames (T times):
    pos   f16 [N*3]
    scale f16 [N*3]                     activated (linear) scales
    quat  i8  [N*4]                     normalized x,y,z,w * 127
Opacity and colour deformation are off by default in 4DGS (no_do / no_dshs), so they are
stored once; if a model deforms them, the colour/opacity at t=0 is used.
"""
import json
import os
import struct
from argparse import ArgumentParser

import numpy as np
import torch

from arguments import ModelParams, PipelineParams, get_combined_args, ModelHiddenParams
from scene import Scene
from gaussian_renderer import GaussianModel
from utils.general_utils import safe_state

SH_C0 = 0.28209479177387814

parser = ArgumentParser(description="Bake 4DGS to a .4dgsv sequence")
model = ModelParams(parser, sentinel=True)
pipeline = PipelineParams(parser)
hyperparam = ModelHiddenParams(parser)
parser.add_argument("--iteration", default=-1, type=int)
parser.add_argument("--configs", type=str)
parser.add_argument("--frames", default=100, type=int, help="timesteps sampled over t in [0,1]")
parser.add_argument("--fps", default=25.0, type=float, help="playback rate stored in the file")
parser.add_argument("--min_opacity", default=0.01, type=float, help="drop splats below this opacity")
parser.add_argument("--out", type=str, default=None)
parser.add_argument("--quiet", action="store_true")
args = get_combined_args(parser)
if args.configs:
    import mmcv
    from utils.params_utils import merge_hparams
    args = merge_hparams(args, mmcv.Config.fromfile(args.configs))
safe_state(args.quiet)

with torch.no_grad():
    gaussians = GaussianModel(args.sh_degree, hyperparam.extract(args))
    Scene(model.extract(args), gaussians, load_iteration=args.iteration, shuffle=False)

    xyz = gaussians.get_xyz
    n_all = xyz.shape[0]

    def state(t):
        time = torch.full((n_all, 1), float(t), device=xyz.device)
        means, scales, rots, opac, shs = gaussians._deformation(
            xyz, gaussians._scaling, gaussians._rotation, gaussians._opacity,
            gaussians.get_features, time)
        return (means, gaussians.scaling_activation(scales),
                gaussians.rotation_activation(rots), gaussians.opacity_activation(opac), shs)

    _, _, _, opac0, shs0 = state(0.0)
    keep = opac0[:, 0] >= args.min_opacity
    n = int(keep.sum())
    print(f"Keeping {n}/{n_all} splats (opacity >= {args.min_opacity})")

    rgb = (0.5 + SH_C0 * shs0[keep, 0, :]).clamp(0, 1)
    rgba = torch.cat([rgb, opac0[keep]], dim=1)
    rgba = (rgba * 255).round().to(torch.uint8).cpu().numpy()

    frames = []
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for i in range(args.frames):
        t = i / max(args.frames - 1, 1)
        means, scales, rots, _, _ = state(t)
        means, scales, rots = means[keep], scales[keep], rots[keep]
        # Inria quats are (w,x,y,z); store (x,y,z,w) to match three.js.
        q = torch.nn.functional.normalize(rots, dim=1)[:, [1, 2, 3, 0]]
        q = (q * 127).round().clamp(-127, 127).to(torch.int8)
        m = means.cpu().numpy()
        lo = np.minimum(lo, m.min(0))
        hi = np.maximum(hi, m.max(0))
        frames.append(m.astype(np.float16).tobytes()
                      + scales.cpu().numpy().astype(np.float16).tobytes()
                      + q.cpu().numpy().tobytes())

header = json.dumps({
    "version": 1,
    "numSplats": n,
    "numFrames": args.frames,
    "fps": args.fps,
    "bboxMin": lo.tolist(),
    "bboxMax": hi.tolist(),
    "upAxis": "z" if "dnerf" in args.model_path.replace("\\", "/") else "y",
    "source": os.path.basename(os.path.normpath(args.model_path)),
}).encode()
header += b" " * (-len(header) % 4)

out = args.out or os.path.join(args.model_path, os.path.basename(os.path.normpath(args.model_path)) + ".4dgsv")
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with open(out, "wb") as f:
    f.write(b"4DGV" + struct.pack("<I", len(header)) + header)
    f.write(rgba.tobytes())
    for fr in frames:
        f.write(fr)
print(f"Wrote {out}: {n} splats x {args.frames} frames, {os.path.getsize(out) / 1e6:.1f} MB")
