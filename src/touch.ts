import nipplejs from "nipplejs";
import type { FollowCamera } from "./camera";

/**
 * Touch / pointer input layer for mobile web. Builds a virtual joystick
 * (left thumb), three action buttons (right thumb), and a camera-orbit
 * area on the unused part of the right half of the screen.
 *
 * Inputs are translated into synthetic keyboard events with the same
 * `event.code` values that player.ts and web.ts already listen for —
 * so the existing keyboard code paths handle everything; we just feed
 * them from a different source.
 */

const STICK_DEAD_ZONE = 0.3; // |vector| below this counts as neutral

// One-shot test for whether this device exposes touch at all. Devices that
// expose touch *and* a keyboard (iPad with keyboard, Surface) get both UIs
// at once — that's intentional.
function isTouchDevice(): boolean {
  return (
    "ontouchstart" in window ||
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
  );
}

export function setupTouchControls(camera: FollowCamera): void {
  if (!isTouchDevice()) return;

  // ---------- Build the DOM overlay ----------
  const root = document.createElement("div");
  root.id = "touch-ui";
  root.innerHTML = `
    <div id="touch-cam"></div>
    <div id="touch-stick"></div>
    <div id="touch-buttons">
      <button id="btn-jump" type="button" aria-label="Jump">⤒</button>
      <div id="btn-row">
        <button id="btn-left-hand" type="button" aria-label="Left-hand swing">L</button>
        <button id="btn-right-hand" type="button" aria-label="Right-hand swing">R</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  // ---------- Synthetic key dispatch helpers ----------
  // Track which synthetic codes we currently have "down" so we never send
  // a duplicate keydown (and never miss the matching keyup on cancel).
  const heldCodes = new Set<string>();

  const press = (code: string) => {
    if (heldCodes.has(code)) return;
    heldCodes.add(code);
    window.dispatchEvent(new KeyboardEvent("keydown", { code }));
  };
  const release = (code: string) => {
    if (!heldCodes.has(code)) return;
    heldCodes.delete(code);
    window.dispatchEvent(new KeyboardEvent("keyup", { code }));
  };

  // ---------- Action buttons ----------
  // pointerdown → press, pointerup/cancel/leave → release. We use Pointer
  // Events for unified mouse/touch/pen, and listen on `pointercancel` so an
  // OS interruption (e.g. system gesture) doesn't leave a key stuck "down".
  const wireButton = (el: HTMLElement, code: string) => {
    const down = (e: PointerEvent) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      press(code);
    };
    const up = (e: PointerEvent) => {
      e.preventDefault();
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer may already be released */
      }
      release(code);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", up);
  };
  wireButton(document.getElementById("btn-jump")!, "Space");
  wireButton(document.getElementById("btn-left-hand")!, "KeyJ");
  wireButton(document.getElementById("btn-right-hand")!, "KeyL");

  // ---------- Virtual joystick ----------
  const stick = nipplejs.create({
    zone: document.getElementById("touch-stick")!,
    mode: "static",
    position: { left: "50%", top: "50%" },
    color: "white",
    size: 110,
    fadeTime: 0,
  });

  // Map joystick vector (x: right+, y: up+) to KeyW/A/S/D, with a dead-zone.
  const updateStickKeys = (x: number, y: number) => {
    if (y > STICK_DEAD_ZONE) press("KeyW"); else release("KeyW");
    if (y < -STICK_DEAD_ZONE) press("KeyS"); else release("KeyS");
    if (x > STICK_DEAD_ZONE) press("KeyD"); else release("KeyD");
    if (x < -STICK_DEAD_ZONE) press("KeyA"); else release("KeyA");
  };
  // nipplejs's overload-heavy `.on()` confuses TS's overload picker, so we
  // narrow once via a typed alias and call through that.
  type StickHandler = (
    e: unknown,
    data: { vector?: { x: number; y: number } },
  ) => void;
  const onStick = (event: string, cb: StickHandler) =>
    (stick as unknown as { on: (e: string, cb: StickHandler) => void }).on(
      event,
      cb,
    );
  onStick("move", (_e, data) => {
    if (!data?.vector) return;
    updateStickKeys(data.vector.x, data.vector.y);
  });
  onStick("end", () => updateStickKeys(0, 0));

  // ---------- Camera orbit drag (right half of screen, behind buttons) ----
  const camArea = document.getElementById("touch-cam")!;
  const ALPHA_RAD_PER_PX = 0.005; // tunable; ~one full screen-width = ~270°
  const BETA_RAD_PER_PX = 0.004;

  // We track at most one orbit pointer at a time. Multi-touch gestures
  // (e.g. pinch) would go here, but the auto-camera already handles framing
  // and dolly so an explicit zoom isn't necessary in v1.
  let activeOrbitId: number | null = null;
  let lastX = 0;
  let lastY = 0;

  camArea.addEventListener("pointerdown", (e) => {
    if (activeOrbitId !== null) return;
    activeOrbitId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    camArea.setPointerCapture(e.pointerId);
    camera.suppressAutoAlign(2500); // long enough to feel like a real "look"
  });

  camArea.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activeOrbitId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    // Drag right → orbit camera right (negative alpha delta in our setup).
    camera.alpha -= dx * ALPHA_RAD_PER_PX;
    camera.beta = Math.min(
      camera.upperBetaLimit ?? Math.PI / 2 - 0.05,
      Math.max(
        camera.lowerBetaLimit ?? 0.15,
        camera.beta + dy * BETA_RAD_PER_PX,
      ),
    );
    // Re-arm the auto-align suppression so it stays paused as long as the
    // user keeps moving their finger.
    camera.suppressAutoAlign(2500);
  });

  const releaseOrbit = (e: PointerEvent) => {
    if (e.pointerId !== activeOrbitId) return;
    try {
      camArea.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    activeOrbitId = null;
  };
  camArea.addEventListener("pointerup", releaseOrbit);
  camArea.addEventListener("pointercancel", releaseOrbit);
  camArea.addEventListener("pointerleave", releaseOrbit);
}
