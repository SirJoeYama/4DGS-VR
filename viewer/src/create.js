// Create page: upload a video to the local generator server (L4GM/server.py) and follow the job.
const params = new URLSearchParams(location.search);
const API = (params.get("api") ?? "http://127.0.0.1:8766").replace(/\/$/, "");

const $ = (id) => document.getElementById(id);
const el = {
  backend: $("backend"), backendText: $("backend-text"), offline: $("offline"),
  drop: $("drop"), file: $("file"), editor: $("editor"), preview: $("preview"),
  name: $("name"), start: $("start"), fromPlayhead: $("from-playhead"), seconds: $("seconds"),
  lenLabel: $("len-label"), framesLabel: $("frames-label"), interp: $("interp"), noMatte: $("nomatte"),
  generate: $("generate"), clear: $("clear"), formMsg: $("form-msg"), jobs: $("jobs"), scenes: $("scenes"),
};

let online = false;
let video = null; // File
let previewUrl = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `${res.status} ${res.statusText}`);
  return res.json();
}

// --- generator status -------------------------------------------------------------
async function checkBackend() {
  try {
    const h = await api("/health");
    online = true;
    el.backend.className = "pill on";
    el.backendText.textContent = `Generator online${h.gpu ? ` · ${h.gpu}` : ""}${h.busy ? " · busy" : ""}`;
  } catch {
    online = false;
    el.backend.className = "pill off";
    el.backendText.textContent = "Generator offline";
  }
  el.offline.hidden = online;
  updateGenerate();
}

// --- video selection + trim -----------------------------------------------------
function pickFile(f) {
  if (!f || !f.type.startsWith("video/")) { el.formMsg.textContent = "That file is not a video."; return; }
  video = f;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(f);
  el.preview.src = previewUrl;
  el.name.value = f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48);
  el.start.value = "0";
  el.drop.hidden = true;
  el.editor.hidden = false;
  el.formMsg.textContent = "";
  updateGenerate();
}

function clampTrim() {
  const d = el.preview.duration;
  if (!Number.isFinite(d)) return;
  el.start.max = String(Math.max(0, d - 0.5));
  el.seconds.max = String(Math.max(1, Math.min(10, Math.floor(d * 2) / 2)));
  if (Number(el.start.value) > d - 0.5) el.start.value = String(Math.max(0, d - 0.5).toFixed(1));
  updateLength();
}

function updateLength() {
  const s = Number(el.seconds.value);
  el.lenLabel.textContent = `${s.toFixed(1)} s`;
  const frames = Math.round(s * 15) * (el.interp.checked ? 3 : 1);
  el.framesLabel.textContent = `· ≈ ${frames} frames, ≈ ${Math.round(frames * 0.65)} MB`;
}

function updateGenerate() {
  el.generate.disabled = !(online && video);
  el.generate.title = !online ? "Start the generator first" : !video ? "Choose a video first" : "";
}

el.drop.onclick = () => el.file.click();
el.drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.file.click(); } };
el.file.onchange = () => pickFile(el.file.files[0]);
for (const ev of ["dragenter", "dragover"]) el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) el.drop.addEventListener(ev, () => el.drop.classList.remove("over"));
el.drop.addEventListener("drop", (e) => { e.preventDefault(); pickFile(e.dataTransfer.files[0]); });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); });

el.preview.onloadedmetadata = clampTrim;
el.seconds.oninput = updateLength;
el.interp.onchange = updateLength;
el.fromPlayhead.onclick = () => { el.start.value = el.preview.currentTime.toFixed(1); };
el.start.onchange = () => { el.preview.currentTime = Number(el.start.value) || 0; };
el.clear.onclick = () => {
  video = null;
  el.preview.removeAttribute("src"); el.preview.load();
  el.editor.hidden = true; el.drop.hidden = false; el.file.value = "";
  updateGenerate();
};

el.generate.onclick = async () => {
  if (!video) return;
  const form = new FormData();
  form.append("video", video, video.name);
  form.append("name", el.name.value.trim());
  form.append("start", el.start.value || "0");
  form.append("seconds", el.seconds.value);
  form.append("interp", String(el.interp.checked));
  form.append("noMatte", String(el.noMatte.checked));
  el.generate.disabled = true;
  el.formMsg.textContent = `Uploading ${(video.size / 1e6).toFixed(1)} MB…`;
  try {
    const job = await api("/jobs", { method: "POST", body: form });
    el.formMsg.textContent = `Queued as “${job.name}”. You can add another video while it runs.`;
    poll(true);
  } catch (err) {
    el.formMsg.textContent = `Upload failed: ${err.message}`;
  } finally {
    updateGenerate();
  }
};

