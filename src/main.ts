import HavokPhysics from "@babylonjs/havok";
import {
  Color4,
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

const canvas = document.getElementById("game") as HTMLCanvasElement;

const engine = new Engine(canvas, true, {
  preserveDrawingBuffer: false,
  stencil: true,
  disableWebGL2Support: false,
});

const scene = new Scene(engine);
scene.clearColor = new Color4(0.55, 0.7, 0.95, 1);

new HemisphericLight("hemi", new Vector3(0, 1, 0.2), scene);

// Init Havok. The locateFile workaround is required under Vite — the WASM
// is copied into /public so it's served at /HavokPhysics.wasm.
const havok = await HavokPhysics({
  locateFile: (file: string) =>
    file.endsWith(".wasm") ? "/HavokPhysics.wasm" : file,
});
scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havok));

createCity(scene);
const player = createPlayer(scene);
const camera = createCamera(scene, player.mesh, canvas);
createWebSwing(scene, player, camera);

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

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
