import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PackedSplats, SparkRenderer, SparkXr, SplatMesh, utils } from "@sparkjsdev/spark";
import { decodeFrames, parseHeader } from "./fourdgsv.js";
import { TextPanel, drawRows } from "./xrpanel.js";

const DEFAULT_URL = "scenes/jumpingjacks.4dgsv";
const TARGET_SIZE = 1.8; // metres: largest extent of the scene once placed
const PLACE_DISTANCE = 1.5; // metres in front of the starting position
const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2, 3];
const SIZES = [0.25, 0.5, 1, 2];
const SIZE_LABELS = { 0.25: "¼ size", 0.5: "½ size", 1: "Life size", 2: "2× size" };

const $ = (id) => document.getElementById(id);
const ui = {
  status: $("status"), play: $("play"), timeline: $("timeline"), frame: $("frame"),
  speed: $("speed"), size: $("size"), file: $("file"), panel: $("panel"), help: $("help"),
  enterVr: $("enter-vr"), enterAr: $("enter-ar"),
};
for (const s of SPEEDS) ui.speed.add(new Option(`${s}×`, String(s), s === 1, s === 1));
for (const s of SIZES) ui.size.add(new Option(SIZE_LABELS[s], String(s), s === 1, s === 1));

// --- three / Spark setup ---------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const BACKGROUND = new THREE.Color(0x101014);
const scene = new THREE.Scene();
scene.background = BACKGROUND;
const spark = new SparkRenderer({ renderer });
scene.add(spark);

const rig = new THREE.Group(); // SparkXr thumbstick locomotion moves the camera's parent
scene.add(rig);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 1.6, 0);
rig.add(camera);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.0, -PLACE_DISTANCE);
orbit.update();

// Floor grid so the scene has a sense of scale in the headset (hidden in AR).
const grid = new THREE.GridHelper(10, 20, 0x444455, 0x26262e);
scene.add(grid);

// WebXR: sessions are started by our own Enter VR / Enter AR buttons; SparkXr is used only
// for thumbstick locomotion (left stick move, right stick turn, triggers/grips up-down/speed).
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.xr.setFoveation(0.5);
renderer.xr.setFramebufferScaleFactor(1.0);
// (It re-applies these renderer.xr settings when it initializes, so pass the same values.)
const xr = new SparkXr({
  renderer, element: document.createElement("div"), mode: "vrar", controllers: {},
  referenceSpaceType: "local-floor", frameBufferScaleFactor: 1.0, fixedFoveation: 0.5,
});
const SESSION_INIT = { requiredFeatures: ["local-floor"], optionalFeatures: ["bounded-floor", "hand-tracking", "layers"] };
let xrMode = null; // "immersive-vr" | "immersive-ar" while presenting

async function setupXrButtons() {
  if (!navigator.xr) return;
  const [vr, ar] = await Promise.all(
    ["immersive-vr", "immersive-ar"].map((m) => navigator.xr.isSessionSupported(m).catch(() => false)));
  ui.enterVr.hidden = !vr;
  ui.enterAr.hidden = !ar;
}

async function enterXr(mode) {
  if (renderer.xr.isPresenting) { renderer.xr.getSession().end(); return; }
  try {
    const session = await navigator.xr.requestSession(mode, SESSION_INIT);
    xrMode = mode;
    session.addEventListener("end", onXrEnd);
    await renderer.xr.setSession(session);
    onXrStart();
  } catch (err) {
    console.error(err);
    setStatus(`Could not start ${mode === "immersive-ar" ? "AR" : "VR"}: ${err.message}`);
  }
}

function onXrStart() {
  const ar = xrMode === "immersive-ar";
  scene.background = ar ? null : BACKGROUND; // AR: transparent clear shows passthrough
  grid.visible = !ar;
  orbit.enabled = false;
  camera.position.set(0, 0, 0);
  camera.quaternion.identity();
  ui.enterVr.textContent = "Exit VR"; ui.enterAr.textContent = "Exit AR";
  if (!helpShownOnce) { helpShownOnce = true; setHelpVisible(true); } else toast("Y: help");
}

