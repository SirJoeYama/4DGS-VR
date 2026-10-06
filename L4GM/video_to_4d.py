"""One video in, one .4dgsv out: background removal -> square crop -> L4GM 3D -> L4GM 4D -> export.

Usage:
  .venv/Scripts/python.exe video_to_4d.py my_clip.mp4 --name myclip --seconds 3
  .venv/Scripts/python.exe video_to_4d.py data_test/otter-on-surfboard_fg.mp4 --name otter --no-matte

Works best on a single subject (person, animal, object) that stays fully in frame, filmed from
one side with a mostly static camera. The hidden side is invented by ImageDream.
"""
import argparse
import os
import subprocess
import sys

import cv2
import imageio.v3 as iio
import imageio_ffmpeg
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable

ap = argparse.ArgumentParser()
ap.add_argument("video")
ap.add_argument("--name", default=None, help="output name (default: video file name)")
ap.add_argument("--start", type=float, default=0.0, help="start time in seconds")
ap.add_argument("--seconds", type=float, default=3.0, help="clip length to convert (0 = all)")
ap.add_argument("--no-matte", action="store_true", help="input already has a white background")
ap.add_argument("--fill", type=float, default=0.85, help="subject size relative to the square crop")
ap.add_argument("--interp", action="store_true",
                help="export the 3x interpolated sequence (smoother, 3x larger) instead of 15 fps")
ap.add_argument("--preview", action="store_true", help="also render L4GM's orbit preview videos")
ap.add_argument("--out", default=None, help="default: ../viewer/public/scenes/<name>.4dgsv")
args = ap.parse_args()

name = args.name or os.path.splitext(os.path.basename(args.video))[0]
work = os.path.join(HERE, "results", name)
os.makedirs(work, exist_ok=True)
# Kept out of the workspace: infer_3d.py writes its orbit preview to <workspace>/<name>.mp4.
os.makedirs(os.path.join(work, "input"), exist_ok=True)
clip_path = os.path.join(work, "input", f"{name}.mp4")

# ---------------------------------------------------------------- 1. read + trim
meta = iio.immeta(args.video)
fps = float(meta.get("fps") or 30)
frames = iio.imread(args.video)  # [T, H, W, 3]
first = int(args.start * fps)
last = len(frames) if args.seconds <= 0 else min(len(frames), first + int(round(args.seconds * fps)))
frames = frames[first:last]
if len(frames) < 2:
    sys.exit("Clip is too short after trimming")
print(f"[1/5] {len(frames)} frames @ {fps:.1f} fps from {args.video}")

# ---------------------------------------------------------------- 2. matte
if args.no_matte:
    alphas = (frames.astype(np.float32).min(-1) < 250).astype(np.float32)  # non-white pixels
else:
    from transformers import AutoModelForImageSegmentation
    print("[2/5] Removing background with BiRefNet")
    net = AutoModelForImageSegmentation.from_pretrained("ZhengPeng7/BiRefNet", trust_remote_code=True)
    net = net.cuda().half().eval()
    mean = torch.tensor([0.485, 0.456, 0.406], device="cuda").view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225], device="cuda").view(1, 3, 1, 1)
    alphas = []
    with torch.no_grad():
        for fr in frames:
            x = torch.from_numpy(cv2.resize(fr, (1024, 1024), interpolation=cv2.INTER_AREA)).cuda()
            x = ((x.permute(2, 0, 1)[None].float() / 255 - mean) / std).half()
            a = net(x)[-1].sigmoid()[0, 0].float().cpu().numpy()
            alphas.append(cv2.resize(a, (fr.shape[1], fr.shape[0]), interpolation=cv2.INTER_LINEAR))
    alphas = np.stack(alphas)
    del net
    torch.cuda.empty_cache()

# ---------------------------------------------------------------- 3. square crop on white
ys, xs = np.nonzero(alphas.max(0) > 0.5)
if len(xs) == 0:
    sys.exit("No subject found in the video")
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
side = max(xs.max() - xs.min(), ys.max() - ys.min()) / args.fill
x0, y0 = int(round(cx - side / 2)), int(round(cy - side / 2))
S = int(round(side))
out = []
for fr, a in zip(frames, alphas):
    comp = fr.astype(np.float32) * a[..., None] + 255 * (1 - a[..., None])
    canvas = np.full((S, S, 3), 255, np.float32)
    sx0, sy0 = max(x0, 0), max(y0, 0)
    sx1, sy1 = min(x0 + S, fr.shape[1]), min(y0 + S, fr.shape[0])
    canvas[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = comp[sy0:sy1, sx0:sx1]
    out.append(cv2.resize(canvas, (512, 512), interpolation=cv2.INTER_AREA).clip(0, 255).astype(np.uint8))
writer = imageio_ffmpeg.write_frames(clip_path, (512, 512), fps=fps, quality=9)
writer.send(None)
for fr in out:
    writer.send(np.ascontiguousarray(fr))
writer.close()
print(f"[3/5] Wrote cropped subject clip {clip_path}")


# ---------------------------------------------------------------- 4. L4GM
def run(cmd, env=None):
    print(">", " ".join(cmd))
    subprocess.run(cmd, cwd=HERE, check=True, env={**os.environ, **(env or {})})


common = ["big", "--workspace", work, "--resume", "pretrained/recon.safetensors", "--test_path", clip_path]
print("[4/5] L4GM: multi-view first frame (ImageDream) + 3D")
run([PY, "infer_3d.py", *common, "--num_frames", "1"])
print("[4/5] L4GM: 4D reconstruction + interpolation")
run([PY, "infer_4d.py", *common, "--num_frames", "16", "--interpresume", "pretrained/interp.safetensors"],
    env=None if args.preview else {"L4GM_SKIP_PREVIEW": "1"})

# ---------------------------------------------------------------- 5. export
variant = "w_interp" if args.interp else "wo_interp"
out_path = args.out or os.path.join(HERE, "..", "viewer", "public", "scenes", f"{name}.4dgsv")
print("[5/5] Export")
run([PY, "export_vr.py", os.path.join(work, f"{variant}_{name}_gaussians.pt"), "--out", out_path])
print(f"\nDone. Open the viewer with ?url=scenes/{name}.4dgsv")
