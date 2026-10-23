import {
  AbstractMesh,
  Color3,
  Color4,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PointLight,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";

interface Blast {
  systems: ParticleSystem[];
  ring: Mesh | null;
  ringMat: StandardMaterial | null;
  scale: number;
  t: number;
  /** Seconds until everything in it is gone (smoke lingers longest). */
  life: number;
}

const SCORCH_MAX = 200;

function texture(scene: Scene, name: string, draw: (c: CanvasRenderingContext2D) => void, size = 64) {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, false);
  draw(tex.getContext() as unknown as CanvasRenderingContext2D);
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

function radial(c: CanvasRenderingContext2D, stops: [number, string][]) {
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [at, color] of stops) g.addColorStop(at, color);
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
}

/** A soft, lumpy cloud of overlapping blobs: fire and smoke billow instead of looking like dots. */
function puff(c: CanvasRenderingContext2D) {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 10; i++) {
    const x = 64 + (rand() - 0.5) * 44, y = 64 + (rand() - 0.5) * 44, r = 22 + rand() * 20;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(0.6, "rgba(255,255,255,0.25)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
  // Fade it all out towards the edges, so the square never shows.
  c.globalCompositeOperation = "destination-in";
  const edge = c.createRadialGradient(64, 64, 30, 64, 64, 64);
  edge.addColorStop(0, "rgba(0,0,0,1)");
  edge.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = edge;
  c.fillRect(0, 0, 128, 128);
  c.globalCompositeOperation = "source-over";
}

export class Fx {
  /** Called for every explosion, so the game can add debris, a screen flash and so on. */
  onExplosion: ((at: Vector3, scale: number) => void) | null = null;
  private flare: DynamicTexture;
  private puffTex: DynamicTexture;
  private light: PointLight;
  private pending: { at: Vector3; scale: number; t: number }[] = [];
  private chunk: DynamicTexture;
  private sparks: ParticleSystem;
  private flashes: ParticleSystem;
  private puffs: ParticleSystem;
  private casings: ParticleSystem;
  /** Small fireballs for plasma hits: one long-lived system, so the boss's volleys cost nothing to set up. */
  private pops!: ParticleSystem;
  private blasts: Blast[] = [];
  private retired: { systems: ParticleSystem[]; t: number }[] = [];
  private scorchMesh: Mesh;
  private scorchNext = 0;
  private scorchSpots: (Vector3 | null)[] = new Array(SCORCH_MAX).fill(null);

  constructor(private scene: Scene) {
    this.flare = texture(scene, "flare", (c) => radial(c, [[0, "rgba(255,255,255,1)"], [0.4, "rgba(255,255,255,0.6)"], [1, "rgba(255,255,255,0)"]]));
    this.puffTex = texture(scene, "puff", puff, 128);
    this.pops = this.makeSystem("pops", 900, this.puffTex, (s) => {
      s.createSphereEmitter(0.6);
      s.addColorGradient(0, new Color4(1, 0.85, 0.5, 0.9));
      s.addColorGradient(0.3, new Color4(1, 0.45, 0.12, 0.7));
      s.addColorGradient(1, new Color4(0.25, 0.06, 0.02, 0));
      s.minSize = 1.2;
      s.maxSize = 2.6;
      s.minLifeTime = 0.25;
      s.maxLifeTime = 0.55;
      s.minEmitPower = 2;
      s.maxEmitPower = 6;
      s.minInitialRotation = 0;
      s.maxInitialRotation = Math.PI * 2;
      s.gravity = new Vector3(0, 3, 0);
      s.blendMode = ParticleSystem.BLENDMODE_ADD;
    });
    // One light shared by all blasts: lights stay in the shaders, only its intensity changes.
    this.light = new PointLight("blastLight", Vector3.Zero(), scene);
    this.light.diffuse = new Color3(1, 0.62, 0.3);
    this.light.specular = Color3.Black();
    this.light.intensity = 0;
    this.chunk = texture(scene, "chunk", (c) => {
      c.fillStyle = "#fff";
      c.fillRect(8, 16, 48, 32);
    });

    // Long-lived systems for small, frequent effects; each event asks for a burst.
    this.sparks = this.makeSystem("sparks", 1500, this.flare, (s) => {
      s.createSphereEmitter(0.2);
      s.color1 = new Color4(1, 0.9, 0.5, 1);
      s.color2 = new Color4(1, 0.6, 0.2, 1);
      s.colorDead = new Color4(1, 0.3, 0, 0);
      s.minSize = 0.1;
      s.maxSize = 0.28;
      s.minLifeTime = 0.15;
      s.maxLifeTime = 0.45;
      s.minEmitPower = 6;
      s.maxEmitPower = 16;
      s.gravity = new Vector3(0, -25, 0);
      s.blendMode = ParticleSystem.BLENDMODE_ADD;
    });
    this.flashes = this.makeSystem("impactFlash", 100, this.flare, (s) => {
      s.color1 = s.color2 = new Color4(1, 0.85, 0.6, 1);
      s.colorDead = new Color4(1, 0.5, 0.2, 0);
      s.minSize = 1.2;
      s.maxSize = 2.0;
      s.minLifeTime = s.maxLifeTime = 0.07;
      s.minEmitPower = s.maxEmitPower = 0;
      s.blendMode = ParticleSystem.BLENDMODE_ADD;
    });
    this.puffs = this.makeSystem("puffs", 400, this.flare, (s) => {
      s.createSphereEmitter(0.3);
      s.color1 = new Color4(0.55, 0.55, 0.55, 0.5);
      s.color2 = new Color4(0.4, 0.4, 0.4, 0.4);
      s.colorDead = new Color4(0.3, 0.3, 0.3, 0);
      s.minSize = 0.6;
      s.maxSize = 1.4;
      s.minLifeTime = 0.4;
      s.maxLifeTime = 0.9;
      s.minEmitPower = 0.5;
      s.maxEmitPower = 2;
      s.gravity = new Vector3(0, 1.5, 0);
      s.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    });
    this.casings = this.makeSystem("casings", 300, this.chunk, (s) => {
      s.color1 = s.color2 = new Color4(0.95, 0.75, 0.3, 1);
      s.colorDead = new Color4(0.7, 0.5, 0.2, 1);
      s.minSize = 0.09;
      s.maxSize = 0.13;
      s.minLifeTime = 0.6;
      s.maxLifeTime = 0.9;
      s.minEmitPower = 1;
      s.maxEmitPower = 1;
      s.minAngularSpeed = -15;
      s.maxAngularSpeed = 15;
      s.gravity = new Vector3(0, -25, 0);
      s.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    });

    // Scorch marks: a ring buffer of thin instances on walls and the ground.
    const scorchMat = new StandardMaterial("scorch", scene);
    scorchMat.diffuseColor = Color3.Black();
    scorchMat.specularColor = Color3.Black();
    scorchMat.opacityTexture = texture(scene, "scorchTex", (c) =>
      radial(c, [[0, "rgba(0,0,0,0.85)"], [0.5, "rgba(0,0,0,0.5)"], [1, "rgba(0,0,0,0)"]]),
    );
    scorchMat.zOffset = -2;
    scorchMat.backFaceCulling = false;
    this.scorchMesh = MeshBuilder.CreatePlane("scorch", { size: 1 }, scene);
    this.scorchMesh.material = scorchMat;
    this.scorchMesh.isPickable = false;
    this.scorchMesh.alwaysSelectAsActiveMesh = true;
    const hidden = new Float32Array(SCORCH_MAX * 16);
    for (let i = 0; i < SCORCH_MAX; i++) Matrix.Scaling(0, 0, 0).copyToArray(hidden, i * 16);
    this.scorchMesh.thinInstanceSetBuffer("matrix", hidden, 16, false);
  }

  private makeSystem(name: string, capacity: number, tex: DynamicTexture, setup: (s: ParticleSystem) => void) {
    const ps = new ParticleSystem(name, capacity, this.scene);
    ps.particleTexture = tex;
    ps.emitter = Vector3.Zero();
    ps.updateSpeed = 1 / 60; // lifetimes in seconds, powers in units per second
    ps.emitRate = 0;
    setup(ps);
    ps.start();
    return ps;
  }

  /** A flamethrower's stream: the caller aims it (emitter, directions) and turns it on (emitRate). */
  flamer() {
    return this.makeSystem("flamer", 400, this.puffTex, (s) => {
      s.addColorGradient(0, new Color4(1, 0.9, 0.55, 0.95));
      s.addColorGradient(0.35, new Color4(1, 0.45, 0.1, 0.8));
      s.addColorGradient(1, new Color4(0.2, 0.08, 0.05, 0));
      s.addSizeGradient(0, 0.4);
      s.addSizeGradient(1, 3.2);
      s.minLifeTime = 0.3;
      s.maxLifeTime = 0.45;
      s.minEmitPower = 52;
      s.maxEmitPower = 64;
      s.blendMode = ParticleSystem.BLENDMODE_ADD;
    });
  }

  /** A cloud of dust rolling out of a collapsing building's footprint. */
  dustCloud(at: Vector3, w: number, d: number) {
    const dust = this.makeSystem("collapseDust", 700, this.flare, (s) => {
      s.emitter = at.clone();
      s.minEmitBox = new Vector3(-w / 2 - 1, 0, -d / 2 - 1);
      s.maxEmitBox = new Vector3(w / 2 + 1, 4, d / 2 + 1);
      s.direction1 = new Vector3(-7, 1, -7);
      s.direction2 = new Vector3(7, 7, 7);
      s.color1 = new Color4(0.62, 0.58, 0.52, 0.55);
      s.color2 = new Color4(0.5, 0.48, 0.44, 0.45);
      s.colorDead = new Color4(0.45, 0.43, 0.4, 0);
      s.minSize = 4;
      s.maxSize = 10;
      s.minLifeTime = 2;
      s.maxLifeTime = 4.5;
      s.minEmitPower = 0.5;
      s.maxEmitPower = 2;
      s.emitRate = 120 + w * d * 0.2;
      s.gravity = new Vector3(0, 0.5, 0);
      s.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    });
    this.retired.push({ systems: [dust], t: -6 });
    setTimeout(() => dust.stop(), 1800);
  }

  /** The soft, lumpy cloud texture, for other long-lived fire and smoke. */
  get puffTexture() {
    return this.puffTex;
  }

  /** A shockwave along the ground: a ring of dust rushing out to `radius`, sparks and a crater. */
  slam(at: Vector3, radius: number) {
    const ground = new Vector3(at.x, 0.4, at.z);
    const k = radius / 12;
    const dust = this.oneShot("slamDust", 120, ground, this.puffTex, (s) => {
      s.direction1 = new Vector3(-1, 0.02, -1);
      s.direction2 = new Vector3(1, 0.15, 1);
      s.addColorGradient(0, new Color4(0.5, 0.46, 0.42, 0.75));
      s.addColorGradient(1, new Color4(0.5, 0.48, 0.45, 0));
      s.minSize = 2.5 * k;
      s.maxSize = 5 * k;
      s.minLifeTime = 0.7;
      s.maxLifeTime = 1.3;
      s.minEmitPower = radius * 1.4;
      s.maxEmitPower = radius * 2;
      s.minInitialRotation = 0;
      s.maxInitialRotation = Math.PI * 2;
      s.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      s.manualEmitCount = 100;
    });
    const ringMat = new StandardMaterial("slamRing", this.scene);
    ringMat.emissiveColor = new Color3(1, 0.7, 0.4);
    ringMat.diffuseColor = Color3.Black();
    ringMat.disableLighting = true;
    const ring = MeshBuilder.CreateTorus("slamRing", { diameter: 1, thickness: 0.08, tessellation: 40 }, this.scene);
    ring.material = ringMat;
    ring.position.copyFrom(ground);
    ring.isPickable = false;
    // The ring code grows to (1 + 16) × scale over 0.35 s.
    this.blasts.push({ systems: [dust], ring, ringMat, scale: (radius * 2) / 17, t: 0, life: 2 });
    this.spark(ground, 50);
    this.scorch(new Vector3(at.x, 0.02, at.z), new Vector3(0, 1, 0), radius * 0.6);
    this.light.position.copyFrom(ground).addInPlaceFromFloats(0, 2, 0);
    this.light.range = radius * 2;
    this.light.intensity = Math.max(this.light.intensity, 3);
  }

  /** A plasma ball bursting: a quick fireball, sparks and a flash, from the shared systems. */
  pop(at: Vector3) {
    this.burst(this.pops, at, 14);
    this.burst(this.sparks, at, 14);
    this.burst(this.flashes, at, 1);
    this.burst(this.puffs, at, 2);
  }

  /** A puff of dust kicked up from the ground. */
  dust(at: Vector3, count: number) {
    this.burst(this.puffs, at, count);
  }

  /** Jet flame pointing down from a moving point (the emitter vector is updated by the owner). */
  jet() {
    return this.makeSystem("jet", 300, this.flare, (s) => {
      s.createPointEmitter(new Vector3(-0.15, -1, -0.15), new Vector3(0.15, -1, 0.15));
      s.color1 = new Color4(1, 0.65, 0.25, 0.7);
      s.color2 = new Color4(0.35, 0.65, 1, 0.6);
      s.colorDead = new Color4(1, 0.25, 0.05, 0);
      s.minSize = 0.2;
      s.maxSize = 0.55;
      s.minLifeTime = 0.08;
      s.maxLifeTime = 0.22;
      s.minEmitPower = 10;
      s.maxEmitPower = 18;
      s.blendMode = ParticleSystem.BLENDMODE_ADD;
    });
  }

  private burst(ps: ParticleSystem, at: Vector3, count: number) {
    (ps.emitter as Vector3).copyFrom(at);
    ps.manualEmitCount = Math.max(0, ps.manualEmitCount) + count;
  }

  spark(at: Vector3, count: number) {
    this.burst(this.sparks, at, count);
  }

  /** A round hitting something: flash, sparks, a puff of dust and (on walls) a scorch mark. */
  impact(at: Vector3, normal: Vector3 | null, scorch = true) {
    this.burst(this.flashes, at, 1);
    this.burst(this.sparks, at, 12);
    this.burst(this.puffs, at, 2);
    if (normal && scorch) this.scorch(at, normal, 0.6 + Math.random() * 0.5);
  }

  scorch(at: Vector3, normal: Vector3, size: number) {
    // Plane faces Z; turn Z towards the surface normal.
    const align =
      Math.abs(normal.y) > 0.5
        ? Matrix.RotationX(normal.y > 0 ? -Math.PI / 2 : Math.PI / 2)
        : Matrix.RotationY(Math.atan2(normal.x, normal.z));
    const m = Matrix.Scaling(size, size, size)
      .multiply(Matrix.RotationZ(Math.random() * Math.PI * 2))
      .multiply(align)
      .multiply(Matrix.Translation(at.x + normal.x * 0.03, at.y + normal.y * 0.03, at.z + normal.z * 0.03));
    this.scorchMesh.thinInstanceSetMatrixAt(this.scorchNext, m, true);
    this.scorchSpots[this.scorchNext] = at.clone();
    this.scorchNext = (this.scorchNext + 1) % SCORCH_MAX;
  }

  /** Wipes the scorch marks within an area above the ground (a fallen building's walls), or all of them. */
  clearScorch(area?: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    this.scorchSpots.forEach((p, i) => {
      if (!p) return;
      if (area && (p.y < 0.2 || p.x < area.minX - 0.2 || p.x > area.maxX + 0.2 || p.z < area.minZ - 0.2 || p.z > area.maxZ + 0.2)) return;
      this.scorchMesh.thinInstanceSetMatrixAt(i, Matrix.Scaling(0, 0, 0), true);
      this.scorchSpots[i] = null;
    });
  }

  /** Spent shell flying out sideways from a cannon. */
  casing(at: Vector3, right: Vector3) {
    const s = this.casings;
    s.direction1 = new Vector3(right.x * 3, 3, right.z * 3);
    s.direction2 = new Vector3(right.x * 5 + 1, 5, right.z * 5 + 1);
    this.burst(s, at, 1);
  }

  /** `heavy`: a boss missile's trail, bigger and redder but with fewer particles. */
  rocketTrail(emitter: AbstractMesh, heavy = false) {
    const smoke = new ParticleSystem("rocketSmoke", heavy ? 110 : 300, this.scene);
    smoke.particleTexture = this.flare;
    smoke.emitter = emitter;
    smoke.updateSpeed = 1 / 60;
    smoke.emitRate = heavy ? 70 : 140;
    smoke.createSphereEmitter(0.15);
    smoke.color1 = new Color4(0.8, 0.8, 0.8, 0.5);
    smoke.color2 = new Color4(0.6, 0.6, 0.6, 0.4);
    smoke.colorDead = new Color4(0.4, 0.4, 0.4, 0);
    smoke.minSize = heavy ? 1.2 : 0.5;
    smoke.maxSize = heavy ? 2.4 : 1.1;
    smoke.minLifeTime = heavy ? 0.6 : 0.5;
    smoke.maxLifeTime = heavy ? 1.4 : 1.1;
    if (heavy) {
      smoke.color1 = new Color4(0.35, 0.33, 0.32, 0.6);
      smoke.color2 = new Color4(0.25, 0.24, 0.24, 0.5);
    }
    smoke.minEmitPower = 0.3;
    smoke.maxEmitPower = 1;
    smoke.blendMode = ParticleSystem.BLENDMODE_STANDARD;

    const fire = new ParticleSystem("rocketFire", heavy ? 60 : 150, this.scene);
    fire.particleTexture = this.flare;
    fire.emitter = emitter;
    fire.updateSpeed = 1 / 60;
    fire.emitRate = heavy ? 90 : 120;
    fire.createPointEmitter(new Vector3(0, 0, -1), new Vector3(0, 0, -1));
    fire.isLocal = false;
    fire.color1 = new Color4(1, 0.85, 0.4, 1);
    fire.color2 = new Color4(1, 0.5, 0.15, 1);
    fire.colorDead = new Color4(1, 0.2, 0, 0);
    fire.minSize = heavy ? 0.9 : 0.3;
    fire.maxSize = heavy ? 1.6 : 0.6;
    if (heavy) {
      fire.color1 = new Color4(1, 0.45, 0.2, 1);
      fire.color2 = new Color4(1, 0.15, 0.05, 1);
    }
    fire.minLifeTime = 0.05;
    fire.maxLifeTime = 0.12;
    fire.minEmitPower = 4;
    fire.maxEmitPower = 8;
    fire.blendMode = ParticleSystem.BLENDMODE_ADD;

    smoke.start();
    fire.start();
    return [smoke, fire];
  }

  /** Stops emitting (pinned at `at`, if given) and disposes once the remaining particles have faded. */
  retire(systems: ParticleSystem[], at: Vector3 | null, fadeTime = 1.5) {
    for (const s of systems) {
      if (at) s.emitter = at.clone();
      s.stop();
    }
    this.retired.push({ systems, t: -fadeTime });
  }

  private oneShot(name: string, capacity: number, at: Vector3, tex: DynamicTexture, setup: (s: ParticleSystem) => void) {
    const ps = new ParticleSystem(name, capacity, this.scene);
    ps.particleTexture = tex;
    ps.emitter = at.clone();
    ps.updateSpeed = 1 / 60;
    ps.emitRate = 0;
    setup(ps);
    ps.start();
    return ps;
  }

  /** `cheap`: no dust skirt, shock ring, flying scrap or follow-up blasts (for the many boss missiles). */
  explosion(at: Vector3, scale = 1, cheap = false) {
    const n = (k: number) => Math.max(4, Math.round(k * scale));
    const nearGround = at.y < 3 * scale;

    // A white-hot flash, gone in a blink.
    const flash = this.oneShot("blastFlash", 4, at, this.flare, (s) => {
      s.color1 = s.color2 = new Color4(1, 0.95, 0.8, 1);
      s.colorDead = new Color4(1, 0.6, 0.2, 0);
      s.minSize = 3.5 * scale;
      s.maxSize = 5.5 * scale;
      s.minLifeTime = s.maxLifeTime = 0.12;
      s.minEmitPower = s.maxEmitPower = 0;
      s.blendMode = ParticleSystem.BLENDMODE_ADD;
      s.manualEmitCount = 3;
    });

    // The fireball: billowing puffs going from white through orange to dark red.
    const fire = this.oneShot("fireball", n(60), at, this.puffTex, (s) => {
      s.createSphereEmitter(0.8 * scale);
      // Kept below full alpha: added on top of each other, the puffs would burn out to white.
      s.addColorGradient(0, new Color4(1, 0.8, 0.4, 0.85));
      s.addColorGradient(0.15, new Color4(1, 0.5, 0.12, 0.7));
      s.addColorGradient(0.5, new Color4(0.75, 0.2, 0.04, 0.45));
      s.addColorGradient(1, new Color4(0.2, 0.05, 0.02, 0));
      s.minSize = 2 * scale;
      s.maxSize = 4.5 * scale;
      s.minLifeTime = 0.45;
      s.maxLifeTime = 1;
      s.minEmitPower = 3 * scale;
      s.maxEmitPower = 9 * scale;
      s.minInitialRotation = 0;
      s.maxInitialRotation = Math.PI * 2;
      s.minAngularSpeed = -2;
      s.maxAngularSpeed = 2;
      s.gravity = new Vector3(0, 4, 0);
      s.blendMode = ParticleSystem.BLENDMODE_ADD;
      s.manualEmitCount = n(45);
    });

    // A column of dark smoke rolling up after the fire.
    const smoke = cheap ? null : this.oneShot("blastSmoke", n(40), at, this.puffTex, (s) => {
      s.startDelay = 120;
      s.createSphereEmitter(1 * scale);
      s.addColorGradient(0, new Color4(0.22, 0.2, 0.18, 0));
      s.addColorGradient(0.1, new Color4(0.2, 0.18, 0.17, 0.8));
      s.addColorGradient(0.6, new Color4(0.3, 0.29, 0.28, 0.5));
      s.addColorGradient(1, new Color4(0.4, 0.4, 0.4, 0));
      s.minSize = 3 * scale;
      s.maxSize = 7 * scale;
      s.minLifeTime = 2.5;
      s.maxLifeTime = 4.5;
      s.minEmitPower = 1 * scale;
      s.maxEmitPower = 3 * scale;
      s.minInitialRotation = 0;
      s.maxInitialRotation = Math.PI * 2;
      s.minAngularSpeed = -0.8;
      s.maxAngularSpeed = 0.8;
      s.gravity = new Vector3(0, 2.5, 0);
      s.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      s.manualEmitCount = cheap ? n(12) : n(30);
    });

    // Burning embers that streak out and fall.
    const embers = this.oneShot("embers", n(80), at, this.flare, (s) => {
      s.createSphereEmitter(0.5 * scale);
      s.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      s.addColorGradient(0, new Color4(1, 0.9, 0.5, 1));
      s.addColorGradient(0.5, new Color4(1, 0.45, 0.1, 1));
      s.addColorGradient(1, new Color4(0.6, 0.1, 0, 0));
      s.minSize = 0.12;
      s.maxSize = 0.3;
      s.minScaleY = 2;
      s.maxScaleY = 4;
      s.minLifeTime = 0.6;
      s.maxLifeTime = 1.8;
      s.minEmitPower = 14 * Math.sqrt(scale);
      s.maxEmitPower = 32 * Math.sqrt(scale);
      s.gravity = new Vector3(0, -14, 0);
      s.blendMode = ParticleSystem.BLENDMODE_ADD;
      s.manualEmitCount = cheap ? n(25) : n(60);
    });

    const systems = [flash, fire, embers, ...(smoke ? [smoke] : [])];
    if (nearGround && !cheap) {
      // A skirt of dust rushing out along the ground, and a scorched crater.
      const ground = new Vector3(at.x, 0.4, at.z);
      systems.push(
        this.oneShot("dustRing", n(40), ground, this.puffTex, (s) => {
          s.direction1 = new Vector3(-1, 0.05, -1);
          s.direction2 = new Vector3(1, 0.25, 1);
          s.addColorGradient(0, new Color4(0.55, 0.5, 0.44, 0.6));
          s.addColorGradient(1, new Color4(0.55, 0.52, 0.48, 0));
          s.minSize = 2 * scale;
          s.maxSize = 4.5 * scale;
          s.minLifeTime = 0.8;
          s.maxLifeTime = 1.6;
          s.minEmitPower = 10 * scale;
          s.maxEmitPower = 18 * scale;
          s.minInitialRotation = 0;
          s.maxInitialRotation = Math.PI * 2;
          s.blendMode = ParticleSystem.BLENDMODE_STANDARD;
          s.manualEmitCount = n(36);
        }),
      );
      this.scorch(new Vector3(at.x, 0.02, at.z), new Vector3(0, 1, 0), 3.5 * scale);
    }
    this.spark(at, n(40));

    let ring: Mesh | null = null, ringMat: StandardMaterial | null = null;
    if (!cheap) {
      ringMat = new StandardMaterial("shockwave", this.scene);
      ringMat.emissiveColor = new Color3(1, 0.8, 0.5);
      ringMat.diffuseColor = Color3.Black();
      ringMat.disableLighting = true;
      ring = MeshBuilder.CreateTorus("shockwave", { diameter: 1, thickness: 0.05, tessellation: 32 }, this.scene);
      ring.material = ringMat;
      ring.position.copyFrom(at);
      ring.isPickable = false;
    }
    this.blasts.push({ systems, ring, ringMat, scale, t: 0, life: cheap ? 2 : 5 });

    this.light.position.copyFrom(at).addInPlaceFromFloats(0, 1.5, 0);
    this.light.range = 35 * scale;
    this.light.intensity = Math.max(this.light.intensity, 7 * Math.min(scale, 2));

    // Big ones go off in a stutter of smaller blasts around them.
    if (scale >= 1.4 && !cheap) {
      for (const delay of [0.12, 0.3]) {
        const off = new Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).scale(3 * scale);
        this.pending.push({ at: at.add(off), scale: scale * 0.45, t: delay });
      }
    }
    if (!cheap) this.onExplosion?.(at, scale);
  }

  update(dt: number) {
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.t += dt;
      const r = Math.min(1, b.t / 0.35);
      if (b.ring && b.ringMat) {
        b.ring.scaling.set((1 + r * 16) * b.scale, 1, (1 + r * 16) * b.scale);
        b.ringMat.alpha = 0.7 * (1 - r);
        b.ring.isVisible = r < 1;
      }
      if (b.t > b.life) {
        for (const s of b.systems) s.dispose(false); // keep the shared textures
        b.ring?.dispose();
        b.ringMat?.dispose();
        this.blasts.splice(i, 1);
      }
    }
    this.light.intensity *= Math.exp(-dt * 7);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.t -= dt;
      if (p.t > 0) continue;
      this.pending.splice(i, 1);
      this.explosion(p.at, p.scale);
    }
    for (let i = this.retired.length - 1; i >= 0; i--) {
      const r = this.retired[i];
      r.t += dt;
      if (r.t < 0) continue;
      for (const s of r.systems) s.dispose(false);
      this.retired.splice(i, 1);
    }
  }
}

