import { Color3, Constants, RawCubeTexture, Scene } from "@babylonjs/core";

const SIZE = 32;

/**
 * A tiny procedural reflection map, sky above and asphalt below, so that metallic
 * materials have something to reflect instead of rendering as flat black.
 */
export function skyEnvironment(scene: Scene, sky: Color3) {
  const horizon = Color3.Lerp(sky, Color3.White(), 0.35);
  const ground = new Color3(0.12, 0.12, 0.13);
  const face = (colorAt: (v: number) => Color3) => {
    const data = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      const c = colorAt(y / (SIZE - 1));
      for (let x = 0; x < SIZE; x++) data.set([c.r * 255, c.g * 255, c.b * 255, 255], (y * SIZE + x) * 4);
    }
    return data;
  };
  // Side faces fade from sky (top row) through a bright horizon down to the ground.
  const side = face((v) => (v < 0.5 ? Color3.Lerp(sky, horizon, v * 2) : Color3.Lerp(horizon, ground, (v - 0.5) * 2)));
  const top = face(() => sky);
  const bottom = face(() => ground);
  // Cube faces in WebGL order: +X, -X, +Y, -Y, +Z, -Z.
  const env = new RawCubeTexture(scene, [side, side, top, bottom, side, side], SIZE, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_INT, true);
  scene.environmentTexture = env;
  scene.environmentIntensity = 0.7;
  return env;
}
