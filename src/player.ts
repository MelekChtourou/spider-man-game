import {
  Color3,
  MeshBuilder,
  PBRMaterial,
  PhysicsAggregate,
  PhysicsShapeType,
  Quaternion,
  Ray,
  Vector3,
} from "@babylonjs/core";
import type { Mesh, Scene } from "@babylonjs/core";
import { playLanding, setWindIntensity } from "./audio";

export interface Player {
  mesh: Mesh;
  aggregate: PhysicsAggregate;
  /** State that other systems (like web.ts) mutate to coordinate behavior. */
  state: { swinging: boolean };
}

const MASS = 70;
const MOVE_SPEED = 8;
const JUMP_VEL = 9;       // m/s upward at jump
const GROUND_PROBE = 1.3; // how far below the capsule we look for ground

const AIR_IMPULSE = 3;    // N·s per frame for air control while not swinging
const SWING_IMPULSE = 4;  // N·s per frame for lateral input while swinging
const AIR_DRAG = 0.992;   // per-frame multiplier on horizontal velocity in air

export function createPlayer(scene: Scene): Player {
  // Capsule mesh
  const capsule = MeshBuilder.CreateCapsule(
    "player",
    { height: 2, radius: 0.5, tessellation: 12 },
    scene,
  );
  capsule.position = new Vector3(0, 5, 0);
  capsule.rotationQuaternion = Quaternion.Identity();
  capsule.isPickable = false; // never let raycasts hit ourselves

  // PBR so the capsule picks up sun + IBL like everything else. A touch of
  // metallic + low-ish roughness gives the iconic suit-fabric sheen.
  const mat = new PBRMaterial("playerMat", scene);
  mat.albedoColor = new Color3(0.85, 0.13, 0.18); // Spider-Man red
  mat.metallic = 0.05;
  mat.roughness = 0.55;
  capsule.material = mat;

  // Physics body
  const aggregate = new PhysicsAggregate(
    capsule,
    PhysicsShapeType.CAPSULE,
    { mass: MASS, restitution: 0, friction: 0.6 },
    scene,
  );

  // Lock rotation: zero inertia → torque has no rotational effect.
  aggregate.body.setMassProperties({
    mass: MASS,
    inertia: new Vector3(0, 0, 0),
  });

  // ---- Input (bound to physical key position via event.code) ----
  const keys = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (e.code === "Space") e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.code);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const pressed = (...codes: string[]): boolean =>
    codes.some((c) => keys.has(c));

  // ---- Ground check ----
  const downRay = new Ray(Vector3.Zero(), new Vector3(0, -1, 0), GROUND_PROBE);
  function isGrounded(): boolean {
    downRay.origin.copyFrom(capsule.position);
    downRay.origin.y -= 0.9; // start near the bottom of the capsule
    const hit = scene.pickWithRay(
      downRay,
      (m) => m.metadata?.kind === "building" || m.metadata?.kind === "ground",
    );
    return !!hit?.hit;
  }

  const state = { swinging: false };

  // Track airborne edges so we only play the landing thud once on touchdown.
  let wasGroundedLastFrame = false;

  // ---- Per-frame update ----
  scene.onBeforeRenderObservable.add(() => {
    // Prevent any sneaky angular drift.
    aggregate.body.setAngularVelocity(Vector3.Zero());

    const camera = scene.activeCamera;
    if (!camera) return;

    // Camera-relative axes in the XZ plane.
    let forward = camera.getForwardRay().direction.clone();
    forward.y = 0;
    if (forward.lengthSquared() < 1e-6) forward = new Vector3(0, 0, 1);
    forward.normalize();
    const right = Vector3.Cross(Vector3.Up(), forward).normalize();

    // ---- Audio modulation: wind ramps with horizontal speed ---------------
    const lv = aggregate.body.getLinearVelocity();
    const horizSpeed = Math.hypot(lv.x, lv.z);
    setWindIntensity(Math.min(horizSpeed / 25, 1));

    // ---- Mode 1: swinging — only lateral input (D/Q) as light impulse, ----
    // ---- never override velocity (would kill the pendulum motion).      ----
    if (state.swinging) {
      if (pressed("KeyD", "ArrowRight")) {
        aggregate.body.applyImpulse(
          right.scale(SWING_IMPULSE),
          capsule.position,
        );
      }
      if (pressed("KeyA", "ArrowLeft")) {
        aggregate.body.applyImpulse(
          right.scale(-SWING_IMPULSE),
          capsule.position,
        );
      }
      return;
    }

    const grounded = isGrounded();

    // Edge detect airborne → grounded for the landing thud. Skip the very
    // first frame after spawn (capsule starts at y=5 → wasGroundedLastFrame
    // is false and the next frame would mis-fire as a "landing") by gating
    // on a downward-velocity threshold, which a fresh-spawn always has.
    if (grounded && !wasGroundedLastFrame && lv.y < -1) {
      playLanding();
    }
    wasGroundedLastFrame = grounded;

    // ---- Mode 2: walking on the ground — direct velocity control. ----
    if (grounded) {
      const dir = Vector3.Zero();
      if (pressed("KeyW", "ArrowUp")) dir.addInPlace(forward);
      if (pressed("KeyS", "ArrowDown")) dir.subtractInPlace(forward);
      if (pressed("KeyD", "ArrowRight")) dir.addInPlace(right);
      if (pressed("KeyA", "ArrowLeft")) dir.subtractInPlace(right);
      if (dir.lengthSquared() > 0) dir.normalize();

      const cur = aggregate.body.getLinearVelocity();
      aggregate.body.setLinearVelocity(
        new Vector3(dir.x * MOVE_SPEED, cur.y, dir.z * MOVE_SPEED),
      );

      // Jump (one-shot per Space press)
      if (pressed("Space")) {
        const v = aggregate.body.getLinearVelocity();
        aggregate.body.setLinearVelocity(new Vector3(v.x, JUMP_VEL, v.z));
        keys.delete("Space"); // require re-press to jump again
      }
      return;
    }

    // ---- Mode 3: airborne, not swinging — preserve momentum, weak control ----
    // This is what makes releasing a swing feel like a fling: gravity + the
    // velocity you had at release stay intact, and WASD can still nudge you.
    // We add a gentle horizontal drag so freelancing through the air doesn't
    // glide forever — matches air-resistance intuition.
    aggregate.body.setLinearVelocity(
      new Vector3(lv.x * AIR_DRAG, lv.y, lv.z * AIR_DRAG),
    );
    const dir = Vector3.Zero();
    if (pressed("KeyW", "ArrowUp")) dir.addInPlace(forward);
    if (pressed("KeyS", "ArrowDown")) dir.subtractInPlace(forward);
    if (pressed("KeyD", "ArrowRight")) dir.addInPlace(right);
    if (pressed("KeyA", "ArrowLeft")) dir.subtractInPlace(right);
    if (dir.lengthSquared() > 0) {
      dir.normalize();
      aggregate.body.applyImpulse(
        dir.scale(AIR_IMPULSE),
        capsule.position,
      );
    }
  });

  return { mesh: capsule, aggregate, state };
}
