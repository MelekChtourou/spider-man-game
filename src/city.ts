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

  // ---- Buildings: one source mesh + one shared material + N instances ----
  // Before this commit each building had its own Mesh and StandardMaterial,
  // which meant ~144 draw calls and 144 unique GPU programs. Instancing
  // collapses rendering to a single draw call (or a couple, after culling
  // partitions) by reusing one VBO with per-instance world matrices.
  const sharedMat = new StandardMaterial("buildingMat", scene);
  sharedMat.diffuseColor = new Color3(0.45, 0.45, 0.48);
  sharedMat.specularColor = Color3.Black();
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
  // The source itself is invisible — only its instances render. We can't
  // simply hide it (would hide all instances too); placing it far below the
  // map keeps it out of frame without that side-effect.
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

      // Static physics body. The aggregate reads the instance's scaled
      // bounds, so each building gets a correctly-sized box collider.
      new PhysicsAggregate(inst, PhysicsShapeType.BOX, { mass: 0 }, scene);
    }
  }
}