function onXrEnd() {
  xrMode = null;
  scene.background = BACKGROUND;
  grid.visible = true;
  orbit.enabled = true;
  rig.position.set(0, 0, 0);
  rig.quaternion.identity();
  camera.position.set(0, 1.6, 0);
  orbit.update();
  setHelpVisible(false);
  ui.enterVr.textContent = "Enter VR"; ui.enterAr.textContent = "Enter AR";
}

ui.enterVr.onclick = () => enterXr("immersive-vr");
ui.enterAr.onclick = () => enterXr("immersive-ar");

// --- sequence state -----------------------------------------------------------
const holder = new THREE.Group(); // up-axis fix + life-size scale + placement
scene.add(holder);
let seq = null; // { header, frames, packed, mesh }
let playing = true;
let time = 0; // seconds into the sequence
let shownFrame = -1;
let speed = 1;
let userScale = 1;

function setStatus(text) {
  ui.status.textContent = text;
  ui.status.hidden = !text;
}

async function loadBuffer(buffer, name) {
  setStatus(`Decoding ${name}…`);
  const { header } = parseHeader(buffer);
  const maxSplats = utils.computeMaxSplats(header.numSplats);
  const { frames } = await decodeFrames(buffer, maxSplats, (d, t) => setStatus(`Decoding ${name}: frame ${d}/${t}`));

  if (seq) { holder.remove(seq.mesh); seq.mesh.dispose(); seq.packed.dispose?.(); }
  const packed = new PackedSplats({ packedArray: frames[0].slice(), numSplats: header.numSplats, maxSplats });
  const mesh = new SplatMesh({ packedSplats: packed });
  await mesh.initialized;
  holder.add(mesh);
  seq = { header, frames, packed, mesh, name };
  placeScene(header);

  ui.timeline.max = String(header.numFrames - 1);
  time = 0; shownFrame = -1; playing = true;
  setStatus("");
  ui.panel.dataset.loaded = "1";
  updatePlayButton();
  console.log(`[4dgsv] ${name}: ${header.numSplats} splats x ${header.numFrames} frames @ ${header.fps} fps`);
}

function placeScene(header) {
  const UP_ROTATION_X = { z: -Math.PI / 2, "-y": Math.PI, y: 0 };
  holder.rotation.set(UP_ROTATION_X[header.upAxis] ?? 0, 0, 0);
  holder.position.set(0, 0, 0);
  holder.scale.setScalar(1);
  holder.updateMatrixWorld(true);
  // Bounding box over all frames, in the rotated frame.
  const box = new THREE.Box3(new THREE.Vector3(...header.bboxMin), new THREE.Vector3(...header.bboxMax));
  box.applyMatrix4(holder.matrixWorld);
  const size = box.getSize(new THREE.Vector3());
  const s = (TARGET_SIZE / Math.max(size.x, size.y, size.z)) * userScale;
  const c = box.getCenter(new THREE.Vector3());
  holder.scale.setScalar(s);
  // Stand the scene on the floor, centred PLACE_DISTANCE in front of the start point.
  holder.position.set(-c.x * s, -box.min.y * s, -c.z * s - PLACE_DISTANCE);
}

function showFrame(i) {
  if (!seq || i === shownFrame) return;
  shownFrame = i;
  // Copy into the array the texture was created from: swapping in a different buffer makes
  // Spark re-wrap it as a Uint8Array, which WebGL rejects for an RGBA32UI texture.
  seq.packed.packedArray.set(seq.frames[i]);
  seq.packed.needsUpdate = true;
  seq.mesh.updateVersion();
  ui.timeline.value = String(i);
  ui.frame.textContent = `${i + 1}/${seq.header.numFrames}`;
}

