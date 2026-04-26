import {
  DefaultRenderingPipeline,
  ImageProcessingConfiguration,
  SSAO2RenderingPipeline,
} from "@babylonjs/core";
import type { Camera, Scene } from "@babylonjs/core";

/**
 * Cinematic post-processing stack. Attach to the active camera once after
 * scene + camera are constructed.
 *
 * The pipeline order Babylon enforces internally is roughly:
 *   scene render → SSAO → bloom + tone mapping → chromatic aberration →
 *   sharpen → vignette → FXAA. We just enable the toggles; Babylon takes
 *   care of the chaining.
 */

export type RenderQuality = "high" | "low";

export function setupRenderPipelines(
  scene: Scene,
  camera: Camera,
  quality: RenderQuality,
): void {
  // ---- DefaultRenderingPipeline (everything except SSAO) ----
  // hdr=true is what enables the high-precision render target needed for
  // physically-correct bloom + tone mapping. Mandatory with PBR materials,
  // otherwise highlights clip to white before reaching the tone mapper.
  const pipeline = new DefaultRenderingPipeline(
    "default",
    true, // hdr
    scene,
    [camera],
  );
  // We use FXAA for AA; turn off internal MSAA so bloom and the post chain
  // don't have to multi-sample-resolve every frame.
  pipeline.samples = 1;

  // ACES filmic tone mapping — the modern AAA default.
  // Slight exposure under 1.0 keeps shadows readable; +5% contrast pops
  // the mid-tones a touch.
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType =
    ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.exposure = 0.85;
  pipeline.imageProcessing.contrast = 1.1;

  // Bloom: subtle, threshold above 1.0 in HDR space picks up only real
  // highlights (sun-lit windows, sky reflections) instead of every bright
  // pixel.
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.85;
  pipeline.bloomWeight = 0.4;
  pipeline.bloomKernel = 64;
  pipeline.bloomScale = 0.5;

  // FXAA — cheap edge anti-aliasing.
  pipeline.fxaaEnabled = true;

  // Sharpen — adds a touch of definition to long edges so buildings don't
  // look mushy after AA.
  pipeline.sharpenEnabled = true;
  pipeline.sharpen.edgeAmount = 0.3;
  pipeline.sharpen.colorAmount = 1.0;

  // Chromatic aberration — very subtle. Modern AAA polish.
  pipeline.chromaticAberrationEnabled = true;
  pipeline.chromaticAberration.aberrationAmount = 1.5;

  // Vignette darkens the corners. Keeps the eye on the player.
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 0.5;
  pipeline.imageProcessing.vignetteCameraFov = 0.5;

  // ---- SSAO2: only on high quality (skip on coarse-pointer / mobile) ----
  // SSAO2 is the most expensive post in this stack — half-res internal
  // render at 12 samples is still ~2-3 ms on integrated mobile GPUs. The
  // visual win is real but optional.
  if (quality === "high") {
    const ssao = new SSAO2RenderingPipeline("ssao", scene, 0.5, [camera]);
    ssao.totalStrength = 0.9;
    ssao.radius = 1.5;
    ssao.samples = 12;
    ssao.expensiveBlur = true;
  }
}
