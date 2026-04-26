/**
 * Audio layer. Built on the standard Web Audio API (no Babylon Sound
 * dependency) so we don't have to load big audio decoders at startup.
 *
 * For v1 the SFX are *synthesized* in-engine — the layer's API is what
 * matters for gameplay wiring. Swapping in recorded samples later is a
 * matter of pre-loading AudioBuffers and replacing the source-node setup
 * inside each `play*` function; the public surface stays identical.
 */

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

// Continuous-source state. These are the long-lived sources whose gain we
// modulate from player.ts / web.ts each frame.
type ContinuousSource = {
  gain: GainNode;
  // Optional filter we may also modulate from outside.
  filter?: BiquadFilterNode;
};
let windSrc: ContinuousSource | null = null;
let ambienceSrc: ContinuousSource | null = null;

// ----------------------------------------------------------------------------
// Bootstrap. Browsers gate AudioContext creation/play behind a user gesture;
// platform.ts calls `unlockAudio()` on first pointer/key. After that, we
// build the master gain node and start the ambience + wind beds.
// ----------------------------------------------------------------------------

export function unlockAudio(): void {
  if (ctx) {
    // Already created; just resume in case the tab was hidden.
    void ctx.resume();
    return;
  }
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (
      window as unknown as {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  if (!Ctx) return; // browser doesn't support Web Audio — fail silently
  ctx = new Ctx();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.6; // headroom for bursts on top of continuous beds
  masterGain.connect(ctx.destination);

  // Start the ambient bed and wind bed (initially silent — gain set elsewhere).
  ambienceSrc = startAmbience();
  windSrc = startWind();
}

// ----------------------------------------------------------------------------
// Pink-noise generator. We re-use the same buffer for every noise-based SFX,
// keeping per-frame allocation minimal.
// ----------------------------------------------------------------------------

function makeNoiseBuffer(seconds: number): AudioBuffer {
  if (!ctx) throw new Error("audio context not ready");
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr * seconds, sr);
  const data = buf.getChannelData(0);
  // Voss-McCartney approximation of pink noise. Cheap and good enough.
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

// ----------------------------------------------------------------------------
// Ambience bed: low-pass-filtered pink noise, looped, low gain.
// ----------------------------------------------------------------------------
function startAmbience(): ContinuousSource | null {
  if (!ctx || !masterGain) return null;
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(8);
  noise.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 350;
  const gain = ctx.createGain();
  gain.gain.value = 0.18; // gentle background hum
  noise.connect(filter).connect(gain).connect(masterGain);
  noise.start();
  return { gain, filter };
}

// ----------------------------------------------------------------------------
// Wind bed: band-pass-filtered pink noise. Gain externally modulated.
// ----------------------------------------------------------------------------
function startWind(): ContinuousSource | null {
  if (!ctx || !masterGain) return null;
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(6);
  noise.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 750;
  filter.Q.value = 0.5;
  const gain = ctx.createGain();
  gain.gain.value = 0; // silent until setWindIntensity() pushes it up
  noise.connect(filter).connect(gain).connect(masterGain);
  noise.start();
  return { gain, filter };
}

/** Call each frame from player.ts. `intensity` 0..1, smoothed internally. */
export function setWindIntensity(intensity: number): void {
  if (!windSrc || !ctx) return;
  const target = Math.max(0, Math.min(1, intensity)) * 0.35;
  // Smooth ramp so the wind doesn't pop on velocity changes.
  windSrc.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.15);
}

/** Call to dim/restore ambience (e.g. silence on pause). */
export function setAmbienceIntensity(intensity: number): void {
  if (!ambienceSrc || !ctx) return;
  ambienceSrc.gain.gain.setTargetAtTime(
    intensity * 0.18,
    ctx.currentTime,
    0.2,
  );
}

// ----------------------------------------------------------------------------
// One-shot SFX: thwip + landing.
// ----------------------------------------------------------------------------

/** Sharp percussive web-shoot. ~120 ms, falling-pitch noise burst. */
export function playThwip(): void {
  if (!ctx || !masterGain) return;
  const t0 = ctx.currentTime;
  const dur = 0.12;
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(0.2);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 6;
  // Pitch sweep: high → low gives the iconic "thwip" vowel shape.
  filter.frequency.setValueAtTime(4500, t0);
  filter.frequency.exponentialRampToValueAtTime(900, t0 + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.6, t0 + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  noise.connect(filter).connect(gain).connect(masterGain);
  noise.start(t0);
  noise.stop(t0 + dur + 0.05);
}

/** Soft thud when the player lands. Sine-wave click with quick decay. */
export function playLanding(): void {
  if (!ctx || !masterGain) return;
  const t0 = ctx.currentTime;
  const dur = 0.18;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(85, t0);
  osc.frequency.exponentialRampToValueAtTime(40, t0 + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.5, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}