async function loadUrl(url) {
  try {
    setStatus(`Downloading ${url}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      setStatus(`Downloading ${url}: ${(got / 1e6).toFixed(1)}${total ? ` / ${(total / 1e6).toFixed(1)}` : ""} MB`);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    await loadBuffer(buf.buffer, url.split("/").pop());
  } catch (err) {
    console.error(err);
    setStatus(`Could not load ${url}: ${err.message}. Export one with export_vr.py or open a .4dgsv file.`);
  }
}

// --- actions shared by the page UI, keyboard and XR controllers -----------------
function updatePlayButton() { ui.play.textContent = playing ? "Pause" : "Play"; }

function togglePlay() {
  playing = !playing;
  updatePlayButton();
  toast(playing ? "Play" : "Paused");
}

function restart() {
  time = 0; playing = true;
  updatePlayButton();
  toast("Restart");
}

function setSpeed(s) {
  speed = s;
  ui.speed.value = String(s);
  toast(`Speed ${s}×`);
}

function stepSpeed(dir) {
  const i = SPEEDS.indexOf(speed);
  setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir))]);
}

function setSize(s) {
  userScale = s;
  ui.size.value = String(s);
  if (seq) placeScene(seq.header);
  toast(SIZE_LABELS[s] ?? `${s}×`);
}

function cycleSize() {
  setSize(SIZES[(SIZES.indexOf(userScale) + 1) % SIZES.length] ?? 1);
}

function stepFrame(dir) {
  if (!seq) return;
  playing = false;
  updatePlayButton();
  const n = seq.header.numFrames;
  const f = (((shownFrame < 0 ? 0 : shownFrame) + dir) % n + n) % n;
  time = (f + 0.5) / seq.header.fps;
}

// --- page UI ----------------------------------------------------------------------
ui.play.onclick = togglePlay;
ui.timeline.oninput = () => {
  if (!seq) return;
  playing = false; updatePlayButton();
  time = (Number(ui.timeline.value) + 0.5) / seq.header.fps;
};
ui.speed.oninput = () => setSpeed(Number(ui.speed.value));
ui.size.oninput = () => setSize(Number(ui.size.value));
ui.file.onchange = async () => {
  const f = ui.file.files[0];
  if (f) await loadBuffer(await f.arrayBuffer(), f.name);
};
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) await loadBuffer(await f.arrayBuffer(), f.name);
});
const KEYS = {
  Space: togglePlay, KeyR: restart,
  BracketLeft: () => stepSpeed(-1), BracketRight: () => stepSpeed(1),
  ArrowLeft: () => stepFrame(-1), ArrowRight: () => stepFrame(1),
  KeyS: cycleSize, KeyH: () => { ui.help.hidden = !ui.help.hidden; },
};
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const fn = KEYS[e.code];
  if (fn) { fn(); e.preventDefault(); }
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- in-headset help panel + toast ---------------------------------------------------
const helpPanel = new TextPanel(0.56, 0.5);
rig.add(helpPanel);
const toastPanel = new TextPanel(0.24, 0.06);
toastPanel.position.set(0, -0.16, -0.8);
camera.add(toastPanel);
let helpShownOnce = false;
let toastUntil = 0;
let helpDrawnAt = 0;

const HELP_LEFT = [
  ["Stick", "move"],
  ["Trigger / grip", "up / down"],
  ["X", "cycle size"],
  ["Y", "show / hide this help"],
];
const HELP_RIGHT = [
  ["A", "play / pause"],
  ["B", "restart"],
  ["Stick ↑ / ↓", "faster / slower"],
  ["Stick ← / →", "turn"],
  ["Trigger / grip", "move fast / slow"],
];

function drawHelp() {
  const ctx = helpPanel.begin();
  const W = helpPanel.canvas.width;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 52px system-ui, sans-serif";
  ctx.fillText(`4DGS player · ${xrMode === "immersive-ar" ? "AR" : "VR"}`, 56, 44);
  ctx.font = "34px system-ui, sans-serif";
  ctx.fillStyle = "#9aa0b4";
  ctx.fillText("LEFT CONTROLLER", 56, 140);
  let y = drawRows(ctx, HELP_LEFT, 56, 190, 290, 50);
  ctx.fillStyle = "#9aa0b4";
  ctx.fillText("RIGHT CONTROLLER", 56, y + 24);
  y = drawRows(ctx, HELP_RIGHT, 56, y + 74, 290, 50);
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.fillRect(56, y + 18, W - 112, 3);
  ctx.fillStyle = "#c8f0c8";
  const n = seq?.header.numFrames ?? 0;
  const frame = seq ? `frame ${shownFrame + 1}/${n}` : "loading…";
  ctx.fillText(`${playing ? "▶ playing" : "❚❚ paused"} · ${speed}× · ${SIZE_LABELS[userScale] ?? userScale} · ${frame}`, 56, y + 42);
  helpPanel.end();
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();

function setHelpVisible(show) {
  helpPanel.visible = show;
  if (!show) return;
  // Place it front-left of the head, at eye height, facing the viewer; it then stays put
  // in the room (and moves with thumbstick locomotion, since it lives in the rig).
  const head = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  head.matrixWorld.decompose(tmpPos, tmpQuat, new THREE.Vector3());
  const yaw = tmpEuler.setFromQuaternion(tmpQuat, "YXZ").y + 0.45;
  const world = new THREE.Vector3(-Math.sin(yaw) * 0.75, -0.12, -Math.cos(yaw) * 0.75).add(tmpPos);
  helpPanel.position.copy(rig.worldToLocal(world));
  helpPanel.quaternion.copy(rig.getWorldQuaternion(new THREE.Quaternion()).invert())
    .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)));
  drawHelp();
}

function toast(text, force = false) {
  if (!renderer.xr.isPresenting && !force) return;
  const ctx = toastPanel.begin();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 64px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, toastPanel.canvas.width / 2, toastPanel.canvas.height / 2 + 4);
  toastPanel.end();
  toastPanel.visible = true;
  toastUntil = performance.now() + 1400;
}

// --- XR controller buttons ------------------------------------------------------------
// Free inputs (SparkXr already uses both sticks' X/locomotion axes, triggers and grips):
// A/B/X/Y (buttons 4/5) and the right stick's vertical axis.
const prevPressed = new Map();
let stickArmed = true;
function pollXrInput() {
  for (const src of renderer.xr.getSession()?.inputSources ?? []) {
    const gp = src.gamepad;
    if (!gp || src.hand) continue;
    for (const b of [4, 5]) {
      const key = `${src.handedness}${b}`;
      const pressed = !!gp.buttons[b]?.pressed;
      if (pressed && !prevPressed.get(key)) onXrButton(src.handedness, b);
      prevPressed.set(key, pressed);
    }
    if (src.handedness === "right") {
      const y = gp.axes[3] ?? 0;
      if (stickArmed && Math.abs(y) > 0.75) { stepSpeed(y < 0 ? 1 : -1); stickArmed = false; }
      else if (Math.abs(y) < 0.3) stickArmed = true;
    }
  }
}

function onXrButton(hand, b) {
  if (hand === "right") (b === 4 ? togglePlay : restart)();
  else if (b === 4) cycleSize();
  else setHelpVisible(!helpPanel.visible);
}

// --- loop ---------------------------------------------------------------------
const timer = new THREE.Timer();
timer.connect(document);
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1);
  const now = performance.now();
  if (renderer.xr.isPresenting) {
    xr.updateControllers(camera);
    pollXrInput();
  }
  if (seq) {
    if (playing) time += dt * speed;
    const n = seq.header.numFrames;
    const f = Math.floor(time * seq.header.fps) % n;
    showFrame(f < 0 ? f + n : f);
  }
  if (helpPanel.visible && now - helpDrawnAt > 250) { drawHelp(); helpDrawnAt = now; }
  if (toastPanel.visible && now > toastUntil) toastPanel.visible = false;
  renderer.render(scene, camera);
});

setupXrButtons();
// Dev-only hooks so the in-headset panels can be checked on a desktop without a headset.
if (import.meta.env.DEV) window.__viewer = { setHelpVisible, toast, onXrButton, stepSpeed, camera, orbit, helpPanel, rig };
const params = new URLSearchParams(location.search);
loadUrl(params.get("url") ?? DEFAULT_URL);
