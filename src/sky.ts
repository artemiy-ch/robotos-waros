import { Color3, DynamicTexture, Effect, Mesh, MeshBuilder, Scene, ShaderMaterial, StandardMaterial, Vector3 } from "@babylonjs/core";
import { earthTexture } from "./moon";

Effect.ShadersStore["skyVertexShader"] = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

Effect.ShadersStore["skyFragmentShader"] = `
precision highp float;
varying vec3 vDir;
uniform vec3 zenith;
uniform vec3 horizon;
uniform float flash;
uniform float starFloor;
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(horizon, zenith, pow(h, 0.55));
  // Stars: a few faint ones high up through the smog, or the whole sky full of them on the Moon.
  float star = step(0.9986, hash(floor(d * 420.0))) * mix(smoothstep(0.35, 0.85, h), 1.0, starFloor);
  float bright = 0.55 + starFloor * 0.45 * hash(floor(d * 420.0) + 7.0);
  col += star * bright;
  col += flash * vec3(0.55, 0.6, 0.75) * (0.35 + 0.65 * h);
  gl_FragColor = vec4(col, 1.0);
}`;

Effect.ShadersStore["planetVertexShader"] = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vNormal;
varying vec3 vPos;
varying vec2 vUV;
void main() {
  vNormal = normalize((world * vec4(normal, 0.0)).xyz);
  vPos = (world * vec4(position, 1.0)).xyz;
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

Effect.ShadersStore["planetFragmentShader"] = `
precision highp float;
varying vec3 vNormal;
varying vec3 vPos;
varying vec2 vUV;
uniform sampler2D surface;
uniform vec3 lightDir;
uniform vec3 cameraPosition;
uniform vec3 rim;
uniform vec3 haze;
uniform float hazeAmount;
uniform float flash;
void main() {
  vec3 n = normalize(vNormal);
  vec3 toEye = normalize(cameraPosition - vPos);
  float lit = smoothstep(-0.12, 0.55, dot(n, normalize(lightDir)));
  vec3 base = texture2D(surface, vUV).rgb;
  // Atmosphere glowing around the limb, strongest on the day side.
  float fresnel = pow(1.0 - max(dot(n, toEye), 0.0), 2.5);
  vec3 col = base * (0.05 + lit) + rim * fresnel * (0.25 + 0.9 * lit);
  // Seen through the city's smog: hazier towards the horizon.
  float up = normalize(vPos - cameraPosition).y;
  col = mix(col, haze, hazeAmount * mix(0.55, 0.12, smoothstep(0.0, 0.35, up)));
  col += flash * 0.15;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Horizontal bands of a gas giant, wobbling and turbulent. */
function bandsTexture(scene: Scene) {
  const w = 512, h = 256;
  const tex = new DynamicTexture("planetBands", { width: w, height: h }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  const palette = [[196, 120, 70], [228, 190, 140], [150, 82, 52], [210, 160, 105], [96, 120, 128], [180, 110, 75]];
  const img = c.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const wobble = Math.sin(u * Math.PI * 6 + y * 0.09) * 3 + Math.sin(u * Math.PI * 14 + y * 0.31) * 1.5;
      const t = (y + wobble) / h;
      const band = t * 9 + Math.sin(t * 37) * 0.35;
      const n = palette.length;
      const i = ((Math.floor(band) % n) + n) % n;
      const j = (i + 1) % palette.length;
      const f = band - Math.floor(band);
      const k = f * f * (3 - 2 * f);
      const noise = 0.9 + 0.1 * Math.sin(x * 0.7 + y * 1.3) * Math.sin(x * 0.13 - y * 0.4);
      const o = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) img.data[o + ch] = (palette[i][ch] * (1 - k) + palette[j][ch] * k) * noise;
      img.data[o + 3] = 255;
    }
  }
  // A great storm, like Jupiter's red spot.
  c.putImageData(img, 0, 0);
  const g = c.createRadialGradient(330, 150, 0, 330, 150, 26);
  g.addColorStop(0, "rgba(140,40,25,0.9)");
  g.addColorStop(0.6, "rgba(170,70,40,0.5)");
  g.addColorStop(1, "rgba(170,70,40,0)");
  c.fillStyle = g;
  c.save();
  c.translate(330, 150);
  c.scale(1.8, 1);
  c.translate(-330, -150);
  c.fillRect(280, 120, 100, 60);
  c.restore();
  tex.update();
  return tex;
}

function moonTexture(scene: Scene, tint: [number, number, number]) {
  const tex = new DynamicTexture("moonSurface", { width: 128, height: 64 }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.fillStyle = `rgb(${tint.join(",")})`;
  c.fillRect(0, 0, 128, 64);
  for (let i = 0; i < 40; i++) {
    c.fillStyle = `rgba(0,0,0,${0.08 + Math.random() * 0.15})`;
    c.beginPath();
    c.arc(Math.random() * 128, Math.random() * 64, 1 + Math.random() * 6, 0, Math.PI * 2);
    c.fill();
  }
  tex.update();
  return tex;
}

function ringTexture(scene: Scene) {
  const size = 512;
  const tex = new DynamicTexture("planetRing", { width: size, height: size }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.clearRect(0, 0, size, size);
  const mid = size / 2;
  for (let r = mid * 0.62; r < mid * 0.98; r += 1) {
    const t = (r - mid * 0.62) / (mid * 0.36);
    const alpha = (0.25 + 0.5 * Math.abs(Math.sin(t * 23)) * Math.abs(Math.sin(t * 7 + 1))) * Math.sin(t * Math.PI);
    c.strokeStyle = `rgba(${210 - t * 40},${180 - t * 50},${150 - t * 40},${alpha})`;
    c.beginPath();
    c.arc(mid, mid, r, 0, Math.PI * 2);
    c.stroke();
  }
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

/**
 * The backdrop: a smoggy sky dome and a ringed gas giant with two moons hanging over the city.
 * Everything here is pinned to the camera (infinite distance), so it never gets closer.
 */
export class Sky {
  private dome: ShaderMaterial;
  private bodies: ShaderMaterial[] = [];
  /** What hangs in the sky over the city (the gas giant, its rings and moons) and over the Moon (Earth). */
  private earthSky: Mesh[] = [];
  private moonSky: Mesh[] = [];
  private horizon: Color3;
  private makeBody!: (name: string, diameter: number, at: Vector3, surface: DynamicTexture, rim: Color3) => Mesh;

  constructor(scene: Scene, horizon: Color3) {
    this.dome = new ShaderMaterial("sky", scene, "sky", { attributes: ["position"], uniforms: ["worldViewProjection", "zenith", "horizon", "flash", "starFloor"] });
    this.dome.setColor3("zenith", new Color3(0.12, 0.13, 0.19));
    this.dome.setColor3("horizon", horizon);
    this.dome.setFloat("flash", 0);
    this.dome.setFloat("starFloor", 0);
    this.horizon = horizon;
    this.dome.backFaceCulling = false;
    const dome = MeshBuilder.CreateSphere("skyDome", { diameter: 1800, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
    dome.material = this.dome;
    dome.infiniteDistance = true;
    dome.isPickable = false;

    // Light from the side, so the giant shows as a fat crescent.
    const light = new Vector3(-0.9, 0.35, 0.25).normalize();
    const body = (name: string, diameter: number, at: Vector3, surface: DynamicTexture, rim: Color3) => {
      const m = new ShaderMaterial(name, scene, "planet", {
        attributes: ["position", "normal", "uv"],
        uniforms: ["world", "worldViewProjection", "cameraPosition", "lightDir", "rim", "haze", "hazeAmount", "flash"],
        samplers: ["surface"],
      });
      m.setTexture("surface", surface);
      m.setVector3("lightDir", light);
      m.setColor3("rim", rim);
      m.setColor3("haze", horizon);
      m.setFloat("hazeAmount", 1);
      m.setFloat("flash", 0);
      const mesh = MeshBuilder.CreateSphere(name, { diameter, segments: 48 }, scene);
      mesh.material = m;
      mesh.position.copyFrom(at);
      mesh.infiniteDistance = true;
      mesh.isPickable = false;
      this.bodies.push(m);
      return mesh;
    };
    this.makeBody = body;

    const planetAt = new Vector3(0.35, 0.3, 1).normalize().scale(700);
    const planet = body("planet", 340, planetAt, bandsTexture(scene), new Color3(1, 0.62, 0.38));
    this.earthSky.push(planet);
    planet.rotation.set(0.25, 0.4, -0.35);

    const ringMat = new StandardMaterial("planetRing", scene);
    const ringTex = ringTexture(scene);
    ringMat.emissiveTexture = ringTex;
    ringMat.opacityTexture = ringTex;
    ringMat.diffuseColor = Color3.Black();
    ringMat.disableLighting = true;
    ringMat.backFaceCulling = false;
    ringMat.fogEnabled = false;
    ringMat.emissiveColor = new Color3(0.55, 0.45, 0.38);
    const ring = MeshBuilder.CreatePlane("planetRing", { size: 340 * 2.4 }, scene);
    ring.material = ringMat;
    ring.position.copyFrom(planetAt);
    ring.rotation.set(Math.PI / 2 - 0.32, 0.35, -0.3);
    ring.infiniteDistance = true;
    ring.isPickable = false;
    this.earthSky.push(ring);

    this.earthSky.push(
      body("moon1", 34, new Vector3(-0.25, 0.42, 1).normalize().scale(690), moonTexture(scene, [150, 145, 140]), new Color3(0.7, 0.7, 0.8)),
      body("moon2", 18, new Vector3(0.75, 0.22, 1).normalize().scale(690), moonTexture(scene, [170, 120, 95]), new Color3(0.9, 0.6, 0.5)),
    );
    this.scene = scene;
  }

  private scene!: Scene;

  /** Over the city: a smoggy dusk. Over the Moon: a black sky full of stars, with Earth rising. */
  setTheme(theme: "earth" | "moon", horizon: Color3) {
    const moon = theme === "moon";
    if (moon && !this.moonSky.length) {
      const earth = this.makeBody("earth", 230, new Vector3(0.75, 0.24, 0.7).normalize().scale(700), earthTexture(this.scene), new Color3(0.45, 0.7, 1));
      earth.rotation.set(0.3, 0, 0.2);
      this.moonSky.push(earth);
    }
    for (const m of this.earthSky) m.setEnabled(!moon);
    for (const m of this.moonSky) m.setEnabled(moon);
    this.dome.setColor3("zenith", moon ? new Color3(0.005, 0.006, 0.012) : new Color3(0.12, 0.13, 0.19));
    this.dome.setColor3("horizon", horizon);
    this.dome.setFloat("starFloor", moon ? 1 : 0);
    for (const b of this.bodies) {
      b.setColor3("haze", horizon);
      b.setFloat("hazeAmount", moon ? 0.12 : 1); // no air to look through
    }
  }

  /** Lightning lights up the whole sky for a moment; 0..1. */
  setFlash(flash: number) {
    this.dome.setFloat("flash", flash);
    for (const b of this.bodies) b.setFloat("flash", flash);
  }
}
