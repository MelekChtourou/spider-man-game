import {
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  Quaternion,
  Ray,
  Vector3,
} from "@babylonjs/core";
import type { Mesh, Scene } from "@babylonjs/core";
import type { CharacterAssets } from "./assets";

/** Trip intensity levels — 0 is normal, 3 is peak chaos. */
export type Tier = 0 | 1 | 2 | 3;

export interface Player {
  mesh: Mesh;
  aggregate: PhysicsAggregate;
  /** State that other systems (web.ts, main.ts trippy controller) read & mutate. */
  state: {
    swinging: boolean;
    /** Seconds spent continuously airborne. Resets to 0 on ground contact. */
    airTime: number;
    /** Best run this session — never decreases until reload. */
    maxAirTime: number;
    /** Current trip tier — derived from airTime, or locked to 3 in maxMode. */
    tier: Tier;
    /**
     * OIIA MAX mode — locks tier to 3 and plays the remix once through to
     * its end. Cannot be cancelled by landing; only the remix's `onended`
     * (set up by web.ts) clears this flag.
     */
    maxMode: boolean;
  };
  /**
   * Force-clears a key from the input set. Used by web.ts on swing-release
   * to consume the Space press, so player.ts doesn't *also* fire a regular
   * jump on the same press (which would override the release boost AND eat
   * one of the player's double-jumps).
   */
  consumeKey: (code: string) => void;
  /**
   * Refills the double-jump charge to full. Called by web.ts on every
   * swing-release so the player always has two fresh mid-air jumps to
   * spend, regardless of whether they used any before grabbing the rope.
   */
  refillJumps: () => void;
}

// Tier escalation thresholds (seconds of continuous airtime). The first
// remix experience is gated at 10s — short jumps stay clean, only sustained
// flight triggers the trip. Tier 2/3 follow as the trip deepens.
const TIER_1_THRESHOLD = 10;
const TIER_2_THRESHOLD = 18;
const TIER_3_THRESHOLD = 28;

function autoTierFromAirTime(t: number): Tier {
  if (t < TIER_1_THRESHOLD) return 0;
  if (t < TIER_2_THRESHOLD) return 1;
  if (t < TIER_3_THRESHOLD) return 2;
  return 3;
}

const MASS = 70;
const MOVE_SPEED = 8;
const JUMP_VEL = 9;       // m/s upward at jump
const GROUND_PROBE = 1.3; // how far below the capsule we look for ground

const AIR_IMPULSE = 13;   // N·s per frame — generous mid-air directional control
const AIR_MAX_HORIZ = 14; // m/s soft cap so air control can't run away forever
const SWING_IMPULSE = 1.8; // N·s per frame — light lateral nudge so the swing
                           // arc stays mostly upright instead of getting whipped
                           // hard sideways. Was 4 (too aggressive).
const MAX_JUMPS = 2;      // ground-jump + one mid-air double-jump

