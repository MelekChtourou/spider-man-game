import { defineConfig } from "vite";

// Vite 8 (rolldown-vite) pre-bundles npm dependencies via dep-optimization, but
// Babylon.js v9's heavily-cyclic ESM init order doesn't survive that step —
// you get "Cannot read properties of undefined (reading 'MatrixTrackPrecisionChange')"
// in Matrix.Identity during module bootstrap. Skipping optimization for Babylon
// makes Vite serve the original ESM files, preserving init order.
export default defineConfig({
  optimizeDeps: {
    exclude: ["@babylonjs/core", "@babylonjs/havok"],
  },
  server: {
    fs: {
      // Allow serving the WASM from node_modules if anything ever falls back to it
      allow: [".."],
    },
  },
});
