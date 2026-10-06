# 4DGS-VR

Play [4DGaussians](https://github.com/hustvl/4DGaussians) dynamic scenes in VR (Quest browser / any WebXR headset).

**Live demo:** https://sirjoeyama.github.io/4DGS-VR/ (open it in the Quest browser and press Enter VR). Every push to `main` rebuilds `viewer/` and deploys it to GitHub Pages; the demo scene is the committed `viewer/public/scenes/jumpingjacks.4dgsv` (other scenes stay git-ignored).

- `4DGaussians/`: vendored upstream repo at commit [`843d5ac`](https://github.com/hustvl/4DGaussians/tree/843d5ac636c37e4b611242287754f3d4ed150144) (see its `LICENSE.md`: non-commercial research use) plus:
  - `compat/`: drop-in shims so nothing needs compiling on Windows:
    `diff_gaussian_rasterization` (backed by gsplat 1.5.3, keeps the Inria API incl. densification
    gradients), `simple_knn._C.distCUDA2` (torch KNN), and `mmcv.Config` (config loading only).
    Registered in the venv by `.venv/Lib/site-packages/4dgs_compat.pth`.
  - `export_vr.py`: bakes the deformation field into a `.4dgsv` sequence (~16 bytes/splat/frame).
  - `requirements-gsplat.txt`: torch 2.4.1+cu124 / Python 3.10 environment.
  - Patch: `scene/dataset_readers.py` uses `np.uint8` instead of `np.byte` (newer Pillow).
- `viewer/`: Vite + three.js + Spark 2.3.1 WebXR player.

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

## Limits

- View-dependent colour (higher SH bands) is dropped; colour comes from the DC term only.
- Frames are baked, so playback steps at the export `--fps`; raise `--frames` for smoother motion
  (file size grows linearly, ~0.35 MB per frame for 22k splats).
- Real-world captures (DyNeRF / HyperNeRF) have 100k–300k+ splats; expect to lower `--frames` or
  raise `--min_opacity` to keep Quest standalone performance and memory in check.
