import HavokPhysics from "@babylonjs/havok";
import {
  Color3,
  DefaultRenderingPipeline,
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

// Top-right HUD: FPS + air-time + tier label. Updated 10×/sec —
// per-frame updates make the digits flicker too fast to parse.
const fpsEl = document.getElementById("fps");
const airEl = document.getElementById("airtime");
const hintEl = document.getElementById("oiia-max-hint");
// Hint state machine: only show the OIIA MAX prompt after the player has
// genuinely *experienced* the first remix session (sustained 10s+ in air →
// natural Tier 1 → fell back to Tier 0 by landing). It's the "discovery"
// moment: you heard the song once, now we tell you about MAX.
let everReachedTrip = false;
let prevTier: number = 0;
let hintShown = false;
if (fpsEl || airEl) {
  setInterval(() => {
    if (fpsEl) {
      const fps = engine.getFps();
      fpsEl.textContent = `${Number.isFinite(fps) ? fps.toFixed(0) : "—"} FPS`;
    }
    const tier = player.state.tier;
    const isMax = player.state.maxMode;
    if (airEl) {
      const cur = player.state.airTime;
      const max = player.state.maxAirTime;
      const tierTag = isMax ? " · MAX" : tier > 0 ? ` · T${tier}` : "";
      airEl.textContent =
        cur > 0
          ? `Air ${cur.toFixed(1)}s · max ${max.toFixed(1)}s${tierTag}`
          : `Max air: ${max.toFixed(1)}s${tierTag}`;
      airEl.classList.toggle("trippy", tier > 0);
    }
    // ---- OIIA MAX hint trigger ----
    // Track whether the player has ever entered the natural trip (T1+).
    if (tier > 0) everReachedTrip = true;
    // Edge: we *just* dropped from a trip back to T0 (player landed and the
    // remix loop was cut). If this is the first time, show the hint —
    // they've now had the discovery moment, we offer them the upgrade.
    const justDroppedFromTrip = prevTier > 0 && tier === 0;
    if (
      hintEl &&
      !hintShown &&
      !isMax &&
      everReachedTrip &&
      justDroppedFromTrip
    ) {
      hintShown = true;
      hintEl.classList.add("visible");
      window.setTimeout(() => hintEl.classList.remove("visible"), 8000);
    }
    if (hintEl && isMax) hintEl.classList.remove("visible");
    prevTier = tier;
  }, 100);
}

// N key → trigger OIIA MAX mode. Lock-in until the remix track finishes
// playing (web.ts's onended handler clears state.maxMode). Pressing N again
// while already in MAX is a no-op — there's no way out except waiting it out.
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyN" && !player.state.maxMode) {
    player.state.maxMode = true;
  }
});

// ---- Tier-driven post-processing pipeline ----
// One DefaultRenderingPipeline whose parameters scale with player.state.tier
// (0–3). Every active tier turns ALL effects on at full strength; higher
// tiers add more channels of chaos (contrast pulses, exposure stutter, hue
// rotation, fog churn, animation speed pulses, random spike events) on top
// of the heavy baseline.
const trippy = new DefaultRenderingPipeline("trippy", true, scene, [camera]);
trippy.bloomEnabled = false;
trippy.chromaticAberrationEnabled = false;
trippy.grainEnabled = false;
trippy.imageProcessing.colorCurvesEnabled = false;
trippy.imageProcessing.vignetteEnabled = false;

// Stash baselines so tier-0 transitions can fully restore.
const baseFov = camera.fov;
const baseFogStart = scene.fogStart;
const baseFogEnd = scene.fogEnd;
const baseFogColor = scene.fogColor.clone();
const baseExposure = scene.imageProcessingConfiguration.exposure;
const baseContrast = scene.imageProcessingConfiguration.contrast;

// Cat animation handle for the speedRatio chaos channel (T2+).
let catAnim: import("@babylonjs/core").AnimationGroup | null = null;
let baseCatSpeed = 1;

let appliedTier = 0;
const tierStart = { t: 0 };

