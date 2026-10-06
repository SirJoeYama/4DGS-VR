# 4DGS-VR

Play 4D Gaussian splats in VR (Quest browser / any WebXR headset), made either by training
[4DGaussians](https://github.com/hustvl/4DGaussians) on multi-view data or from **a single video**
with NVIDIA's [L4GM](https://github.com/nv-tlabs/L4GM-official).

**Live demo:** https://sirjoeyama.github.io/4DGS-VR/ (open it in the Quest browser and press Enter VR). Every push to `main` rebuilds `viewer/` and deploys it to GitHub Pages; the committed demo scenes are `jumpingjacks.4dgsv` (4DGaussians) and
[`dancing_robot.4dgsv`](https://sirjoeyama.github.io/4DGS-VR/?url=scenes/dancing_robot.4dgsv) (L4GM, from one
video); other scenes in `viewer/public/scenes/` stay git-ignored.

- `4DGaussians/`: vendored upstream repo at commit [`843d5ac`](https://github.com/hustvl/4DGaussians/tree/843d5ac636c37e4b611242287754f3d4ed150144) (see its `LICENSE.md`: non-commercial research use) plus:
  - `compat/`: drop-in shims so nothing needs compiling on Windows:
    `diff_gaussian_rasterization` (backed by gsplat 1.5.3, keeps the Inria API incl. densification
    gradients), `simple_knn._C.distCUDA2` (torch KNN), and `mmcv.Config` (config loading only).
    Registered in the venv by `.venv/Lib/site-packages/4dgs_compat.pth`.
  - `export_vr.py`: bakes the deformation field into a `.4dgsv` sequence (~16 bytes/splat/frame).
  - `requirements-gsplat.txt`: torch 2.4.1+cu124 / Python 3.10 environment.
  - Patch: `scene/dataset_readers.py` uses `np.uint8` instead of `np.byte` (newer Pillow).
- `L4GM/`: vendored upstream repo at commit [`b857d67`](https://github.com/nv-tlabs/L4GM-official/tree/b857d670bda83a569e2bad774afe56483d7a8674) (Apache-2.0) plus:
  - `video_to_4d.py`: one video in, `.4dgsv` out (BiRefNet background removal, square crop on white,
    ImageDream + L4GM 3D, L4GM 4D, export).
  - `export_vr.py`: writes `.4dgsv` v2 (per-frame colour/opacity, ~20 bytes/splat/frame) and drops
    faint near-white "halo" splats left by the white background.
  - Patch: `infer_4d.py` saves the per-frame Gaussians and can skip its preview renders
    (`L4GM_SKIP_PREVIEW=1`).
  - `requirements-win.txt`: torch 2.4.1+cu124, gsplat 1.5.3, xformers 0.0.28.post1, kiui 0.2.9
    (newer kiui is broken), diffusers 0.27.2.
- `viewer/`: Vite + three.js + Spark 2.3.1 WebXR player (reads `.4dgsv` v1 and v2).

## Setup (once)

```bash
cd 4DGaussians
py -V:Astral/CPython3.10.21 -m venv .venv
python -m uv pip install --python .venv/Scripts/python.exe --extra-index-url https://download.pytorch.org/whl/cu124 --index-strategy unsafe-best-match -r requirements-gsplat.txt
echo C:/dev/4DGS-VR/4DGaussians/compat > .venv/Lib/site-packages/4dgs_compat.pth
cd ../viewer && npm install
```

D-NeRF data goes in `4DGaussians/data/dnerf/<scene>` (from the Dropbox link in the upstream README).

## Train, export, view

```bash
cd 4DGaussians
.venv/Scripts/python.exe train.py -s data/dnerf/jumpingjacks --expname dnerf/jumpingjacks --configs arguments/dnerf/jumpingjacks.py
.venv/Scripts/python.exe export_vr.py --model_path output/dnerf/jumpingjacks --configs arguments/dnerf/jumpingjacks.py --frames 100 --fps 25 --out ../viewer/public/scenes/jumpingjacks.4dgsv
cd ../viewer && npm run dev
```

Open http://localhost:5180 (loads `scenes/jumpingjacks.4dgsv`; others via `?url=scenes/x.4dgsv`,
Open…, or drag & drop). jumpingjacks trains in ~8 min on an RTX 4060 Ti (36 dB PSNR).

**On the Quest:** run `npm run dev:quest` (HTTPS on the LAN with a self-signed cert), open
`https://<pc-ip>:5180` in the Quest browser, accept the certificate warning, press **Enter VR**.
Alternatively, with USB: `adb reverse tcp:5180 tcp:5180` and open `http://localhost:5180`.

VR controls: thumbsticks move/turn, A/X play/pause, B restart, Y cycle size (life, ½, ¼, 2×).

## From a single video (L4GM)

Setup once (~8 GB of weights):

```bash
cd L4GM
py -V:Astral/CPython3.10.21 -m venv .venv
python -m uv pip install --python .venv/Scripts/python.exe --extra-index-url https://download.pytorch.org/whl/cu124 --index-strategy unsafe-best-match -r requirements-win.txt
mkdir pretrained
curl -L -o pretrained/recon.safetensors https://huggingface.co/jiawei011/L4GM/resolve/main/recon.safetensors
curl -L -o pretrained/interp.safetensors https://huggingface.co/jiawei011/L4GM/resolve/main/interp.safetensors
```

ImageDream and BiRefNet download into the Hugging Face cache on first run. Then:

```bash
.venv/Scripts/python.exe video_to_4d.py my_clip.mp4 --name myclip --seconds 3
```

This writes `viewer/public/scenes/myclip.4dgsv`; open the viewer with `?url=scenes/myclip.4dgsv`.
A 2-second clip takes about a minute on an RTX 4060 Ti. Options: `--start` (seconds), `--seconds 0`
(whole clip), `--interp` (3× frame rate, 3× file size), `--no-matte` (input already on white),
`--preview` (L4GM's orbit preview videos in `results/<name>/`).

Good input: one subject (person, animal, object) that stays fully in frame, a mostly static camera,
a few seconds long. L4GM sees one side only; the back is invented by ImageDream from the first
frame, so it looks plausible but soft. Output is a ~1.8 m tall object, not a whole environment.

## Limits

- 4DGaussians: view-dependent colour (higher SH bands) is dropped; colour comes from the DC term only.
- L4GM: ~20–35k splats at 15–16 fps is ~0.7 MB per frame; keep clips short (GitHub rejects files over
  100 MB, and the Quest has to hold every decoded frame in memory).
- Frames are baked, so playback steps at the export `--fps`; raise `--frames` for smoother motion
  (file size grows linearly, ~0.35 MB per frame for 22k splats).
- Real-world captures (DyNeRF / HyperNeRF) have 100k–300k+ splats; expect to lower `--frames` or
  raise `--min_opacity` to keep Quest standalone performance and memory in check.
