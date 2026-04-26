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

const MAX_RANGE = 400;     // how far each hand reaches for an anchor (m)
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

  // OIIA soundtrack via Web Audio API: pre-decoded AudioBuffers +
  // AudioBufferSourceNode = sample-accurate playback with no decode delay
  // when tier transitions need to seek to a new section.
  //
  // Two tracks are pre-decoded: the standard "o-i-i-a-i" chunk (looped over
  // its first 2s while airborne with no trip — Tier 0), and the OIIA REMIX
  // (Tiers 1–3 each play it from a different seek offset that lines up with
  // a musical section: intro / drop / peak).
  const OIIA_LOOP_END = 2;
  // Tier → seek offset into the remix (seconds). Found via RMS analysis of
  // oiiai remix.mp3: drop hits at ~26s, peak section at ~73s.
  const TIER_SEEK_OFFSETS = [0, 0, 26, 73];

  const audioCtx = new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.8;
  masterGain.connect(audioCtx.destination);

  let oiiaBuffer: AudioBuffer | null = null;
  let remixBuffer: AudioBuffer | null = null;
  let currentSource: AudioBufferSourceNode | null = null;
  // Mode the audio router is currently in. Distinct from player.state.tier
  // because (a) we only restart the source on actual transitions, and (b)
  // "max" mode is a special non-looping case for OIIA MAX.
  //   "off" / "t0" / "t1" / "t2" / "t3" / "max"
  let playingMode: "off" | "t0" | "t1" | "t2" | "t3" | "max" = "off";

  const decode = (path: string) =>
    fetch(path)
      .then((r) => r.arrayBuffer())
      .then((buf) => audioCtx.decodeAudioData(buf))
      .catch(() => null);

  void decode("/assets/oiia-oiia-sound.mp3").then((b) => { oiiaBuffer = b; });
  void decode("/assets/oiiai remix.mp3").then((b) => { remixBuffer = b; });

  function playTier(tier: 0 | 1 | 2 | 3): void {
    const buffer = tier === 0 ? oiiaBuffer : remixBuffer;
    if (!buffer) return;
    if (audioCtx.state === "suspended") void audioCtx.resume();
    if (currentSource) {
      try { currentSource.stop(); } catch { /* already stopped */ }
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    if (tier === 0) {
      src.loopStart = 0;
      src.loopEnd = OIIA_LOOP_END;
    }
    // Tier 1-3 loop the whole remix; their start *offset* picks the section.
    src.connect(masterGain);
    src.start(0, TIER_SEEK_OFFSETS[tier]);
    currentSource = src;
    playingMode = (tier === 0 ? "t0" : tier === 1 ? "t1" : tier === 2 ? "t2" : "t3");
  }

  function startMaxMode(): void {
    if (!remixBuffer) return;
    if (audioCtx.state === "suspended") void audioCtx.resume();
    if (currentSource) {
      try { currentSource.stop(); } catch { /* already stopped */ }
    }
    const src = audioCtx.createBufferSource();
    src.buffer = remixBuffer;
    src.loop = false; // play the full track *once* — that's the whole point
    // When the buffer ends naturally, drop maxMode so the player is freed.
    // Stopping early via .stop() also fires onended, so we guard against
    // it firing twice by checking currentSource identity before clearing.
    src.onended = () => {
      if (currentSource === src) {
        currentSource = null;
        playingMode = "off";
      }
      player.state.maxMode = false;
    };
    src.connect(masterGain);
    src.start(); // from t=0 — full song, no seek
    currentSource = src;
    playingMode = "max";
  }

  function stopAudio(): void {
    if (currentSource) {
      try { currentSource.stop(); } catch { /* already stopped */ }
      currentSource = null;
    }
    playingMode = "off";
  }

  // Per-frame audio routing.
  //   maxMode true → "max" (full remix, single play, can't be interrupted)
  //   Tier 0, grounded → silence
  //   Tier 0, airborne → standard OIIA chunk loop
  //   Tier 1/2/3 → remix from corresponding seek offset, looped
  scene.onBeforeRenderObservable.add(() => {
    if (player.state.maxMode) {
      if (playingMode !== "max") startMaxMode();
      return;
    }
    const tier = player.state.tier;
    const airborneOrMoving = player.state.airTime > 0;
    const desired: typeof playingMode =
      tier > 0
        ? (`t${tier}` as "t1" | "t2" | "t3")
        : airborneOrMoving
        ? "t0"
        : "off";
    if (desired !== playingMode) {
      if (desired === "off") stopAudio();
      else playTier(tier as 0 | 1 | 2 | 3);
    }
  });

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
    // Audio routing happens in the per-frame observer above.
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
    // Audio routing happens in the per-frame observer; if the player is
    // still airborne or in a forced tier, music keeps playing until landing.
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
      // Hand the player two fresh mid-air jumps after every release so a
      // "ground-jump → swing → release → double-jump" chain always has
      // the full double-jump budget.
      player.refillJumps();
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
