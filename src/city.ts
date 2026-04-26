import {
  Color3,
  Color4,
  MeshBuilder,
  PBRMaterial,
  PhysicsAggregate,
  PhysicsShapeType,
  Scene as SceneCtor,
  Texture,
  Vector3,
} from "@babylonjs/core";
import type { Mesh, Scene } from "@babylonjs/core";

const GRID = 12;        // 12 x 12 = 144 buildings
const CELL = 18;        // distance between building centers
const BUILDING_W = 12;  // building footprint width/depth
const MIN_H = 15;
const MAX_H = 65;
const GROUND_SIZE = 400;

// Curated palette of muted realistic city tones. Picked one per instance via
// random index so the city looks varied without being kitsch.
const BUILDING_TINTS: Color4[] = [
  new Color4(0.55, 0.55, 0.58, 1), // warm concrete
  new Color4(0.42, 0.45, 0.50, 1), // cool concrete
  new Color4(0.65, 0.58, 0.48, 1), // sandstone
  new Color4(0.30, 0.32, 0.36, 1), // dark glass
  new Color4(0.55, 0.36, 0.30, 1), // brick red
  new Color4(0.68, 0.66, 0.62, 1), // dirty white
];

/** Returned so main.ts can register them as shadow casters / receivers. */
export interface City {
  ground: Mesh;
  /** One source mesh per palette tint. Each has its own batch of instances. */
  buildingSources: Mesh[];
}

export function createCity(scene: Scene): City {
  // ---- Atmospheric fog ---------------------------------------------------
  // Exponential-squared fog gives soft "haze" falloff that hides the play-
  // area edge and adds perceived depth. Density ~0.005 means visibility
  // starts dropping at ~70 m and is heavily faded at ~400 m.
  scene.fogMode = SceneCtor.FOGMODE_EXP2;
  scene.fogDensity = 0.005;
  // Match the fog color to the env tint so the horizon blends seamlessly
  // into the skybox.
  scene.fogColor = new Color3(0.62, 0.66, 0.72);

  // ---- Ground (textured PBR, shadow receiver) ---------------------------
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: GROUND_SIZE, height: GROUND_SIZE },
    scene,
  );
  const groundMat = new PBRMaterial("groundMat", scene);

  // Tileable asphalt PBR set from Poly Haven (CC0 — see public/textures/CREDITS.txt).
  // Tile across the 400 m ground at ~5 m per tile for visible texture detail.
  const TILE = GROUND_SIZE / 5; // 80 repetitions across each axis
  const tileTex = (path: string) => {
    const t = new Texture(path, scene);
    t.uScale = TILE;
    t.vScale = TILE;
    return t;
  };
  groundMat.albedoTexture = tileTex("/textures/ground/asphalt_02_diff_1k.jpg");
  groundMat.bumpTexture = tileTex("/textures/ground/asphalt_02_nor_gl_1k.jpg");
  // Babylon expects OpenGL-style normals on bumpTexture; matches the file we
  // downloaded ("_nor_gl_").
  groundMat.metallicTexture = tileTex(
    "/textures/ground/asphalt_02_rough_1k.jpg",
  );
  // Tell PBR which channels of metallicTexture to read. Polyhaven's "rough"
  // is single-channel grayscale; we put it in the green slot per glTF
  // convention. metallic stays 0 (asphalt isn't a conductor).
  groundMat.useRoughnessFromMetallicTextureGreen = true;
  groundMat.useRoughnessFromMetallicTextureAlpha = false;
  groundMat.metallic = 0.0;
  // Slight tonal nudge — pure-color albedoColor is multiplied with the
  // texture, so this just tilts the asphalt a touch cooler to match the env.
  groundMat.albedoColor = new Color3(0.85, 0.85, 0.88);

  ground.material = groundMat;
  ground.metadata = { kind: "ground" };
  ground.receiveShadows = true;
  new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

  // ---- Buildings: one source mesh per tint, instances under each --------
  // We want per-instance color variety, but PBRMaterial doesn't ship a
  // first-class per-instance color attribute the way StandardMaterial does.
  // Solution: N source meshes (one per palette entry) each with its own
  // pre-tinted PBR material; for each grid cell, pick a random source and
  // create an instance under it. Total draw calls = 6 (one per source's
  // batch) + 1 ground = 7. Was 144 before instancing landed.
  const sources: Mesh[] = BUILDING_TINTS.map((tint, idx) => {
    const mat = new PBRMaterial(`buildingMat_${idx}`, scene);
    mat.albedoColor = new Color3(tint.r, tint.g, tint.b);
    mat.metallic = 0.0;
    // Slight roughness variation per tint reads as different materials
    // (concrete vs glass vs brick).
    mat.roughness = 0.55 + (idx % 3) * 0.15;
    mat.freeze();

    const src = MeshBuilder.CreateBox(
      `buildingSource_${idx}`,
      { width: 1, height: 1, depth: 1 },
      scene,
    );
    src.material = mat;
    src.metadata = { kind: "building" };
    src.receiveShadows = true;
    // Keep the source itself off-screen — only its instances render.
    src.position.y = -10000;
    return src;
  });

  const origin = -((GRID - 1) * CELL) / 2;

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      // Skip the very center cell so the player has a clear spawn area.
      if (i === GRID / 2 && j === GRID / 2) continue;

      const x = origin + i * CELL;
      const z = origin + j * CELL;
      const height = MIN_H + Math.random() * (MAX_H - MIN_H);

      // Pick a random source (and therefore a random tint) for this
      // building. Deterministic-ish via i,j hash so the city layout looks
      // the same across reloads — feels less random in a good way.
      const tintIdx = Math.abs((i * 7 + j * 13) >>> 0) % sources.length;
      const inst = sources[tintIdx].createInstance(`b_${i}_${j}`);
      inst.position = new Vector3(x, height / 2, z);
      inst.scaling = new Vector3(BUILDING_W, height, BUILDING_W);
      inst.metadata = { kind: "building" };

      new PhysicsAggregate(inst, PhysicsShapeType.BOX, { mass: 0 }, scene);
    }
  }

  // Return the first source for shadow-caster registration. The shadow
  // generator iterates an InstancedMesh's parent's instances, so registering
  // each source covers its own batch.
  return { ground, buildingSources: sources };
}
