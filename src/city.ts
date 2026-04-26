import {
  Color3,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import type { BuildingSource } from "./assets";

const GRID = 20; // 20 x 20 = 400 building cells (center skipped → 399)
const CELL = 34; // distance between building centers — wide streets for swinging
const FOOTPRINT_TARGET = 14; // building base width — leaves ~20u of road in each cell
const HEIGHT_MIN = 28; // shortest building (world units)
const HEIGHT_MAX = 85; // tallest skyscraper — taller arc for swing-jumps
const GROUND_SIZE = 800; // accommodates the larger 20×34 = 680u city span

export function createCity(scene: Scene, sources: BuildingSource[]): void {
  // ---- Ground ----
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: GROUND_SIZE, height: GROUND_SIZE },
    scene,
  );
  // Stylized dark asphalt using StandardMaterial: PBR on a flat plane gets
  // washed out by the bright HDRI ambient and merges with the sky. Standard
  // ignores the environment texture, so the dark color lands faithfully and
  // the ground reads as a distinct surface. We lock specular off (matte) and
  // freeze the material so per-frame uniform uploads are skipped.
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.18, 0.19, 0.22);
  groundMat.specularColor = Color3.Black();
  groundMat.freeze();
  ground.material = groundMat;
  ground.metadata = { kind: "ground" };
  new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

  // ---- Buildings ----
  // For each cell we pick a random source mesh, instance it (one draw call
  // per source variant total, regardless of instance count), give it a
  // random Y rotation in 90° steps to add variety without breaking the box
  // physics colliders, and attach a BOX aggregate sized to the *scaled*
  // bounds of that instance.
  const origin = -((GRID - 1) * CELL) / 2;

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      // Skip the very center cell so the player has a clear spawn area.
      if (i === GRID / 2 && j === GRID / 2) continue;

      const x = origin + i * CELL;
      const z = origin + j * CELL;

      const source = sources[Math.floor(Math.random() * sources.length)];

      // Compute per-instance scaling so the building lands in the target
      // size range regardless of the source mesh's natural dimensions.
      // X/Z stretch the natural footprint to FOOTPRINT_TARGET; Y stretches
      // the natural height to a random target in [HEIGHT_MIN, HEIGHT_MAX].
      const sourceMaxFootprint = Math.max(
        2 * source.halfExtentX,
        2 * source.halfExtentZ,
      );
      const footprintScale = FOOTPRINT_TARGET / sourceMaxFootprint;
      const targetHeight = HEIGHT_MIN + Math.random() * (HEIGHT_MAX - HEIGHT_MIN);
      const yScale = targetHeight / source.height;

      const inst = source.mesh.createInstance(`b_${i}_${j}`);
      // Random 90° Y-rotation keeps the box collider axis-aligned with
      // the rotated mesh, so the collider still matches the visible shape.
      const yRot = Math.floor(Math.random() * 4) * (Math.PI / 2);
      inst.rotation = new Vector3(0, yRot, 0);
      inst.scaling = new Vector3(footprintScale, yScale, footprintScale);
      // Position the instance with its base at y=0 (Kenney buildings are
      // authored with their base near origin, so this lands them on the
      // ground plane).
      inst.position = new Vector3(x, 0, z);
      // Visual instances skip picking — the simpler physics-box proxy below
      // handles raycast targeting, which is faster than triangle-picking the
      // detailed glTF geometry.
      inst.isPickable = false;

      // Physics: a static box collider sized to the scaled bounds. The X/Z
      // half-extents swap when rotation is 90°/270°, so we pass the actual
      // post-rotation bounds.
      const rotSwapXZ = yRot === Math.PI / 2 || yRot === (3 * Math.PI) / 2;
      const halfX = source.halfExtentX * footprintScale;
      const halfZ = source.halfExtentZ * footprintScale;
      const physMesh = MeshBuilder.CreateBox(
        `bPhys_${i}_${j}`,
        {
          width: (rotSwapXZ ? halfZ : halfX) * 2,
          height: targetHeight,
          depth: (rotSwapXZ ? halfX : halfZ) * 2,
        },
        scene,
      );
      physMesh.position = new Vector3(x, targetHeight / 2, z);
      physMesh.isVisible = false;
      physMesh.isPickable = true; // swing raycast picks the collider proxy
      physMesh.metadata = { kind: "building" };
      new PhysicsAggregate(physMesh, PhysicsShapeType.BOX, { mass: 0 }, scene);
    }
  }
}