scene.onBeforeRenderObservable.add(() => {
  const tier = player.state.tier;

  // Lazy-grab the cat animation once it's loaded.
  if (!catAnim && scene.animationGroups.length > 0) {
    catAnim = scene.animationGroups[0];
    baseCatSpeed = catAnim.speedRatio || 1;
  }

  // Tier transition — restart the animation clock and flip structural
  // enable flags. Setting these per-frame would force pipeline rebuilds.
  if (tier !== appliedTier) {
    appliedTier = tier;
    tierStart.t = performance.now();
    if (tier === 0) {
      trippy.bloomEnabled = false;
      trippy.chromaticAberrationEnabled = false;
      trippy.grainEnabled = false;
      trippy.imageProcessing.vignetteEnabled = false;
      trippy.imageProcessing.colorCurvesEnabled = false;
      camera.fov = baseFov;
      scene.fogStart = baseFogStart;
      scene.fogEnd = baseFogEnd;
      scene.fogColor.copyFrom(baseFogColor);
      scene.imageProcessingConfiguration.exposure = baseExposure;
      scene.imageProcessingConfiguration.contrast = baseContrast;
      if (catAnim) catAnim.speedRatio = baseCatSpeed;
    } else {
      // Every active tier gets the full FX stack enabled; per-frame block
      // below ramps amplitudes per tier, including extra chaos for T2 / T3.
      trippy.chromaticAberrationEnabled = true;
      trippy.grainEnabled = true;
      trippy.imageProcessing.vignetteEnabled = true;
      trippy.bloomEnabled = true;
      trippy.imageProcessing.colorCurvesEnabled = true;
      trippy.bloomThreshold = tier >= 3 ? 0.3 : 0.4;
      trippy.bloomKernel = tier >= 3 ? 128 : 96;
      trippy.bloomScale = tier >= 3 ? 0.85 : 0.7;
    }
  }

  if (tier > 0) {
    const t = (performance.now() - tierStart.t) / 1000;
    // Chaos multiplier ramps per tier (1.0 / 1.4 / 1.9). Spikes amplitudes
    // & frequencies of the shared base effects.
    const chaos = tier === 1 ? 1.0 : tier === 2 ? 1.4 : 1.9;
    // Random instability factor — only T3 gets per-frame randomness on
    // base amplitudes; T1/T2 stay deterministic-smooth.
    const jitter = tier === 3 ? 0.7 + Math.random() * 0.6 : 1;

    // ---- Base effects (all active tiers, scaled by chaos × jitter) ----
    trippy.chromaticAberration.aberrationAmount =
      (25 + Math.sin(t * 14 * chaos) * 30) * jitter;
    trippy.chromaticAberration.radialIntensity =
      1.0 + Math.cos(t * 8 * chaos) * 0.6 * jitter;
    trippy.grain.intensity = (14 + Math.random() * 10) * (tier === 3 ? 1.6 : 1);

    // Rainbow vignette — full hue cycle every ~1s at T3.
    const hueSpeed = 180 * chaos;
    const hue = (t * hueSpeed) % 360;
    trippy.imageProcessing.vignetteColor.set(
      0.5 + 0.5 * Math.sin(((hue + 0) * Math.PI) / 180),
      0.5 + 0.5 * Math.sin(((hue + 120) * Math.PI) / 180),
      0.5 + 0.5 * Math.sin(((hue + 240) * Math.PI) / 180),
      1,
    );
    trippy.imageProcessing.vignetteWeight =
      (4 + Math.abs(Math.sin(t * 6 * chaos)) * 8) * jitter;
    trippy.bloomWeight = (0.7 + Math.abs(Math.sin(t * 14)) * 0.7) * jitter;

    const fovAmp = 0.18 * chaos;
    camera.fov = baseFov + Math.sin(t * 9 * chaos) * fovAmp;

    // ---- T2+ adds: scene-wide exposure pulse + cat animation speed pulse ----
    if (tier >= 2) {
      scene.imageProcessingConfiguration.exposure =
        baseExposure + Math.sin(t * 11) * 0.4;
      if (catAnim) catAnim.speedRatio = baseCatSpeed * (1 + Math.sin(t * 4) * 1.5);
      scene.imageProcessingConfiguration.contrast =
        baseContrast + Math.abs(Math.sin(t * 7)) * 0.6;
    }

    // ---- T3 adds: random fog churn + camera FOV stutters + radial chaos ----
    if (tier === 3) {
      scene.fogStart = 60 + Math.sin(t * 5) * 50;
      scene.fogEnd = 200 + Math.cos(t * 3) * 100;
      const fogHue = (t * 240) % 360;
      scene.fogColor.set(
        0.5 + 0.5 * Math.sin(((fogHue + 0) * Math.PI) / 180),
        0.5 + 0.5 * Math.sin(((fogHue + 120) * Math.PI) / 180),
        0.5 + 0.5 * Math.sin(((fogHue + 240) * Math.PI) / 180),
      );
      if (Math.random() < 0.05) {
        camera.fov += (Math.random() - 0.5) * 0.5;
      }
      scene.imageProcessingConfiguration.exposure +=
        (Math.random() - 0.5) * 0.6;
      if (catAnim) catAnim.speedRatio = baseCatSpeed * (0.3 + Math.random() * 4);
    }
  }
});

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