export function createPlayer(scene: Scene, character: CharacterAssets): Player {
  // Capsule mesh — kept as the physics body and parent transform, but its
  // visual is hidden in favor of the imported character glTF.
  const capsule = MeshBuilder.CreateCapsule(
    "player",
    { height: 2, radius: 0.5, tessellation: 12 },
    scene,
  );
  capsule.position = new Vector3(0, 5, 0);
  capsule.rotationQuaternion = Quaternion.Identity();
  capsule.isPickable = false; // never let raycasts hit ourselves
  capsule.isVisible = false;  // character mesh provides the visual

  // Auto-fit the character to the capsule's height. We measure bounds
  // BEFORE parenting so the values are in the character's natural local
  // space (parenting to the capsule at y=5 would otherwise inflate the
  // bounds with the capsule's world offset).
  const TARGET_HEIGHT = 2; // capsule full height
  const beforeBounds = character.root.getHierarchyBoundingVectors(true);
  const naturalHeight = beforeBounds.max.y - beforeBounds.min.y;
  const naturalMinY = beforeBounds.min.y;
  const scale = naturalHeight > 0 ? TARGET_HEIGHT / naturalHeight : 1;
  character.root.scaling.scaleInPlace(scale);

  // Now parent to the capsule. Local position offsets the character so its
  // feet (scaled bottom of the natural bounds) align with the capsule's
  // bottom at local y = -TARGET_HEIGHT / 2.
  character.root.parent = capsule;
  const charRestY = -TARGET_HEIGHT / 2 - naturalMinY * scale;
  character.root.position = new Vector3(0, charRestY, 0);

  // The first baked animation in the glTF is the OIIA cat's spin. We
  // *always* leave it running and gate playback via speedRatio = 0 (frozen)
  // vs 1 (live) — switching the ratio is sample-precise and avoids the
  // play()/pause() pipeline restart cost that caused stutter.
  const animGroups = Object.values(character.animations);
  const playingAnim = animGroups.length > 0 ? animGroups[0] : null;
  if (playingAnim) {
    playingAnim.start(true);
    playingAnim.speedRatio = 0;
  }

  // Track a quaternion we drive procedurally when no baked animation exists.
  // When playingAnim is non-null we leave rotationQuaternion untouched so the
  // baked animation owns the rotation channel.
  const charRotationQ = Quaternion.Identity();
  if (!playingAnim) {
    character.root.rotationQuaternion = charRotationQ;
  }

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

  const state: Player["state"] = {
    swinging: false,
    airTime: 0,
    maxAirTime: 0,
    tier: 0,
    maxMode: false,
  };

  // Jump bookkeeping. `jumpsRemaining` decrements with each press; resets to
  // MAX_JUMPS the moment the player touches ground again. `wasGrounded`
  // edge-detects the landing transition so we only refill once per landing.
  let jumpsRemaining = MAX_JUMPS;
  let wasGrounded = true;

  // Tunables for the character "alive" feel — kept outside the per-frame
  // closure so they're easy to find when iterating on look/feel.
  const FACE_TURN_RATE = 8;     // higher = snappier face-toward-velocity
  const BREATH_AMPLITUDE = 0.04; // m of vertical sway when idle
  const BREATH_HZ = 1.1;         // breaths per second
  const FACE_MIN_SPEED_SQ = 0.5; // below this (m²/s²) we skip re-aiming

  // ---- Per-frame update ----
  scene.onBeforeRenderObservable.add(() => {
    // Prevent any sneaky angular drift.
    aggregate.body.setAngularVelocity(Vector3.Zero());

    // Hoisted per-frame state: shared by the dance toggle, jump refill,
    // air-time tracking, mode dispatch, and the character-alive pass.
    // One ground raycast + one velocity read per frame.
    const grounded = isGrounded();
    const v = aggregate.body.getLinearVelocity();
    const horizSq = v.x * v.x + v.z * v.z;

    // ---- OIIA dance toggle ----
    // Cat spins while swinging-with-motion or while airborne; freezes &
    // resets to frame 0 when grounded-and-still. speedRatio toggle avoids
    // the play()/pause() pipeline hitch.
    if (playingAnim) {
      const wantSpin =
        !grounded || (state.swinging && horizSq > FACE_MIN_SPEED_SQ);
      if (wantSpin) {
        if (playingAnim.speedRatio !== 1) playingAnim.speedRatio = 1;
      } else if (playingAnim.speedRatio !== 0) {
        playingAnim.speedRatio = 0;
        playingAnim.goToFrame(playingAnim.from);
      }
    }

    // ---- Character "alive" pass (independent of input mode) ----
    // Procedural face-toward-velocity only when no baked animation owns the
    // rotation channel — otherwise we'd fight (e.g. cancel) the OIIA cat's
    // spin animation each frame.
    if (!playingAnim && horizSq > FACE_MIN_SPEED_SQ) {
      const targetYaw = Math.atan2(v.x, v.z);
      const targetQ = Quaternion.RotationYawPitchRoll(targetYaw, 0, 0);
      const dt = scene.getEngine().getDeltaTime() / 1000;
      const t = 1 - Math.exp(-FACE_TURN_RATE * dt); // frame-rate-independent slerp
      Quaternion.SlerpToRef(charRotationQ, targetQ, t, charRotationQ);
    }
    // Idle breathing: skip when a baked animation is playing (the model is
    // already animating). Otherwise sway gently when grounded and still.
    if (!playingAnim) {
      const isStill = horizSq < 0.5 && !state.swinging;
      if (isStill) {
        const t = performance.now() / 1000;
        character.root.position.y =
          charRestY +
          Math.sin(t * BREATH_HZ * 2 * Math.PI) * BREATH_AMPLITUDE;
      } else {
        character.root.position.y = charRestY;
      }
    }

    const camera = scene.activeCamera;
    if (!camera) return;

    // Camera-relative axes in the XZ plane.
    let forward = camera.getForwardRay().direction.clone();
    forward.y = 0;
    if (forward.lengthSquared() < 1e-6) forward = new Vector3(0, 0, 1);
    forward.normalize();
    const right = Vector3.Cross(Vector3.Up(), forward).normalize();

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

    // Refill jumps the moment we touch ground (rising-edge detection).
    if (grounded && !wasGrounded) jumpsRemaining = MAX_JUMPS;
    wasGrounded = grounded;

    // ---- Air-time tracking + tier resolution ----
    // Counts as "airtime" when: (a) genuinely airborne, OR (b) swinging
    // *with motion* — so a player skimming the ground on a long pendulum
    // arc doesn't get their counter reset by every brief touch.
    const dtSec = scene.getEngine().getDeltaTime() / 1000;
    const swingingWithMotion = state.swinging && horizSq > FACE_MIN_SPEED_SQ;
    if (!grounded || swingingWithMotion) {
      state.airTime += dtSec;
      if (state.airTime > state.maxAirTime) state.maxAirTime = state.airTime;
    } else {
      state.airTime = 0;
    }
    // Resolve final tier: maxMode locks to 3 (regardless of grounded state)
    // until the remix finishes; otherwise derive from accumulated airtime.
    state.tier = state.maxMode ? 3 : autoTierFromAirTime(state.airTime);

    // Universal jump (works grounded and mid-air for the double-jump). One
    // press = one jump consumed; counter refills on landing. Each jump
    // overrides the *current* Y velocity so a falling double-jump feels
    // crisp instead of being a tiny upward bump on top of high downward
    // velocity.
    const wantsJump = pressed("Space") && jumpsRemaining > 0;
    if (wantsJump) {
      const v = aggregate.body.getLinearVelocity();
      aggregate.body.setLinearVelocity(new Vector3(v.x, JUMP_VEL, v.z));
      keys.delete("Space"); // require re-press for the next jump
      jumpsRemaining--;
    }

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
      return;
    }

    // ---- Mode 3: airborne, not swinging — preserve momentum, strong steer ----
    // The bumped AIR_IMPULSE gives generous mid-air control so the player
    // can re-aim a swing-release fling. AIR_MAX_HORIZ caps absurd runaway
    // velocities while still letting the swing-jump's 1.5× gain stand.
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
      // Soft cap on horizontal speed so air control doesn't snowball. Y is
      // untouched — gravity and double-jump still own the vertical channel.
      const cur = aggregate.body.getLinearVelocity();
      const horiz = Math.sqrt(cur.x * cur.x + cur.z * cur.z);
      if (horiz > AIR_MAX_HORIZ) {
        const k = AIR_MAX_HORIZ / horiz;
        aggregate.body.setLinearVelocity(
          new Vector3(cur.x * k, cur.y, cur.z * k),
        );
      }
    }
  });

  return {
    mesh: capsule,
    aggregate,
    state,
    consumeKey: (code: string) => keys.delete(code),
    refillJumps: () => {
      jumpsRemaining = MAX_JUMPS;
    },
  };
}
