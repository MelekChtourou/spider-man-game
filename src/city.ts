import {
  Color3,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";

const GRID = 12;        // 12 x 12 = 144 buildings
const CELL = 18;        // distance between building centers
const BUILDING_W = 12;  // building footprint width/depth
const MIN_H = 15;
const MAX_H = 65;
const GROUND_SIZE = 400;

export function createCity(scene: Scene): void {
  // ---- Ground ----
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: GROUND_SIZE, height: GROUND_SIZE },
    scene,
  );
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.16, 0.16, 0.18);
  groundMat.specularColor = Color3.Black();
  ground.material = groundMat;
  ground.metadata = { kind: "ground" };
  new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

  // ---- Buildings ----
  const origin = -((GRID - 1) * CELL) / 2;

  // Seeded-ish height variation: deterministic-looking patterns by mixing i,j
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = origin + i * CELL;
      const z = origin + j * CELL;

      // Skip the very center cell so the player has a clear spawn area
      if (i === GRID / 2 && j === GRID / 2) continue;

      const height = MIN_H + Math.random() * (MAX_H - MIN_H);

      const box = MeshBuilder.CreateBox(
        `b_${i}_${j}`,
        { width: BUILDING_W, height, depth: BUILDING_W },
        scene,
      );
      box.position = new Vector3(x, height / 2, z);

      const mat = new StandardMaterial(`bm_${i}_${j}`, scene);
      const v = 0.32 + Math.random() * 0.4;
      mat.diffuseColor = new Color3(v, v, v * 1.06);
      mat.specularColor = Color3.Black();
      box.material = mat;

      box.metadata = { kind: "building" };
      new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: 0 }, scene);
    }
  }
}
