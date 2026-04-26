import HavokPhysics from "@babylonjs/havok";
import {
  CascadedShadowGenerator,
  Color3,
  Color4,
  CubeTexture,
  DirectionalLight,
  Engine,
  HavokPlugin,
  HemisphericLight,
  Scene,
  Vector3,
} from "@babylonjs/core";

import { createCity } from "./city";
import { createPlayer } from "./player";
import { createCamera } from "./camera";
import { createWebSwing } from "./web";
import { setupTouchControls } from "./touch";
import { setupPlatform } from "./platform";
import { setupRenderPipelines } from "./render";

const canvas = document.getElementById("game") as HTMLCanvasElement;

const engine = new Engine(canvas, true, {
  preserveDrawingBuffer: false,
  stencil: true,
  disableWebGL2Support: false,
});

// Render-resolution scaling. Phones/tablets often expose devicePixelRatio of
// 2-3; we render at 67% on coarse-pointer devices and let the browser scale up.
// `isMobile` also drives quality decisions later (shadows, SSAO).
const isMobile = window.matchMedia("(pointer: coarse)").matches;
if (isMobile) {
  engine.setHardwareScalingLevel(1.5);
} else if (window.devicePixelRatio > 1.5) {
  engine.setHardwareScalingLevel(1.25);
}

const scene = new Scene(engine);
// Fallback color while the .env streams in. Once env loads, the skybox
// covers this entirely.
scene.clearColor = new Color4(0.55, 0.7, 0.95, 1);
// Cool ambient tint feeds into PBR materials' indirect light.
scene.ambientColor = new Color3(0.3, 0.35, 0.45);

// ---- Lights ----------------------------------------------------------------
// Sun: warm, slight low-angle direction. The dominant key light and the only
// shadow caster — Babylon's CascadedShadowGenerator is built around a single
// DirectionalLight.
const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.3), scene);
sun.intensity = 1.4;
sun.diffuse = new Color3(1.0, 0.95, 0.85);
// Position the light source above-and-out so the shadow frustum has good
// coverage of the play area.
sun.position = new Vector3(60, 120, 40);

// Fill: cool hemispherical light at low intensity. Keeps shadow valleys from
// going pitch-black; the sky-blue tint complements the warm sun.
const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
hemi.intensity = 0.3;
hemi.diffuse = new Color3(0.85, 0.85, 0.95);
hemi.groundColor = new Color3(0.45, 0.5, 0.55);

// ---- IBL environment + skybox ----------------------------------------------
// One-call setup: a single .env (pre-filtered cubemap) gives us both the
// visible sky AND image-based lighting that feeds reflections on every PBR
// material in the scene. Without IBL, PBR surfaces look unnaturally flat.
const envTex = CubeTexture.CreateFromPrefilteredData(
  "/env/environment.env",
  scene,
);
scene.environmentTexture = envTex;
// IBL contribution. Default 1.0 has the env light competing with the sun;
// 0.4 keeps the sun as the dominant key light while still feeding good
// reflections on PBR materials.
scene.environmentIntensity = 0.4;
// pbr=true, size=1000, blur=0.6 → softly-blurred sky avoids competing with
// the city detail.
scene.createDefaultSkybox(envTex, true, 1000, 0.6);

// ---- Physics (Havok) -------------------------------------------------------
const havok = await HavokPhysics({
  locateFile: (file: string) =>
    file.endsWith(".wasm") ? "/HavokPhysics.wasm" : file,
});
scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havok));

// ---- World -----------------------------------------------------------------
const city = createCity(scene);
const player = createPlayer(scene);
const camera = createCamera(scene, player, canvas);
createWebSwing(scene, player, camera);
setupTouchControls(camera);
setupPlatform();

// ---- Cinematic post-processing (camera must exist first) -------------------
setupRenderPipelines(scene, camera, isMobile ? "low" : "high");

// ---- Cascaded shadow maps --------------------------------------------------
// 4 cascades cover the play area at varying resolutions: tightest near the
// camera, loosest far away. PCF gives soft penumbras. Mobile downgrades to
// fewer cascades and a smaller map for perf.
const SHADOW_MAP_SIZE = isMobile ? 512 : 1024;
const shadowGen = new CascadedShadowGenerator(SHADOW_MAP_SIZE, sun);
shadowGen.numCascades = isMobile ? 2 : 4;
shadowGen.lambda = 0.7;                  // logarithmic-vs-uniform split blend
shadowGen.cascadeBlendPercentage = 0.05; // hide cascade seams
shadowGen.usePercentageCloserFiltering = true;
shadowGen.filteringQuality = isMobile ? 0 : 1; // 0=low, 1=medium, 2=high
shadowGen.shadowMaxZ = 200;
shadowGen.depthClamp = true;
shadowGen.autoCalcDepthBounds = true;

// Casters. Instances inherit caster status from their source mesh —
// registering each source covers that source's batch of buildings in one
// call.
shadowGen.addShadowCaster(player.mesh);
for (const src of city.buildingSources) shadowGen.addShadowCaster(src);

// Debug exposure (harmless in production)
(globalThis as unknown as { __game: unknown }).__game = {
  engine,
  scene,
  player,
  camera,
  sun,
  shadowGen,
};

// ---- Physics step driver ---------------------------------------------------
// We can't rely on the side-effect physicsEngineComponent because Vite's
// optimizeDeps.exclude breaks the module-identity match Scene.enablePhysics
// uses. Drive _step(dt) ourselves, with a performance.now() clock so it
// works whether driven by rAF or scene.render() directly.
const physicsEngine = scene.getPhysicsEngine();
let prevTime = performance.now();
scene.onBeforeRenderObservable.add(() => {
  const now = performance.now();
  const dtSec = (now - prevTime) / 1000;
  prevTime = now;
  // Clamp dt so a stalled tab doesn't cause a giant physics jump on resume.
  // Multiply by scene.animationTimeScale so things like the brief slow-mo
  // on rope catch (web.ts) actually slow the physics, not just animations.
  const stepDt =
    Math.min(Math.max(dtSec, 0), 1 / 30) * scene.animationTimeScale;
  if (stepDt > 0 && physicsEngine) {
    physicsEngine._step(stepDt);
  }
});

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
