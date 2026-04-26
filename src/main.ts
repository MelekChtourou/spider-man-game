import HavokPhysics from "@babylonjs/havok";
import {
  Color3,
  DirectionalLight,
  Engine,
  HDRCubeTexture,
  HavokPlugin,
  HemisphericLight,
  ImageProcessingConfiguration,
  Scene,
  Vector3,
} from "@babylonjs/core";

import { createCity } from "./city";
import { createPlayer } from "./player";
import { createCamera } from "./camera";
import { createWebSwing } from "./web";
import { setupTouchControls } from "./touch";
import { setupPlatform } from "./platform";
import { loadBuildingSources, loadCharacter } from "./assets";

const canvas = document.getElementById("game") as HTMLCanvasElement;

const engine = new Engine(canvas, true, {
  preserveDrawingBuffer: false,
  stencil: true,
  disableWebGL2Support: false,
});

// Render-resolution scaling. Phones/tablets often expose devicePixelRatio of
// 2-3, which means rendering at native res chews through fragment shaders for
// little visible gain on a small screen. Render at ~67% on mobile and let the
// browser scale up — typically doubles framerate with negligible visual cost.
// Desktop with a hi-DPI display still benefits from a milder scale-down.
const isMobile = window.matchMedia("(pointer: coarse)").matches;
if (isMobile) {
  engine.setHardwareScalingLevel(1.5);
} else if (window.devicePixelRatio > 1.5) {
  engine.setHardwareScalingLevel(1.25);
}

const scene = new Scene(engine);

// HDRI environment: serves as both the visible skybox and the source of
// ambient + reflective lighting. One asset replaces a flat clearColor and
// flat ambient with a real sky and physically-based reflections.
const hdr = new HDRCubeTexture(
  "/assets/sky.hdr",
  scene,
  isMobile ? 256 : 512,
);
scene.environmentTexture = hdr;
scene.createDefaultSkybox(hdr, true, 1000);

// Direct lighting tuned for PBR materials: the HDRI provides ambient + GI
// to all PBR surfaces (buildings, ground, character), so the directional
// sun only needs to add crisp shadows and specular highlights — not bulk
// illumination. The hemispheric light is a tiny safety net for any
// remaining StandardMaterial meshes (web rope, capsule); PBR meshes
// largely ignore it.
const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.3), scene);
sun.intensity = 1.4;
sun.diffuse = new Color3(1.0, 0.96, 0.88); // warm midday white
const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0.2), scene);
hemi.intensity = 0.4;
hemi.diffuse = new Color3(0.7, 0.8, 1.0);
hemi.groundColor = new Color3(0.3, 0.28, 0.25);

// ACES tone mapping at neutral exposure — lets PBR colors land where the
// artist intended. Bump exposure to ~1.5 only if the chosen sky.hdr is
// genuinely dark (low-light dusk/night scenes).
scene.imageProcessingConfiguration.toneMappingEnabled = true;
scene.imageProcessingConfiguration.toneMappingType =
  ImageProcessingConfiguration.TONEMAPPING_ACES;
scene.imageProcessingConfiguration.exposure = 1.0;

// Linear fog hides the cutoff edge of the building grid and gives the
// scene a sense of depth. Color is sampled to roughly match the HDRI's
// horizon so the fade reads as atmospheric haze, not a backdrop.
scene.fogMode = Scene.FOGMODE_LINEAR;
scene.fogStart = 150;
scene.fogEnd = 300;
scene.fogColor = new Color3(0.55, 0.7, 0.95);

// Init Havok and load all glTF/glb assets in parallel — these don't depend
// on each other and the network/wasm work can overlap. The locateFile
// workaround for Havok is required under Vite — the WASM is copied into
// /public so it's served at /HavokPhysics.wasm.
const [havok, buildingSources, character] = await Promise.all([
  HavokPhysics({
    locateFile: (file: string) =>
      file.endsWith(".wasm") ? "/HavokPhysics.wasm" : file,
  }),
  loadBuildingSources(scene),
  loadCharacter(scene),
]);
scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havok));

createCity(scene, buildingSources);
const player = createPlayer(scene, character);
const camera = createCamera(scene, player, canvas);
createWebSwing(scene, player, camera);
// No-op on devices without touch; otherwise builds the joystick + buttons UI.
setupTouchControls(camera);
// PWA service worker, fullscreen on first gesture, orientation lock,
// screen wake lock. Each step degrades gracefully if unsupported.
setupPlatform();

// Debug exposure (harmless in production; remove later if desired)
(globalThis as unknown as { __game: unknown }).__game = {
  engine,
  scene,
  player,
  camera,
};

// Drive the physics step explicitly each frame. We can't rely on the
// side-effect physicsEngineComponent because (a) tree-shaken builds can drop it,
// and (b) under Vite's optimizeDeps.exclude the module identity can differ from
// what `Scene.enablePhysics` looks for. We use our own performance.now() clock
// so the step works the same whether driven by rAF or scene.render() directly.
const physicsEngine = scene.getPhysicsEngine();
let prevTime = performance.now();
scene.onBeforeRenderObservable.add(() => {
  const now = performance.now();
  const dtSec = (now - prevTime) / 1000;
  prevTime = now;
  // Clamp dt so a stalled tab doesn't cause a giant physics jump on resume.
  const stepDt = Math.min(Math.max(dtSec, 0), 1 / 30);
  if (stepDt > 0 && physicsEngine) {
    physicsEngine._step(stepDt);
  }
});

// Top-right FPS readout. Updated 4×/sec to keep the value readable —
// per-frame updates make the digits flicker too fast to parse. Guard
// against Infinity (returned for the first frame or two before Babylon
// has enough timing data).
const fpsEl = document.getElementById("fps");
if (fpsEl) {
  setInterval(() => {
    const fps = engine.getFps();
    fpsEl.textContent = `${Number.isFinite(fps) ? fps.toFixed(0) : "—"} FPS`;
  }, 250);
}

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
