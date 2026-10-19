import { Color3, Color4, DynamicTexture, Engine, Mesh, MeshBuilder, ParticleSystem, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";

function softDot(scene: Scene) {
  const tex = new DynamicTexture("ashDot", { width: 32, height: 32 }, scene, false);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 32, 32);
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

/** Ash and embers drifting down around the camera, and a lightning storm overhead. */
export class Weather {
  /** Brightness of the current lightning flash, 0..1, for the sky and the lights. */
  flash = 0;
  private ash: ParticleSystem;
  private embers: ParticleSystem;
  private around = Vector3.Zero();
  private nextStrike = 6;
  private bolt: Mesh | null = null;
  private boltT = 0;
  private boltMat: StandardMaterial;
  private thunder: { t: number; dist: number }[] = [];

  constructor(private scene: Scene) {
    const dot = softDot(scene);
    const fall = (name: string, capacity: number, setup: (s: ParticleSystem) => void) => {
      const s = new ParticleSystem(name, capacity, scene);
      s.particleTexture = dot;
      s.emitter = this.around;
      s.updateSpeed = 1 / 60;
      s.minEmitBox = new Vector3(-70, 8, -70);
      s.maxEmitBox = new Vector3(70, 45, 70);
      setup(s);
      s.preWarmCycles = 300;
      s.preWarmStepOffset = 2;
      s.start();
      return s;
    };
    this.ash = fall("ash", 1800, (s) => {
      s.color1 = new Color4(0.62, 0.6, 0.58, 0.75);
      s.color2 = new Color4(0.45, 0.44, 0.43, 0.6);
      s.colorDead = new Color4(0.4, 0.4, 0.4, 0);
      s.minSize = 0.08;
      s.maxSize = 0.2;
      s.minLifeTime = 8;
      s.maxLifeTime = 14;
      s.emitRate = 120;
      s.direction1 = new Vector3(-0.6, -1, -0.3);
      s.direction2 = new Vector3(0.6, -0.6, 0.6);
      s.minEmitPower = 2;
      s.maxEmitPower = 3.5;
      s.minAngularSpeed = -2;
      s.maxAngularSpeed = 2;
      s.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    });
    this.embers = fall("ambientEmbers", 200, (s) => {
      s.color1 = new Color4(1, 0.55, 0.15, 1);
      s.color2 = new Color4(1, 0.35, 0.05, 1);
      s.colorDead = new Color4(0.5, 0.1, 0, 0);
      s.minSize = 0.08;
      s.maxSize = 0.16;
      s.minLifeTime = 6;
      s.maxLifeTime = 10;
      s.emitRate = 10;
      s.direction1 = new Vector3(-1, -0.6, -1);
      s.direction2 = new Vector3(1, -0.2, 1);
      s.minEmitPower = 1;
      s.maxEmitPower = 2.5;
      s.blendMode = ParticleSystem.BLENDMODE_ADD;
    });

    this.boltMat = new StandardMaterial("lightning", scene);
    this.boltMat.emissiveColor = new Color3(0.85, 0.9, 1);
    this.boltMat.diffuseColor = Color3.Black();
    this.boltMat.disableLighting = true;
    this.boltMat.alphaMode = Engine.ALPHA_ADD;
    this.boltMat.fogEnabled = false;
  }

  /** `at` is where the camera is; `onThunder` gets each thunderclap's distance when it arrives. */
  /** No atmosphere, no weather. */
  setEnabled(on: boolean) {
    this.enabled = on;
    for (const s of [this.ash, this.embers]) {
      if (on) s.start();
      else {
        s.stop();
        s.reset();
      }
    }
    this.flash = 0;
    this.thunder.length = 0;
    this.bolt?.dispose();
    this.bolt = null;
  }

  private enabled = true;

  update(dt: number, at: Vector3, onThunder: (dist: number) => void) {
    this.around.copyFrom(at);
    if (!this.enabled) return;
    this.flash = Math.max(0, this.flash - dt * 3.5);

    this.nextStrike -= dt;
    if (this.nextStrike <= 0) {
      this.nextStrike = 8 + Math.random() * 14;
      this.strike(at);
    }
    if (this.bolt) {
      this.boltT += dt;
      // A strike flickers two or three times before it's gone.
      this.bolt.isVisible = Math.sin(this.boltT * 70) > -0.3;
      if (this.boltT > 0.35) {
        this.bolt.dispose();
        this.bolt = null;
      }
    }
    for (let i = this.thunder.length - 1; i >= 0; i--) {
      const th = this.thunder[i];
      th.t -= dt;
      if (th.t > 0) continue;
      this.thunder.splice(i, 1);
      onThunder(th.dist);
    }
  }

  private strike(at: Vector3) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 300;
    const ground = new Vector3(at.x + Math.cos(angle) * dist, 0, at.z + Math.sin(angle) * dist);
    // A jagged path from the clouds down to the ground.
    const path: Vector3[] = [];
    let p = new Vector3(ground.x + (Math.random() - 0.5) * 60, 260, ground.z + (Math.random() - 0.5) * 60);
    while (p.y > 0) {
      path.push(p.clone());
      const t = p.y / 260;
      p = new Vector3(p.x + (ground.x - p.x) * 0.12 + (Math.random() - 0.5) * 18 * t, p.y - 12 - Math.random() * 14, p.z + (ground.z - p.z) * 0.12 + (Math.random() - 0.5) * 18 * t);
    }
    path.push(ground);
    this.bolt?.dispose();
    this.bolt = MeshBuilder.CreateTube("lightning", { path, radius: 0.9, tessellation: 5 }, this.scene);
    this.bolt.material = this.boltMat;
    this.bolt.isPickable = false;
    this.boltT = 0;
    this.flash = Math.min(1, 0.6 + 140 / dist);
    // Sound travels at ~340 m/s, so the thunder comes a little after the flash.
    this.thunder.push({ t: dist / 340, dist });
  }
}
