import { ArcRotateCamera, Ray, Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import type { Player } from "./player";

// ----------------------------------------------------------------------------
// Autonomous camera. No mouse needed — the camera infers intent from the
// player's velocity (Look-Where-You're-Going), widens FOV under speed, and
// pulls itself in when a building would otherwise block the view.
// ----------------------------------------------------------------------------

const FOLLOW_OFFSET = new Vector3(0, 1.2, 0); // look slightly above the capsule

const RADIUS_DEFAULT = 11;
const RADIUS_SWING = 15; // wider framing during a swing
const RADIUS_MIN = 2.5;  // minimum allowed after collision-clamp
const RADIUS_LERP_RATE = 6;
const COLLIDER_MARGIN = 0.6;

const FOV_REST = 1.05; // rad ≈ 60°
const FOV_FAST = 1.36; // rad ≈ 78°
const FOV_LERP_RATE = 4;
const SPEED_FOR_MAX_FOV = 22; // m/s

const BETA_REST = Math.PI / 2.5; // ≈ 72° — looking slightly down
const BETA_FAST = Math.PI / 2.15; // ≈ 84° — more horizontal
const BETA_LERP_RATE = 3;
const SPEED_FOR_PITCH = 14;

// LWYG: how quickly the camera azimuth catches up to the player's heading.
// Higher = snappier. Slower while swinging so the camera doesn't whiplash
// through the pendulum arc.
const ALIGN_RATE_FREE = 3.0; // ~0.33s time-constant
const ALIGN_RATE_SWING = 1.5; // ~0.66s time-constant
const MIN_SPEED_TO_ALIGN = 2.5; // m/s — below this, hold the last heading

export function createCamera(
  scene: Scene,
  player: Player,
  _canvas: HTMLCanvasElement,
): ArcRotateCamera {
  const camera = new ArcRotateCamera(
    "camera",
    -Math.PI / 2,
    BETA_REST,
    RADIUS_DEFAULT,
    player.mesh.position.clone(),
    scene,
  );
  // NOTE: deliberately NOT calling attachControl — this camera ignores the
  // mouse and wheel. Players keep both hands on the keyboard.
  camera.lowerBetaLimit = 0.15;
  camera.upperBetaLimit = Math.PI / 2 - 0.05;
  camera.fov = FOV_REST;

  // Shortest-path delta for angle interpolation (handles ±π wraparound).
  const wrapDelta = (from: number, to: number): number => {
    let d = (to - from) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };

  // Frame-rate-independent exponential lerp. `rate` is in 1/seconds; result
  // converges to ~95% in 3 / rate seconds.
  const expLerp = (cur: number, target: number, rate: number, dt: number) =>
    cur + (target - cur) * (1 - Math.exp(-rate * dt));

  let prevTime = performance.now();

  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    const dt = Math.min(Math.max((now - prevTime) / 1000, 0), 1 / 30);
    prevTime = now;

    // Smoothly follow the player (slight upward offset so we look at the head,
    // not the feet — keeps more of the world in frame).
    camera.target.copyFrom(player.mesh.position).addInPlace(FOLLOW_OFFSET);

    const v = player.aggregate.body.getLinearVelocity();
    const horizSpeed = Math.hypot(v.x, v.z);

    // ---- 1. Look-Where-You're-Going ---------------------------------------
    if (horizSpeed > MIN_SPEED_TO_ALIGN) {
      // Camera should sit BEHIND the player along the velocity vector. With
      // ArcRotateCamera's parametrization, the camera offset from target is
      //   (cos α · sin β, cos β, sin α · sin β)
      // For "behind", that horizontal direction must equal -velocity / speed,
      // hence α = atan2(-vz, -vx).
      const desiredAlpha = Math.atan2(-v.z, -v.x);
      const delta = wrapDelta(camera.alpha, desiredAlpha);
      const rate = player.state.swinging ? ALIGN_RATE_SWING : ALIGN_RATE_FREE;
      camera.alpha += delta * (1 - Math.exp(-rate * dt));
    }

    // ---- 2. Speed-driven FOV and pitch ------------------------------------
    const fovT = Math.min(horizSpeed / SPEED_FOR_MAX_FOV, 1);
    const pitchT = Math.min(horizSpeed / SPEED_FOR_PITCH, 1);
    const desiredFov = FOV_REST + (FOV_FAST - FOV_REST) * fovT;
    const desiredBeta = BETA_REST + (BETA_FAST - BETA_REST) * pitchT;
    camera.fov = expLerp(camera.fov, desiredFov, FOV_LERP_RATE, dt);
    camera.beta = expLerp(camera.beta, desiredBeta, BETA_LERP_RATE, dt);

    // ---- 3. Radius: target value, then collision-clamp --------------------
    const desiredRadius = player.state.swinging ? RADIUS_SWING : RADIUS_DEFAULT;
    let clampedRadius = desiredRadius;

    // Cast from target outward toward where the camera *wants* to sit. If a
    // building (or the ground) blocks the line of sight, pull the camera in
    // until it has clear LOS to the player.
    const dir = new Vector3(
      Math.cos(camera.alpha) * Math.sin(camera.beta),
      Math.cos(camera.beta),
      Math.sin(camera.alpha) * Math.sin(camera.beta),
    );
    const ray = new Ray(camera.target, dir, desiredRadius);
    const hit = scene.pickWithRay(
      ray,
      (m) =>
        m.metadata?.kind === "building" || m.metadata?.kind === "ground",
    );
    if (hit?.hit && hit.distance < desiredRadius) {
      clampedRadius = Math.max(RADIUS_MIN, hit.distance - COLLIDER_MARGIN);
    }
    camera.radius = expLerp(camera.radius, clampedRadius, RADIUS_LERP_RATE, dt);
  });

  return camera;
}
