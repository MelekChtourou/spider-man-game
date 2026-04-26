import {
  Color3,
  DistanceConstraint,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  Ray,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import type {
  ArcRotateCamera,
  Mesh,
  Scene,
} from "@babylonjs/core";
import type { Player } from "./player";
import { vibrate } from "./platform";

const MAX_RANGE = 200;     // how far each hand reaches for an anchor (m)
const ROPE_SLACK = 0.95;   // attach slightly tighter than current distance for a "yank" feel

// Release-jump: pressing Space while swinging detaches the rope and adds a
// boost to the *current* velocity. The swing's momentum carries you horizontally
// (Havok preserves it on detach), and the boost adds a strong upward kick + a
// horizontal multiplier so a well-timed release at the bottom of the arc feels
// like a launch — Spider-Man's signature "fling" mechanic.
const RELEASE_VERTICAL_BOOST = 11;   // m/s upward at release (≈ 6m peak)
const RELEASE_HORIZONTAL_GAIN = 1.5; // multiply current horizontal velocity by this

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
  let line: Mesh | null = null;

  // Shared material for the web tube — bright white emissive so it reads
  // against both bright sky and dark buildings without depending on lights.
  const webMat = new StandardMaterial("webMat", scene);
  webMat.diffuseColor = Color3.White();
  webMat.emissiveColor = new Color3(0.9, 0.9, 0.95);
  webMat.specularColor = Color3.Black();
  webMat.freeze();

  // OIIA-OIIA cat soundtrack via plain HTMLAudioElement. Babylon 9's audio
  // engine is opt-in and ships uninitialized by default, so we sidestep it
  // entirely. We play the first 2 seconds (≈ "o-i-i-a-i"), and a setTimeout
  // re-rewinds + replays while the rope is still attached.
  const OIIA_CHUNK_MS = 2000;
  const oiiaAudio = new Audio("/assets/oiia-oiia-sound.mp3");
  oiiaAudio.preload = "auto";
  oiiaAudio.volume = 0.8;
  let oiiaLoopTimer: number | null = null;
  function startOiia(): void {
    if (oiiaLoopTimer !== null) clearTimeout(oiiaLoopTimer);
    oiiaAudio.currentTime = 0;
    // play() returns a Promise that rejects if autoplay is blocked. We
    // swallow the rejection — the user gesture (J/L key) almost always
    // unblocks audio, but if it doesn't on some browser, we fail silently.
    void oiiaAudio.play().catch(() => {});
    oiiaLoopTimer = window.setTimeout(function tick() {
      if (player.state.swinging) {
        oiiaAudio.currentTime = 0;
        void oiiaAudio.play().catch(() => {});
        oiiaLoopTimer = window.setTimeout(tick, OIIA_CHUNK_MS);
      } else {
        oiiaLoopTimer = null;
      }
    }, OIIA_CHUNK_MS);
  }
  function stopOiia(): void {
    if (oiiaLoopTimer !== null) {
      clearTimeout(oiiaLoopTimer);
      oiiaLoopTimer = null;
    }
    oiiaAudio.pause();
    oiiaAudio.currentTime = 0;
  }

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
    // moment of the swing loop, so we give it the strongest haptic cue.
    vibrate(20);
    // Restart the OIIA chunk from the beginning — every swing-start should
    // hit "o-i-i-a-i" cleanly from the top, not resume mid-syllable.
    startOiia();
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
    // Cut the music when the rope detaches.
    stopOiia();
  }

  // ---- Keyboard: J = left hand, L = right hand. Bound by physical position ----
  // via event.code, so this works the same on AZERTY and QWERTY layouts.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.code === "KeyJ") startSwing("left");
    else if (e.code === "KeyL") startSwing("right");
    else if (e.code === "Space" && activeHand !== null) {
      // Mid-swing Space → release with momentum boost.
      const v = player.aggregate.body.getLinearVelocity();
      endSwing();
      player.aggregate.body.setLinearVelocity(
        new Vector3(
          v.x * RELEASE_HORIZONTAL_GAIN,
          v.y + RELEASE_VERTICAL_BOOST,
          v.z * RELEASE_HORIZONTAL_GAIN,
        ),
      );
      // Consume the Space press in player.ts's input set so its universal
      // jump handler doesn't also fire on this same press — that was both
      // overriding the release boost AND eating a double-jump charge.
      player.consumeKey("Space");
      e.preventDefault();
      e.stopImmediatePropagation();
      vibrate(15);
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "KeyJ" && activeHand === "left") endSwing();
    else if (e.code === "KeyL" && activeHand === "right") endSwing();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // ---- Visual: draw a tube from the player to the anchor each frame ----
  scene.onBeforeRenderObservable.add(() => {
    if (constraint && anchorMesh) {
      const path = [
        player.mesh.position.clone(),
        anchorMesh.position.clone(),
      ];
      line = MeshBuilder.CreateTube(
        "web",
        {
          path,
          radius: 0.04,
          tessellation: 6, // hex tube — cheap, looks fine
          updatable: true,
          instance: line ?? undefined,
        },
        scene,
      );
      if (!line.material) line.material = webMat;
      line.isPickable = false;
    } else if (line) {
      line.dispose();
      line = null;
    }
  });
}
