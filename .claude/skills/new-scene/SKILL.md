---
name: new-scene
description: Turn a video into a .4dgsv scene with L4GM, check it fits the Quest and GitHub, and optionally publish it to GitHub Pages. Use as /new-scene <video> [name] [--start s] [--seconds s] [--interp] [--no-matte] [--publish].
disable-model-invocation: true
---

# New scene: video → `.4dgsv` → (optionally) GitHub Pages

Arguments: `$ARGUMENTS` — a video path (required), an optional scene name, and any of
`--start <s>`, `--seconds <s>` (default 3, `0` = whole clip), `--interp`, `--no-matte`, `--publish`.
If no video path is given, ask for one and stop.

## 1. Prepare

- Resolve the video path to an absolute path and check it exists.
- Name: the given one, else the video file name; keep only `[A-Za-z0-9_-]` (others → `_`, max 48
  chars). If `viewer/public/scenes/<name>.4dgsv` already exists, ask before overwriting.
- GPU check: `curl -s http://127.0.0.1:8766/health`. If it answers with `"busy": true`, the
  generator is running a job on the same GPU — tell the user and ask whether to wait or stop.

## 2. Generate

Run from `L4GM/`, in the background (it takes ~1 min for 2 s of video on the RTX 4060 Ti, longer
with `--interp`), and wait for it to finish rather than polling:

```bash
cd L4GM && L4GM_SKIP_PREVIEW=1 .venv/Scripts/python.exe video_to_4d.py "<video>" --name <name> --start <s> --seconds <s> [--interp] [--no-matte]
```

It prints `[k/5]` stage lines and writes `viewer/public/scenes/<name>.4dgsv`. On failure, show the
last error lines of the output and stop.

## 3. Check the result

Read the header (magic `4DGV`, u32 little-endian length, then JSON) and report splats, frames,
fps and file size:

```bash
python -c "import json,struct,sys,os;b=open(sys.argv[1],'rb').read(4096);n=struct.unpack('<I',b[4:8])[0];h=json.loads(b[8:8+n]);print(h['numSplats'],'splats x',h['numFrames'],'frames @',h['fps'],'fps,',round(os.path.getsize(sys.argv[1])/1e6,1),'MB')" viewer/public/scenes/<name>.4dgsv
```

- Over **100 MB**: GitHub will reject it — it can't be published; suggest a shorter `--seconds`
  or dropping `--interp`.
- Over **~60 MB**: warn that the Quest holds every decoded frame in memory and may struggle.

Then give the local links: `https://localhost:5180/?url=scenes/<name>.4dgsv` on the PC and
`https://<wifi-ip>:5180/?url=scenes/<name>.4dgsv` on the Quest (the Wi-Fi IP is the private
192.168/10/172.16-31 address on an adapter with a gateway — ignore the `54.232.x` Topaz
loopback adapter). These need the viewer running (desktop shortcut / `start.cmd`).

## 4. Publish (only with `--publish`, or if the user says yes when asked)

Ask first if `--publish` wasn't given. Scenes are git-ignored except listed ones, so add the
exception to **both** files, next to the existing `dancing_robot` lines:

- `.gitignore`: `!viewer/public/scenes/<name>.4dgsv`
- `viewer/.gitignore`: `!public/scenes/<name>.4dgsv`

Confirm with `git check-ignore -v viewer/public/scenes/<name>.4dgsv` (should print nothing), then
stage only those two files and the scene, commit on `main` with a message like
`Add the <name> demo scene (L4GM, from one video)` (end it with the Co-Authored-By line), and push.
Link the Pages workflow run (`gh run list --limit 1`) and the future URL:
`https://sirjoeyama.github.io/4DGS-VR/?url=scenes/<name>.4dgsv` (live once the run finishes).
