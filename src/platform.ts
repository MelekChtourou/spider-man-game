/**
 * Platform-integration glue: PWA service worker, fullscreen, orientation
 * lock, screen wake lock, and haptic feedback. Each call is opportunistic —
 * if the platform doesn't support a feature, we silently skip rather than
 * throw, so this module is safe to invoke unconditionally.
 */

// ---- Haptics --------------------------------------------------------------
// Exported so other modules (web.ts, player.ts) can request a buzz on
// gameplay events without each having to know the underlying API name.
export function vibrate(pattern: number | number[]): void {
  if ("vibrate" in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch {
      // Some browsers throw on rapid successive calls; a missed buzz is
      // never worth crashing for.
    }
  }
}

// ---- Service worker -------------------------------------------------------
function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  // Only register in production builds. In dev, Vite serves modules
  // directly and the SW would interfere with HMR + cache fresh changes.
  if (!import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[platform] service worker registration failed", err);
    });
  });
}

// ---- Fullscreen + orientation -------------------------------------------
// Browsers gate both fullscreen and orientation-lock behind a user gesture,
// so we hook the very first pointer-down or key-down and try once.
function setupFullscreenOnFirstGesture(): void {
  const tryEnterFullscreen = async () => {
    const docEl = document.documentElement;
    try {
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen({ navigationUI: "hide" });
      }
    } catch {
      // Refused (Safari iOS especially) — that's fine, the game still works.
    }
    // Orientation lock requires fullscreen on most browsers, hence the order.
    try {
      const orientation = (
        screen as Screen & {
          orientation?: { lock?: (o: string) => Promise<void> };
        }
      ).orientation;
      await orientation?.lock?.("landscape");
    } catch {
      /* refused — many desktops reject */
    }
  };
  const once = () => {
    tryEnterFullscreen();
    document.removeEventListener("pointerdown", once);
    document.removeEventListener("keydown", once);
  };
  document.addEventListener("pointerdown", once, { once: true });
  document.addEventListener("keydown", once, { once: true });
}

// ---- Wake lock ------------------------------------------------------------
// Without this, an idle phone screen will dim and lock mid-swing.
type WakeLockSentinel = { released: boolean; release(): Promise<void> };
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> };
};

async function setupWakeLock(): Promise<void> {
  const nav = navigator as WakeLockNavigator;
  if (!nav.wakeLock) return;

  let sentinel: WakeLockSentinel | null = null;

  const acquire = async () => {
    if (sentinel && !sentinel.released) return;
    try {
      sentinel = await nav.wakeLock!.request("screen");
    } catch {
      /* user might be on low-battery throttle; try again later */
    }
  };

  // Initial acquire (will succeed only if document is visible + focused).
  await acquire();

  // The wake lock auto-releases when the tab is hidden; re-acquire when
  // the user comes back to the page.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      acquire();
    }
  });
}

// ---- Public entry ---------------------------------------------------------
export function setupPlatform(): void {
  registerServiceWorker();
  setupFullscreenOnFirstGesture();
  void setupWakeLock();
}
