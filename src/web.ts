import {
  Color3,
  DistanceConstraint,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  Ray,
  Vector3,
} from "@babylonjs/core";
import type {
  ArcRotateCamera,
  LinesMesh,
  Mesh,
  Scene,
} from "@babylonjs/core";
import type { Player } from "./player";
import { vibrate } from "./platform";
import { playThwip } from "./audio";

const MAX_RANGE = 200;     // how far each hand reaches for an anchor (m)
const ROPE_SLACK = 0.95;   // attach slightly tighter than current distance for a "yank" feel

// Direction-cone weights for the per-hand raycast. These shape *where* each
// hand looks for an anchor:
//   left hand (J): up + camera-forward + a bias to the LEFT
//   right hand (L): up + camera-forward + a bias to the RIGHT
const FORWARD_WEIGHT = 0.5;
const UP_WEIGHT = 1.5;
const SIDE_WEIGHT = 0.8;

type Hand = "left" | "right";

export function createWebSwing(
  scene: Scene,
  player: Player,
  camera: ArcRotateCamera,
): void {
  let activeHand: Hand | null = null;
  let constraint: DistanceConstraint | null = null;
  let anchorMesh: Mesh | null = null;
  let anchorAggregate: PhysicsAggregate | null = null;
  let line: LinesMesh | null = null;

  function rayDirForHand(hand: Hand): Vector3 {
    let forward = camera.getForwardRay().direction.clone();
    forward.y = 0;
    if (forward.lengthSquared() < 1e-6) forward = new Vector3(0, 0, 1);
    forward.normalize();
    const right = Vector3.Cross(Vector3.Up(), forward).normalize();
    const sideSign = hand === "left" ? -1 : 1;
    return forward
      .scale(FORWARD_WEIGHT)
      .add(Vector3.Up().scale(UP_WEIGHT))
      .add(right.scale(sideSign * SIDE_WEIGHT))
      .normalize();
  }

  function startSwing(hand: Hand): void {
    if (activeHand === hand) return; // already swinging this hand
    if (activeHand !== null) endSwing(); // switch hands cleanly

    const dir = rayDirForHand(hand);
    // Origin slightly above the capsule so the ray doesn't graze the ground.
    const origin = player.mesh.position.add(new Vector3(0, 0.5, 0));
    const ray = new Ray(origin, dir, MAX_RANGE);
    const hit = scene.pickWithRay(
      ray,
      (m) => m.metadata?.kind === "building",
    );
    if (!hit?.hit || !hit.pickedPoint) {
      // Out of range / nothing hit: silently do nothing, as requested.
      return;
    }

    const anchorPos = hit.pickedPoint;

    // Static, invisible anchor body at the hit point.
    anchorMesh = MeshBuilder.CreateSphere(
      "anchor",
      { diameter: 0.2 },
      scene,
    );
    anchorMesh.position = anchorPos;
    anchorMesh.isVisible = false;
    anchorMesh.isPickable = false;
    anchorAggregate = new PhysicsAggregate(
      anchorMesh,
      PhysicsShapeType.SPHERE,
      { mass: 0 },
      scene,
    );

    const dist =
      Vector3.Distance(player.mesh.position, anchorPos) * ROPE_SLACK;

    constraint = new DistanceConstraint(dist, scene);
    player.aggregate.body.addConstraint(anchorAggregate.body, constraint);

    activeHand = hand;
    player.state.swinging = true;
    // Sharp tactile "thwip" — the rope catching is the most satisfying
    // moment of the swing loop, so we give it the strongest haptic cue and
    // a synced audio cue.
    vibrate(20);
    playThwip();
    // Iconic Insomniac "moment of weight": brief slow-motion on rope catch
    // emphasizes the impact. Physics step in main.ts respects the scale.
    triggerSlowMo();
  }

  function endSwing(): void {
    if (constraint) {
      constraint.dispose();
      constraint = null;
    }
    if (anchorAggregate) {
      anchorAggregate.dispose();
      anchorAggregate = null;
    }
    if (anchorMesh) {
      anchorMesh.dispose();
      anchorMesh = null;
    }
    if (line) {
      line.dispose();
      line = null;
    }
    activeHand = null;
    player.state.swinging = false;
  }

  // Brief slow-mo: 0.4× time scale for 150 ms after a successful catch.
  // Skips if a slow-mo is already in flight so a flurry of catches doesn't
  // chain into permanent slow time.
  let slowMoTimer: ReturnType<typeof setTimeout> | null = null;
  function triggerSlowMo(): void {
    if (slowMoTimer !== null) return;
    scene.animationTimeScale = 0.4;
    slowMoTimer = setTimeout(() => {
      scene.animationTimeScale = 1.0;
      slowMoTimer = null;
    }, 150);
  }

  // ---- Keyboard: J = left hand, L = right hand. Bound by physical position ----
  // via event.code, so this works the same on AZERTY and QWERTY layouts.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.code === "KeyJ") startSwing("left");
    else if (e.code === "KeyL") startSwing("right");
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "KeyJ" && activeHand === "left") endSwing();
    else if (e.code === "KeyL" && activeHand === "right") endSwing();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // ---- Visual: draw a line from the player to the anchor each frame ----
  scene.onBeforeRenderObservable.add(() => {
    if (constraint && anchorMesh) {
      const points = [
        player.mesh.position.clone(),
        anchorMesh.position.clone(),
      ];
      line = MeshBuilder.CreateLines(
        "web",
        { points, updatable: true, instance: line ?? undefined },
        scene,
      );
      line.color = new Color3(1, 1, 1);
      line.isPickable = false;
    } else if (line) {
      line.dispose();
      line = null;
    }
  });
}
