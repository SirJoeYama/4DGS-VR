"""Local generator server for the viewer's Create page: upload a video, get a .4dgsv.

Run (from L4GM/):
  .venv/Scripts/python.exe -m uvicorn server:app --host 127.0.0.1 --port 8766

Jobs run one at a time (one GPU) through video_to_4d.py; results are written to
viewer/public/scenes/ (so the Vite dev server serves them too) and served at /scenes/<name>.4dgsv.
"""
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import deque

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

HERE = os.path.dirname(os.path.abspath(__file__))
SCENES = os.path.normpath(os.path.join(HERE, "..", "viewer", "public", "scenes"))
UPLOADS = os.path.join(HERE, "results", "_uploads")
os.makedirs(SCENES, exist_ok=True)
os.makedirs(UPLOADS, exist_ok=True)

app = FastAPI(title="4DGS generator")
# Only the viewer (Vite dev/preview on this PC or the LAN, or the GitHub Pages copy) may call
# this server from a browser; any other site the user has open must not queue GPU jobs.
ALLOWED_ORIGIN = re.compile(
    r"^(https?://(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+"
    r"|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?|https://sirjoeyama\.github\.io)$")
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
app.add_middleware(CORSMiddleware, allow_origin_regex=ALLOWED_ORIGIN.pattern,
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def origin_guard(request, call_next):
    # CORS only hides responses; a plain form POST from another site would still be executed,
    # so refuse foreign origins outright. Requests without an Origin (curl, scripts) are allowed.
    origin = request.headers.get("origin")
    if origin and not ALLOWED_ORIGIN.match(origin):
        return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
    response = await call_next(request)
    if origin:
        # Lets the HTTPS GitHub Pages copy of the Create page reach this localhost server in Chrome.
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


# ------------------------------------------------------------------ jobs
# Progress bands per pipeline stage (video_to_4d.py prints "[k/5]" at each stage).
STAGES = {
    1: (0.00, 0.03, "Reading video"),
    2: (0.03, 0.20, "Removing background"),
    3: (0.20, 0.25, "Cropping subject"),
    4: (0.25, 0.95, "Generating views + 4D"),
    5: (0.95, 1.00, "Exporting"),
}
JOBS: dict[str, dict] = {}
QUEUE: deque[str] = deque()
LOCK = threading.Lock()
WAKE = threading.Event()


def public(job):
    return {k: v for k, v in job.items() if not k.startswith("_")}


def unique_name(raw):
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", raw).strip("_")[:48] or "clip"
    name, i = base, 2
    taken = {j["name"] for j in JOBS.values() if j["status"] in ("queued", "running")}
    while name in taken or os.path.exists(os.path.join(SCENES, f"{name}.4dgsv")):
        name, i = f"{base}-{i}", i + 1
    return name


def handle_line(job, line):
    job["_log"].append(line)
    m = re.match(r"\[(\d)/5\]\s*(.*)", line)
    if m:
        k = int(m.group(1))
        lo, _, label = STAGES.get(k, (job["progress"], 0, line))
        job["stage"], job["stageLabel"] = k, label
        if "multi-view" in m.group(2):
            job["stageLabel"], job["_sub"] = "Inventing back & side views (ImageDream)", "3d"
        elif "4D" in m.group(2):
            job["stageLabel"], job["_sub"] = "Reconstructing every frame (L4GM)", "4d"
        job["progress"] = max(job["progress"], lo)
        return
    # Fine-grained progress: matte frames in stage 2; in stage 4 diffusion steps, then
    # "start / total" frame windows.
    if job["stage"] == 2:
        m = re.match(r"matte (\d+)/(\d+)", line)
        if m:
            job["progress"] = max(job["progress"], 0.03 + 0.17 * int(m.group(1)) / int(m.group(2)))
        return
    if job["stage"] == 4:
        if job.get("_sub") == "3d":
            m = re.search(r"(\d+)/(\d+) \[", line)
            if m and int(m.group(2)) > 0:
                job["progress"] = max(job["progress"], 0.25 + 0.25 * int(m.group(1)) / int(m.group(2)))
        else:
            m = re.match(r"(\d+) / (\d+)$", line.strip())
            if m and int(m.group(2)) > 0:
                job["progress"] = max(job["progress"], 0.55 + 0.4 * min(1, int(m.group(1)) / int(m.group(2))))


def run_job(job):
    out = os.path.join(SCENES, f"{job['name']}.4dgsv")
    cmd = [sys.executable, "video_to_4d.py", job["_video"], "--name", job["name"], "--out", out,
           "--start", str(job["start"]), "--seconds", str(job["seconds"])]
    if job["interp"]:
        cmd.append("--interp")
    if job["noMatte"]:
        cmd.append("--no-matte")
    job["status"], job["startedAt"] = "running", time.time()
    proc = subprocess.Popen(cmd, cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env={**os.environ, "PYTHONUNBUFFERED": "1", "L4GM_SKIP_PREVIEW": "1"},
                            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    job["_proc"] = proc
    buf = b""
    while True:
        chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
        if not chunk:
            break
        buf += chunk
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()
        for p in parts:
            if p.strip():
                handle_line(job, p.decode("utf-8", "replace"))
    code = proc.wait()
    job["finishedAt"] = time.time()
    if job["status"] == "cancelled":
        return
    if code == 0 and os.path.exists(out):
        job.update(status="done", progress=1.0, stageLabel="Done",
                   scene=f"{job['name']}.4dgsv", sizeMB=round(os.path.getsize(out) / 1e6, 1))
    else:
        tail = [l for l in job["_log"] if "Error" in l or "error" in l]
        job.update(status="error", error=(tail[-1] if tail else f"exit code {code}"))


def worker():
    while True:
        WAKE.wait()
        with LOCK:
            job_id = QUEUE.popleft() if QUEUE else None
            if not QUEUE:
                WAKE.clear()
        if job_id is None:
            continue
        job = JOBS[job_id]
        if job["status"] != "queued":
            continue
        try:
            run_job(job)
        except Exception as e:  # keep the worker alive
            job.update(status="error", error=str(e))
        finally:
            try:
                os.remove(job["_video"])
            except OSError:
                pass


threading.Thread(target=worker, daemon=True).start()


# ------------------------------------------------------------------ API
@app.get("/health")
def health():
    import torch
    return {"ok": True, "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "busy": any(j["status"] == "running" for j in JOBS.values()), "queued": len(QUEUE)}


@app.post("/jobs")
async def create_job(video: UploadFile = File(...), name: str = Form(""), start: float = Form(0.0),
                     seconds: float = Form(3.0), interp: bool = Form(False), noMatte: bool = Form(False)):
    if not (0 < seconds <= 20):
        raise HTTPException(400, "Clip length must be between 0 and 20 seconds")
    job_id = uuid.uuid4().hex[:10]
    ext = os.path.splitext(video.filename or "")[1].lower()
    if ext not in VIDEO_EXTS:
        ext = ".mp4"  # ffmpeg/imageio sniff the container, the extension is only a hint
    path = os.path.join(UPLOADS, f"{job_id}{ext}")
    with open(path, "wb") as f:
        shutil.copyfileobj(video.file, f, length=4 << 20)
    with LOCK:
        job = {"id": job_id, "name": unique_name(name or os.path.splitext(video.filename or "clip")[0]),
               "source": video.filename, "start": start, "seconds": seconds, "interp": interp,
               "noMatte": noMatte, "status": "queued", "stage": 0, "stageLabel": "Waiting for the GPU",
               "progress": 0.0, "createdAt": time.time(), "_video": path, "_log": deque(maxlen=300)}
        JOBS[job_id] = job
        QUEUE.append(job_id)
        WAKE.set()
    return public(job)


@app.get("/jobs")
def list_jobs():
    return sorted((public(j) for j in JOBS.values()), key=lambda j: -j["createdAt"])


@app.get("/jobs/{job_id}")
def get_job(job_id: str, log: int = 0):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "No such job")
    res = public(job)
    if log:
        res["log"] = list(job["_log"])[-log:]
    return res


@app.get("/jobs/{job_id}/input.mp4")
def job_input(job_id: str):
    job = JOBS.get(job_id)
    path = job and os.path.join(HERE, "results", job["name"], "input", f"{job['name']}.mp4")
    if not path or not os.path.exists(path):
        raise HTTPException(404, "Not ready")
    return FileResponse(path, media_type="video/mp4")


@app.delete("/jobs/{job_id}")
def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "No such job")
    if job["status"] in ("queued", "running"):
        prev = job["status"]
        job["status"], job["stageLabel"] = "cancelled", "Cancelled"
        proc = job.get("_proc")
        if prev == "running" and proc and proc.poll() is None:
            # Kill the whole tree: video_to_4d.py starts infer_3d/infer_4d as children.
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    return public(job)


@app.get("/scenes")
def list_scenes():
    items = []
    for fn in os.listdir(SCENES):
        if fn.endswith(".4dgsv"):
            p = os.path.join(SCENES, fn)
            items.append({"scene": fn, "sizeMB": round(os.path.getsize(p) / 1e6, 1), "modified": os.path.getmtime(p)})
    return sorted(items, key=lambda s: -s["modified"])


@app.get("/scenes/{fn}")
def get_scene(fn: str):
    p = os.path.join(SCENES, os.path.basename(fn))
    if not fn.endswith(".4dgsv") or not os.path.exists(p):
        raise HTTPException(404, "No such scene")
    return FileResponse(p, media_type="application/octet-stream")