// --- jobs + scenes ------------------------------------------------------------------
// Prefer the scene file from this page's own server (works over the LAN on the Quest when the
// Vite dev server is running), else load it from the generator.
const viewerLinks = new Map();
async function viewerLink(scene) {
  if (!viewerLinks.has(scene)) {
    const local = await fetch(`scenes/${scene}`, { method: "HEAD" })
      .then((r) => r.ok && !r.headers.get("content-type")?.includes("text/html")).catch(() => false);
    viewerLinks.set(scene, `./?url=${encodeURIComponent(local ? `scenes/${scene}` : `${API}/scenes/${scene}`)}`);
  }
  return viewerLinks.get(scene);
}

function elapsed(job) {
  const t0 = job.startedAt ?? job.createdAt;
  const t1 = job.finishedAt ?? Date.now() / 1000;
  const s = Math.max(0, Math.round(t1 - t0));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function renderJobs(jobs) {
  if (!jobs.length) { el.jobs.innerHTML = '<p class="empty">No jobs yet.</p>'; return; }
  const rows = await Promise.all(jobs.map(async (j) => {
    const pct = Math.round(j.progress * 100);
    const status = { queued: "Queued", running: `${pct}% · ${j.stageLabel}`, done: "Done", error: "Failed", cancelled: "Cancelled" }[j.status];
    const open = j.status === "done" ? `<a class="btn primary" href="${esc(await viewerLink(j.scene))}">Open in viewer</a>` : "";
    const cancel = j.status === "queued" || j.status === "running" ? `<button data-cancel="${esc(j.id)}">Cancel</button>` : "";
    const seen = j.stage >= 4 || j.status === "done"
      ? `<div class="seen"><video src="${esc(`${API}/jobs/${j.id}/input.mp4`)}" autoplay loop muted playsinline></video>
           <span>What the AI sees: your clip, background removed and centred.</span></div>` : "";
    const detail = j.status === "done" ? ` · ${j.sizeMB} MB` : j.status === "error" ? ` · ${esc(j.error ?? "")}` : "";
    return `<div class="job ${esc(j.status)}" data-id="${esc(j.id)}">
      <div><div class="title">${esc(j.name)}</div>
        <div class="meta"><span class="status-${esc(j.status)}">${esc(status)}</span> · ${esc(j.source ?? "")}
          · ${j.seconds}s from ${j.start}s · ${elapsed(j)}${detail}</div></div>
      <div class="actions">${open}${cancel}</div>
      <div class="bar"><div style="width:${j.status === "done" ? 100 : pct}%"></div></div>
      ${seen}
    </div>`;
  }));
  // Keep playing preview videos alive: only replace a job row when its markup changes.
  const html = rows.join("");
  if (el.jobs.dataset.html !== html) {
    const keep = new Map([...el.jobs.querySelectorAll(".seen video")].map((v) => [v.closest(".job").dataset.id, v]));
    el.jobs.innerHTML = html;
    el.jobs.dataset.html = html;
    for (const v of el.jobs.querySelectorAll(".seen video")) {
      const old = keep.get(v.closest(".job").dataset.id);
      if (old) v.replaceWith(old);
    }
  }
}

el.jobs.addEventListener("click", async (e) => {
  const id = e.target.closest("[data-cancel]")?.dataset.cancel;
  if (id) { await api(`/jobs/${id}`, { method: "DELETE" }).catch(() => {}); poll(true); }
});

async function renderScenes() {
  const scenes = await api("/scenes");
  if (!scenes.length) { el.scenes.innerHTML = '<li class="empty">None yet.</li>'; return; }
  const items = await Promise.all(scenes.map(async (s) =>
    `<li><span>${esc(s.scene.replace(/\.4dgsv$/, ""))} <span class="empty">· ${s.sizeMB} MB</span></span>
      <a href="${esc(await viewerLink(s.scene))}">Open</a></li>`));
  el.scenes.innerHTML = items.join("");
}

let timer = 0;
async function poll(now = false) {
  clearTimeout(timer);
  if (!now) await checkBackend();
  let active = false;
  if (online) {
    try {
      const jobs = await api("/jobs");
      active = jobs.some((j) => j.status === "queued" || j.status === "running");
      await renderJobs(jobs);
      await renderScenes();
    } catch { /* generator went away; next checkBackend shows it */ }
  }
  timer = setTimeout(poll, active ? 1000 : 4000);
}

checkBackend().then(() => poll(true));
