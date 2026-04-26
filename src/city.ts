import {
  Color3,
  MeshBuilder,
  PBRMaterial,
  PhysicsAggregate,
  PhysicsShapeType,
  Vector3,
} from "@babylonjs/core";
import type { Mesh, Scene } from "@babylonjs/core";

const GRID = 12;        // 12 x 12 = 144 buildings
const CELL = 18;        // distance between building centers
const BUILDING_W = 12;  // building footprint width/depth
const MIN_H = 15;
const MAX_H = 65;
const GROUND_SIZE = 400;

/** Returned so main.ts can register them as shadow casters / receivers. */
export interface City {
  ground: Mesh;
  buildingSource: Mesh;
}

export function createCity(scene: Scene): City {
  // ---- Ground (PBR, shadow receiver) ----
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: GROUND_SIZE, height: GROUND_SIZE },
    scene,
  );
  const groundMat = new PBRMaterial("groundMat", scene);
  groundMat.albedoColor = new Color3(0.16, 0.16, 0.18);
  groundMat.metallic = 0.0;
  groundMat.roughness = 0.9;
  ground.material = groundMat;
  ground.metadata = { kind: "ground" };
  ground.receiveShadows = true;
  new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

  // ---- Buildings: one source mesh + one shared PBR material + N instances ----
  // Single VBO via instancing collapses ~150 draw calls into ~3. PBR replaces
  // the previous StandardMaterial so building surfaces respond physically to
  // the new sun + IBL environment.
  const sharedMat = new PBRMaterial("buildingMat", scene);
  sharedMat.albedoColor = new Color3(0.45, 0.45, 0.48);
  sharedMat.metallic = 0.0;
  sharedMat.roughness = 0.7;
  // Lock the material once so Babylon can skip re-uploading uniforms per
  // draw — small but real win on mobile GPUs.
  sharedMat.freeze();

  const source = MeshBuilder.CreateBox(
    "buildingSource",
    { width: 1, height: 1, depth: 1 },
    scene,
  );
  source.material = sharedMat;
  source.metadata = { kind: "building" };
  source.receiveShadows = true;
  // Keep the source itself off-screen — only its instances render.
  source.position.y = -10000;

  const origin = -((GRID - 1) * CELL) / 2;

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      // Skip the very center cell so the player has a clear spawn area.
      if (i === GRID / 2 && j === GRID / 2) continue;

      const x = origin + i * CELL;
      const z = origin + j * CELL;
      const height = MIN_H + Math.random() * (MAX_H - MIN_H);

      const inst = source.createInstance(`b_${i}_${j}`);
      inst.position = new Vector3(x, height / 2, z);
      inst.scaling = new Vector3(BUILDING_W, height, BUILDING_W);
      inst.metadata = { kind: "building" };
      // Instances inherit `receiveShadows` from the source — no per-instance
      // toggle needed.

      new PhysicsAggregate(inst, PhysicsShapeType.BOX, { mass: 0 }, scene);
    }
  }

  return { ground, buildingSource: source };
}
