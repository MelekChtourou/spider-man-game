import { Mesh, SceneLoader, Vector3 } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { AnimationGroup, Scene, TransformNode } from "@babylonjs/core";

const BUILDING_DIR = "/assets/buildings/";

// Curated subset of the Kenney City Kit Commercial pack: 5 skyscrapers
// (the ones tall enough for a Spider-Man swing) plus 5 shorter buildings
// for visual variety. The 144 grid cells get filled by random selection
// from this list.
const BUILDING_FILES = [
  "building-skyscraper-a.glb",
  "building-skyscraper-b.glb",
  "building-skyscraper-c.glb",
  "building-skyscraper-d.glb",
  "building-skyscraper-e.glb",
  "building-a.glb",
  "building-c.glb",
  "building-h.glb",
  "building-k.glb",
  "building-n.glb",
];

export interface BuildingSource {
  /** Single Mesh ready to be instanced via createInstance(). */
  mesh: Mesh;
  /** Local-space height of the source (Y extent). Used to scale instances. */
  height: number;
  /** Local-space horizontal half-extents (XZ). Used to size physics boxes. */
  halfExtentX: number;
  halfExtentZ: number;
}

/**
 * Loads each glb, merges its child meshes into a single Mesh, and parks the
 * source off-screen so only its instances render. Returns one BuildingSource
 * per glb file with the metrics needed to position + collide instances.
 */
export async function loadBuildingSources(scene: Scene): Promise<BuildingSource[]> {
  const sources: BuildingSource[] = [];
  for (const file of BUILDING_FILES) {
    const result = await SceneLoader.ImportMeshAsync(
      "",
      BUILDING_DIR,
      file,
      scene,
    );
    // The first mesh is __root__ (a TransformNode wrapper that handles the
    // glTF coordinate-system flip); the actual geometry is in meshes[1+].
    const meshes = result.meshes.filter(
      (m) => m instanceof Mesh && m.getTotalVertices() > 0,
    ) as Mesh[];
    if (meshes.length === 0) {
      throw new Error(`No renderable meshes found in ${file}`);
    }

    // Some Kenney buildings are split across several mesh primitives (e.g. a
    // body + windows + roof). Merging them flattens to a single Mesh whose
    // instances cost only one draw call each.
    const merged =
      meshes.length === 1
        ? meshes[0]
        : Mesh.MergeMeshes(
            meshes,
            true,  // disposeSource
            true,  // allow32BitsIndices
            undefined,
            false,
            true,  // multiMultiMaterials — preserves per-mesh materials
          );
    if (!merged) throw new Error(`Failed to merge meshes in ${file}`);

    merged.name = `bSrc_${file.replace(".glb", "")}`;
    merged.isPickable = false; // swing rays pick the per-instance phys box

    // Detach from any parent the glTF loader inserted (typically __root__,
    // which exists to flip the right-handed glTF coord system). Without this
    // step the source's world matrix inherits __root__'s rotation, and any
    // disposal of __root__ later would cascade and destroy our geometry.
    merged.setParent(null);

    // Compute bounds of the source mesh (after merging). We need this to
    // scale instances by their natural height and to size physics boxes.
    merged.refreshBoundingInfo();
    const info = merged.getBoundingInfo();
    const min = info.boundingBox.minimum;
    const max = info.boundingBox.maximum;
    const height = max.y - min.y;
    const halfExtentX = (max.x - min.x) / 2;
    const halfExtentZ = (max.z - min.z) / 2;

    // Park the source way off-screen so it doesn't show; we only render its
    // instances. We can't simply hide it with isVisible=false because that
    // would also hide all instances.
    merged.position = new Vector3(0, -10000, 0);
    merged.setEnabled(false);

    sources.push({ mesh: merged, height, halfExtentX, halfExtentZ });
  }
  return sources;
}

export interface CharacterAssets {
  root: TransformNode;
  animations: Record<string, AnimationGroup>;
}

/**
 * Loads the player character. Prefers `oiia.glb` (the spinning OIIA-OIIA cat
 * meme model) when present; falls back to the bundled Universal Base Characters
 * superhero glTF so the page still runs before the user has dropped in a cat.
 *
 * The model's baked animation — typically a continuous spin for the cat — is
 * auto-played by player.ts, and the auto-fit logic there scales whatever model
 * lands here to the player capsule's height.
 */
export async function loadCharacter(scene: Scene): Promise<CharacterAssets> {
  // Try the cat first; on any error (file missing, parse failure under Vite's
  // SPA fallback that returns index.html for unknown paths) fall back to the
  // bundled superhero glTF so the page still runs.
  let result;
  try {
    result = await SceneLoader.ImportMeshAsync(
      "",
      "/assets/character/",
      "oiia.glb",
      scene,
    );
  } catch {
    result = await SceneLoader.ImportMeshAsync(
      "",
      "/assets/character/",
      "Superhero_Male_FullBody.gltf",
      scene,
    );
  }
  const root = result.meshes[0]; // __root__ TransformNode
  return {
    root,
    animations: Object.fromEntries(
      result.animationGroups.map((g) => [g.name, g]),
    ),
  };
}
