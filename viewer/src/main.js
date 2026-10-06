import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PackedSplats, SparkRenderer, SparkXr, SplatMesh, utils } from "@sparkjsdev/spark";
import { decodeFrames, parseHeader } from "./fourdgsv.js";

const DEFAULT_URL = "scenes/jumpingjacks.4dgsv";
const TARGET_SIZE = 1.8; // metres: largest extent of the scene once placed
const PLACE_DISTANCE = 1.5; // metres in front of the starting position

const $ = (id) => document.getElementById(id);
const ui = {
  status: $("status"), play: $("play"), timeline: $("timeline"), frame: $("frame"),
  speed: $("speed"), size: $("size"), file: $("file"), panel: $("panel"),
};

// --- three / Spark setup ---------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101014);
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

// Floor grid so the scene has a sense of scale in the headset.
const grid = new THREE.GridHelper(10, 20, 0x444455, 0x26262e);
scene.add(grid);

const xr = new SparkXr({
  renderer,
  mode: "vr",
  referenceSpaceType: "local-floor",
  frameBufferScaleFactor: 1.0,
  fixedFoveation: 0.5,
  controllers: {},
  onReady: (ok) => setStatus(ok ? "" : "WebXR VR not available in this browser (desktop preview only)"),
  onEnterXr: () => { orbit.enabled = false; camera.position.set(0, 0, 0); camera.quaternion.identity(); },
  onExitXr: () => { orbit.enabled = true; camera.position.set(0, 1.6, 0); orbit.update(); },
});

// --- sequence state -----------------------------------------------------------
const holder = new THREE.Group(); // up-axis fix + life-size scale + placement
scene.add(holder);
let seq = null; // { header, frames, packed, mesh }
let playing = true;
let time = 0; // seconds into the sequence
let shownFrame = -1;
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
  seq = { header, frames, packed, mesh };
  placeScene(header);

  ui.timeline.max = String(header.numFrames - 1);
  time = 0; shownFrame = -1; playing = true;
  setStatus("");
  ui.panel.dataset.loaded = "1";
  updatePlayButton();
  console.log(`[4dgsv] ${name}: ${header.numSplats} splats x ${header.numFrames} frames @ ${header.fps} fps`);
}

function placeScene(header) {
  holder.rotation.set(header.upAxis === "z" ? -Math.PI / 2 : 0, 0, 0);
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

// --- UI -------------------------------------------------------------------------
function updatePlayButton() { ui.play.textContent = playing ? "Pause" : "Play"; }
ui.play.onclick = () => { playing = !playing; updatePlayButton(); };
ui.timeline.oninput = () => {
  if (!seq) return;
  playing = false; updatePlayButton();
  time = Number(ui.timeline.value) / seq.header.fps;
  showFrame(Number(ui.timeline.value));
};
ui.size.oninput = () => { userScale = Number(ui.size.value); if (seq) placeScene(seq.header); };
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
addEventListener("keydown", (e) => {
  if (e.code === "Space") { playing = !playing; updatePlayButton(); e.preventDefault(); }
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- XR controller buttons (A/X = play/pause, B = restart, Y = cycle size) ------
const prevPressed = new Map();
function pollXrButtons() {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    for (const b of [4, 5]) {
      const key = `${src.handedness}${b}`;
      const pressed = !!gp.buttons[b]?.pressed;
      if (pressed && !prevPressed.get(key)) onXrButton(src.handedness, b);
      prevPressed.set(key, pressed);
    }
  }
}
const SIZES = [1, 0.5, 0.25, 2];
function onXrButton(hand, b) {
  if (b === 4) { playing = !playing; updatePlayButton(); }
  else if (hand === "right") { time = 0; playing = true; updatePlayButton(); }
  else if (seq) {
    userScale = SIZES[(SIZES.indexOf(userScale) + 1) % SIZES.length] ?? 1;
    ui.size.value = String(userScale);
    placeScene(seq.header);
  }
}

// --- loop ---------------------------------------------------------------------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (renderer.xr.isPresenting) {
    xr.updateControllers(camera);
    pollXrButtons();
  }
  if (seq) {
    if (playing) time += dt * Number(ui.speed.value);
    const n = seq.header.numFrames;
    const f = Math.floor(time * seq.header.fps) % n;
    showFrame(f < 0 ? f + n : f);
  }
  renderer.render(scene, camera);
});

const params = new URLSearchParams(location.search);
loadUrl(params.get("url") ?? DEFAULT_URL);
