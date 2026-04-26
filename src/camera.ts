import { ArcRotateCamera } from "@babylonjs/core";
import type { Mesh, Scene } from "@babylonjs/core";

export function createCamera(
  scene: Scene,
  target: Mesh,
  canvas: HTMLCanvasElement,
): ArcRotateCamera {
  const camera = new ArcRotateCamera(
    "camera",
    -Math.PI / 2,        // alpha (azimuth)
    Math.PI / 3,         // beta (polar)
    10,                  // radius
    target.position.clone(),
    scene,
  );

  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 4;
  camera.upperRadiusLimit = 28;
  camera.lowerBetaLimit = 0.2;
  camera.upperBetaLimit = Math.PI / 2 - 0.05; // don't dip below the floor
  camera.wheelPrecision = 30;
  camera.angularSensibilityX = 1500;
  camera.angularSensibilityY = 1500;
  camera.panningSensibility = 0; // disable right-click pan
  camera.inertia = 0.6;

  // Follow the player by mutating the orbit target each frame.
  scene.onBeforeRenderObservable.add(() => {
    camera.target.copyFrom(target.position);
  });

  return camera;
}
