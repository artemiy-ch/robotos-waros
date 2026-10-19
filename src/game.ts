import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  GlowLayer,
  HemisphericLight,
  Scene,
  ShadowGenerator,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import { BLOCKS, City, crossing, type Theme } from "./city";
import { CrashSite } from "./crash";
import { Destruction } from "./destruction";
import { skyEnvironment } from "./environment";
import { Enemies, type Enemy } from "./enemies";
import { Fx } from "./fx";
import { Hud } from "./hud";
import { Input } from "./input";
import { Loot } from "./loot";
import { Models } from "./models";
import { Pickups } from "./pickups";
import { Props } from "./props";
import { Player } from "./player";
import { Projectiles } from "./projectiles";
import { Sfx } from "./sfx";
import { Sky } from "./sky";
import { offer, type Upgrade } from "./upgrades";
import { Weather } from "./weather";
import { LaserBeam, Lightning } from "./weapons";

type State = "loading" | "menu" | "playing" | "paused" | "dead" | "won";

const BULLET_SPEED = 170;
const HEMI_INTENSITY = 0.62;
/** Damage per second of each of the two beams (the cannons do about 14 together). */
const LASER_DPS = 16;
const LASER_RANGE = 220;
/** Landing faster than this (a fall of about 9 units, or any dive) sends out a shockwave. */
const SLAM_SPEED = 22;
const BOSS_EVERY = 5;
/** First wave of a new game; for testing, ?wave=N in the address starts further on. */
const START_WAVE = Number(new URLSearchParams(location.search).get("wave")) || 1;
/** The flagship comes on this wave; bring it down and the game is won. */
const FINAL_WAVE = 15;
/** Falls from higher than this hurt; from FALL_FATAL and up they cost the most (FALL_MAX of full health). */
const FALL_SAFE = 15;
const FALL_FATAL = 60;
const FALL_MAX = 0.2;
/** The tesla gun: a zap every TESLA_INTERVAL s at whatever is nearest the crosshair, jumping on to others nearby. */
const TESLA_INTERVAL = 0.1;
const TESLA_DAMAGE = 3.4;
const TESLA_RANGE = 70;
const TESLA_CONE = Math.cos(0.3);
const TESLA_JUMPS = 3;
const TESLA_CHAIN = 18;
/** Seconds of the fade to black and back when the battle moves to the Moon. */
const WARP_TIME = 2.6;

interface Look {
  sky: Color3;
  fog: number;
  hemi: number;
  hemiColor: Color3;
  hemiGround: Color3;
  sun: number;
  sunColor: Color3;
  shadow: number;
  gravity: number;
}
const LOOKS: Record<Theme, Look> = {
  // Overcast, smoggy dusk.
  earth: {
    sky: new Color3(0.34, 0.37, 0.42), fog: 0.0058, hemi: 0.62, hemiColor: new Color3(0.72, 0.78, 0.88), hemiGround: new Color3(0.16, 0.16, 0.18),
    sun: 0.95, sunColor: new Color3(1, 0.78, 0.6), shadow: 0.2, gravity: 1,
  },
  // No air: black sky, hard white sunlight, deep shadows, low gravity.
  moon: {
    sky: new Color3(0.045, 0.05, 0.065), fog: 0.0026, hemi: 0.4, hemiColor: new Color3(0.6, 0.66, 0.8), hemiGround: new Color3(0.1, 0.1, 0.11),
    sun: 1.4, sunColor: new Color3(1, 0.98, 0.94), shadow: 0.04, gravity: 0.55,
  },
};

export class Game {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: UniversalCamera;
  readonly city: City;
  readonly fx: Fx;
  readonly sfx = new Sfx();
  readonly hud: Hud;
  readonly input: Input;
  readonly projectiles: Projectiles;
  pickups!: Pickups;
  props!: Props;
  loot!: Loot;
  private beams: LaserBeam[];
  private lightning: Lightning;
  private teslaT = 0;
  private teslaGun = 0;
  private hemiBase = HEMI_INTENSITY;
  /** Seconds into the move to the Moon, or -1. */
  private warp = -1;
  private sky: Sky;
  private weather: Weather;
  private crash: CrashSite | null = null;
  private hemi: HemisphericLight;
  private scorchT = 0;
  readonly destruction: Destruction;
  player!: Player;
  enemies!: Enemies;

  state: State = "loading";
  score = 0;
  wave = 0;
  private sun: DirectionalLight;
  private shadows: ShadowGenerator;
  private models: Models;
  private shake = 0;
  private waveTimer = -1;
  /** Upgrades on offer after a cleared wave, and the last wave that has had its offer. */
  private upgradeOffer: Upgrade[] | null = null;
  private offeredFor = 0;
  private navTimer = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { stencil: true });
    const scene = (this.scene = new Scene(this.engine));
    // Overcast, smoggy dusk.
    const sky = new Color3(0.34, 0.37, 0.42);
    scene.clearColor = new Color4(sky.r, sky.g, sky.b, 1);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.0058;
    scene.fogColor = sky;
    skyEnvironment(scene, sky);
    this.sky = new Sky(scene, sky);
    this.weather = new Weather(scene);
    // Input is handled by ./input; Babylon's own pointer handling would cancel the mouse events.
    scene.detachControl();

    const hemi = (this.hemi = new HemisphericLight("hemi", new Vector3(0.3, 1, 0.2), scene));
    hemi.intensity = HEMI_INTENSITY;
    hemi.diffuse = new Color3(0.72, 0.78, 0.88);
    hemi.groundColor = new Color3(0.16, 0.16, 0.18);

    // The sun's shadow frustum follows the player, so a 2k map stays sharp around the action.
    this.sun = new DirectionalLight("sun", new Vector3(-0.45, -1, -0.3).normalize(), scene);
    this.sun.intensity = 0.95;
    this.sun.diffuse = new Color3(1, 0.78, 0.6);
    this.sun.autoUpdateExtends = false;
    this.sun.shadowFrustumSize = 160;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 600;
    const shadows = (this.shadows = new ShadowGenerator(2048, this.sun));
    shadows.usePercentageCloserFiltering = true;
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    shadows.bias = 0.002;
    shadows.normalBias = 0.02;
    shadows.darkness = 0.2;

    this.camera = new UniversalCamera("cam", new Vector3(0, 5, -10), scene);
    this.camera.fov = 0.95;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 1200;
    this.camera.inputs.clear();

    const glow = new GlowLayer("glow", scene, { blurKernelSize: 32, mainTextureRatio: 0.5 });
    glow.intensity = 0.8;

    this.city = new City(scene, shadows);
    this.projectiles = new Projectiles(scene);
    this.fx = new Fx(scene);
    this.hud = new Hud(this.city);
    this.input = new Input(canvas, (locked) => this.onLockChange(locked));
    this.destruction = new Destruction(scene, this.city, shadows);
    this.beams = [new LaserBeam(scene), new LaserBeam(scene)];
    this.lightning = new Lightning(scene);
    this.models = new Models(scene, shadows);
    this.hud.onOverlayClick(() => this.onOverlayClick());
    this.fx.onExplosion = (at, scale) => {
      this.destruction.scrap(at, scale);
      const dist = Vector3.Distance(at, this.player?.pos ?? at);
      this.hud.flash(Math.max(0, 0.6 - dist / 90) * Math.min(scale, 2));
    };
    this.hud.showOverlay("ROBOT WARS", "Загрузка…");
    window.addEventListener("resize", () => this.engine.resize());

    void this.init();
  }

  private async init() {
    await this.models.load();
    this.player = new Player(this.models, this.scene, this.shadows, this.fx);
    this.enemies = new Enemies(this.scene, this.shadows, this.models);
    this.pickups = new Pickups(this.models);
    this.props = new Props(this.models, this.city);
    this.loot = new Loot(this.scene, this.models, this.city);
    this.crash = new CrashSite(this.scene, this.models, this.city, this.fx);
    this.reset();
    this.state = "menu";
    this.hud.showOverlay("ROBOT WARS", "Город захвачен роботами. Кликни, чтобы начать");
    this.engine.runRenderLoop(() => this.frame());
  }

  /** Repaints the whole world: city, sky, light, fog and gravity. */
  private applyTheme(theme: Theme) {
    const look = LOOKS[theme];
    const scene = this.scene;
    this.city.setTheme(theme);
    this.sky.setTheme(theme, look.sky);
    this.weather.setEnabled(theme === "earth");
    scene.clearColor = new Color4(look.sky.r, look.sky.g, look.sky.b, 1);
    scene.fogColor = look.sky;
    scene.fogDensity = look.fog;
    scene.environmentTexture?.dispose();
    skyEnvironment(scene, look.sky);
    this.hemiBase = look.hemi;
    this.hemi.diffuse = look.hemiColor;
    this.hemi.groundColor = look.hemiGround;
    this.sun.intensity = look.sun;
    this.sun.diffuse = look.sunColor;
    this.shadows.darkness = look.shadow;
    this.player.gravity = look.gravity;
  }

  private reset() {
    // Starting past the first boss (when testing) means starting on the Moon.
    this.applyTheme(START_WAVE > BOSS_EVERY ? "moon" : "earth");
    this.warp = -1;
    this.hud.fade(0);
    this.enemies.clear();
    this.projectiles.clear();
    this.pickups.clear();
    this.fx.clearScorch();
    this.destruction.clear();
    this.city.restore();
    this.props.reset();
    this.loot.reset();
    this.player.respawn(crossing(BLOCKS / 2, BLOCKS / 2));
    this.score = 0;
    this.wave = START_WAVE - 1;
    this.waveTimer = -1;
    this.navTimer = 0;
    this.upgradeOffer = null;
    this.offeredFor = START_WAVE - 1; // no upgrade for the waves skipped
    this.hud.hideUpgrades();
  }

  private onOverlayClick() {
    if (this.state === "loading") return;
    this.sfx.unlock();
    if (this.state === "dead" || this.state === "won") this.reset();
    this.input.lock();
  }

  private onLockChange(locked: boolean) {
    if (locked && this.state !== "loading") {
      this.state = "playing";
      this.hud.hideOverlay();
    } else if (!locked && this.state === "playing") {
      this.state = "paused";
      this.sfx.jet(0);
      this.sfx.laser(false);
      this.sfx.tesla(false);
      this.hud.showOverlay("Пауза", "Кликни, чтобы продолжить");
    }
  }

  /** Point under the crosshair: the first building, ground or enemy straight ahead of the camera. */
  private aimPoint() {
    const o = this.camera.position, d = this.player.look();
    const t = this.enemies.raycast(o, d, this.city.raycast(o, d, 400));
    return o.add(d.scale(t));
  }

  private frame() {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    this.scene.animationsEnabled = this.state !== "paused";
    if (this.state === "playing") this.update(dt);
    else if (this.state !== "paused") {
      this.input.consumeLook();
      if (this.state === "menu") this.player.yaw += dt * 0.15;
      else this.updateWorld(dt);
      const p = this.player.pos;
      const ahead = new Vector3(p.x + Math.sin(this.player.facing) * 30, 3, p.z + Math.cos(this.player.facing) * 30);
      this.player.pose(dt, ahead, false);
      this.player.updateCamera(this.camera, this.city, this.shake);
      this.shake = Math.max(0, this.shake - dt * 2);
    }
    if (this.state !== "paused") {
      this.fx.update(dt);
      this.destruction.update(dt);
      this.crash?.update(dt);
      this.lightning.update(dt);
      this.weather.update(dt, this.camera.position, (dist) => this.sfx.thunder(dist));
      this.sky.setFlash(this.weather.flash);
      this.hemi.intensity = this.hemiBase + this.weather.flash * 1.4;
    }
    this.hud.update(dt, this);
    this.input.endFrame();
    this.scene.render();
  }

  private update(dt: number) {
    const { player, input } = this;
    player.update(dt, input, this.city);
    this.shake = Math.max(0, this.shake - dt * 2);
    player.updateCamera(this.camera, this.city, this.shake);
    const aim = this.aimPoint();
    if (player.pose(dt, aim, input.fire)) this.sfx.step(player.steps, input.down("ShiftLeft", "ShiftRight"));
    if (player.landed) {
      if (player.landed >= SLAM_SPEED) this.slam(player.landed);
      else {
        const strength = Math.min(1, player.landed / 30);
        this.sfx.land(strength);
        this.fx.dust(player.pos.add(new Vector3(0, 0.3, 0)), Math.round(4 + 10 * strength));
        this.shake = Math.min(1, this.shake + 0.4 * strength);
      }
      player.landed = 0;
    }
    if (player.fell) {
      // The legs take the hit; the Moon's low gravity softens it.
      const k = Math.min(1, Math.max(0, (player.fell - FALL_SAFE) / (FALL_FATAL - FALL_SAFE))) * player.gravity;
      if (k > 0) this.hurtPlayer(k * FALL_MAX * player.maxHp, "fall");
      player.fell = 0;
    }
    this.sfx.jet(player.thrusting ? 1 : 0);

    const shot = player.fire(dt, input.fire);
    if (shot) {
      this.projectiles.spawn(shot.from, shot.dir.scale(BULLET_SPEED), "tracer", player.stats.gunDamage);
      this.fx.casing(shot.from.subtract(shot.dir.scale(1.2)), shot.right);
      this.sfx.shoot();
      this.shake = Math.min(this.shake + 0.04, 0.18);
    }
    this.updateLaser(dt, aim);
    this.updateTesla(dt, aim);
    const rocket = player.rockets(dt, input.down("KeyE"));
    if (rocket) {
      this.projectiles.rocket(rocket.from, rocket.dir, this);
      this.sfx.rocket();
    }

    this.sun.position.copyFrom(player.pos).subtractInPlace(this.sun.direction.scale(250));
    this.updateWorld(dt);
    this.updateWaves(dt);
  }

  /** Coming down hard: a shockwave that hurts and throws back everything around. */
  private slam(speed: number) {
    const p = this.player;
    const strength = Math.min(1, (speed - SLAM_SPEED) / 26);
    const radius = (9 + 9 * strength) * p.stats.slam;
    const dmg = (5 + 15 * strength) * p.stats.slam;
    const at = p.pos.clone();
    this.fx.slam(at, radius);
    this.sfx.slam();
    this.sfx.land(1);
    this.shake = Math.min(1, this.shake + 0.5 + 0.4 * strength);
    for (const e of this.enemies.splash(at.add(new Vector3(0, 1.5, 0)), radius, dmg, this)) this.enemies.knockBack(e, at, 25 + 20 * strength);
    this.props.blast(at, radius * 0.6, this);
    this.destruction.blast(at.add(new Vector3(0, 1, 0)), radius * 0.5, 15 * strength * p.stats.slam, this);
  }

  /** While the power-up lasts, both cannons cut with beams that reach the crosshair instantly. */
  private updateLaser(dt: number, aim: Vector3) {
    const p = this.player;
    const firing = p.special === "laser" && p.alive && this.input.fire;
    this.sfx.laser(firing);
    if (!firing) {
      for (const b of this.beams) b.hide();
      return;
    }
    this.scorchT -= dt;
    const scorch = this.scorchT <= 0;
    if (scorch) this.scorchT = 0.12;
    const look = p.look();
    p.guns.forEach((gun, i) => {
      const from = gun.muzzlePosition();
      let dir = aim.subtract(from).normalize();
      if (Vector3.Dot(dir, look) < 0.5) dir = look;
      const wall = this.city.raycastHit(from, dir, LASER_RANGE);
      const hit = this.enemies.raycastEnemy(from, dir, wall.t);
      const end = from.add(dir.scale(hit ? hit.t : wall.t));
      this.beams[i].show(from, end);
      const dmg = LASER_DPS * dt;
      this.fx.spark(end, 2);
      if (hit) this.enemies.damage(hit.enemy, dmg, this, true);
      else if (wall.t < LASER_RANGE) {
        if (!this.props.hit(wall.box, dmg, this)) this.destruction.hit(wall.box, end, wall.normal, dmg, this, 0.04);
        if (scorch) this.fx.scorch(end, wall.normal, 0.5 + Math.random() * 0.4);
      }
    });
    this.shake = Math.max(this.shake, 0.06);
  }

  /** Arcs to the enemy nearest the crosshair, then on to up to three more around it. */
  private updateTesla(dt: number, aim: Vector3) {
    const p = this.player;
    const firing = p.special === "tesla" && p.alive && this.input.fire;
    this.sfx.tesla(firing);
    this.teslaT -= dt;
    if (!firing || this.teslaT > 0) return;
    this.teslaT = TESLA_INTERVAL;
    this.teslaGun = 1 - this.teslaGun;
    const from = p.guns[this.teslaGun].muzzlePosition();
    const look = aim.subtract(from).normalize();
    this.shake = Math.max(this.shake, 0.08);

    let target: Enemy | null = null;
    let best = TESLA_CONE;
    for (const e of this.enemies.list) {
      const c = this.enemies.centre(e);
      const to = c.subtract(from);
      const d = to.length();
      if (d > TESLA_RANGE) continue;
      const dot = Vector3.Dot(to.scale(1 / d), look);
      if (dot < best || !this.city.lineOfSight(from, c)) continue;
      best = dot;
      target = e;
    }
    if (!target) {
      // Nothing to latch on to: the arc grounds into whatever is in front.
      const wall = this.city.raycastHit(from, look, TESLA_RANGE * 0.5);
      const end = from.add(look.scale(wall.t));
      this.lightning.zap(from, end);
      this.fx.spark(end, 6);
      if (wall.t < TESLA_RANGE * 0.5 && !this.props.hit(wall.box, 1, this)) {
        this.destruction.hit(wall.box, end, wall.normal, 1, this, 0.15);
        this.fx.scorch(end, wall.normal, 0.6 + Math.random() * 0.4);
      }
      return;
    }
    const struck = new Set<Enemy>();
    let src = from;
    let dmg = TESLA_DAMAGE;
    for (let jump = 0; jump <= TESLA_JUMPS && target; jump++) {
      const c = this.enemies.centre(target);
      this.lightning.zap(src, c, jump ? 0.06 : 0.1);
      this.fx.spark(c, 8);
      struck.add(target);
      this.enemies.damage(target, dmg, this, true);
      src = c;
      dmg *= 0.75;
      let next: Enemy | null = null;
      let nearest = TESLA_CHAIN;
      for (const e of this.enemies.list) {
        if (struck.has(e)) continue;
        const d = Vector3.Distance(c, this.enemies.centre(e));
        if (d < nearest) {
          nearest = d;
          next = e;
        }
      }
      target = next;
    }
  }

  /** After the first boss: fade out, move the whole fight to the Moon station, fade back in. */
  private updateWarp(dt: number) {
    const before = this.warp;
    this.warp += dt;
    const half = WARP_TIME / 2;
    this.hud.fade(Math.min(1, this.warp < half ? this.warp / (half * 0.8) : (WARP_TIME - this.warp) / (half * 0.8)));
    if (before < half && this.warp >= half) {
      this.projectiles.clear();
      this.pickups.clear();
      this.destruction.clear();
      this.fx.clearScorch();
      this.city.restore();
      this.applyTheme("moon");
      this.props.reset();
      this.loot.reset();
      this.player.teleport(crossing(BLOCKS / 2, BLOCKS / 2));
    }
    if (this.warp >= WARP_TIME) {
      this.warp = -1;
      this.hud.fade(0);
      this.hud.banner("Лунная станция «Тихо»", 3);
    }
  }

  private updateWorld(dt: number) {
    this.navTimer -= dt;
    if (this.navTimer <= 0) {
      this.city.nav.update(this.player.pos);
      this.navTimer = 0.3;
    }
    this.enemies.update(dt, this);
    this.projectiles.update(dt, this);
    this.pickups.update(dt, this);
    this.props.update(this);
    this.loot.update(dt, this);
  }

  private updateWaves(dt: number) {
    if (this.warp >= 0) return this.updateWarp(dt);
    if (this.enemies.list.length || this.wave >= FINAL_WAVE) return;
    // A cleared wave earns an upgrade: pick one of three with 1 / 2 / 3.
    if (this.wave > 0 && this.offeredFor < this.wave) {
      if (!this.upgradeOffer) {
        this.upgradeOffer = offer(this.player.levels);
        if (!this.upgradeOffer.length) {
          this.offeredFor = this.wave;
          this.upgradeOffer = null;
          return;
        }
        this.hud.showUpgrades(this.upgradeOffer, this.player.levels);
        this.hud.banner(`Волна ${this.wave} пройдена`, 2);
      }
      const choice = ["1", "2", "3"].findIndex((n) => this.input.pressed(`Digit${n}`, `Numpad${n}`));
      const picked = this.upgradeOffer[choice];
      if (!picked) return;
      this.player.upgrade(picked);
      this.sfx.powerup();
      this.hud.hideUpgrades();
      this.hud.banner(picked.name, 1.5);
      this.upgradeOffer = null;
      this.offeredFor = this.wave;
      if (this.wave === BOSS_EVERY && this.city.theme === "earth") {
        this.warp = 0;
        this.sfx.warp();
        this.hud.banner("Переброска на Луну…", WARP_TIME);
      }
      return;
    }
    const next = this.wave + 1;
    // The giant ends the city, its tougher twin ends the first half of the Moon, the flagship ends the game.
    const boss = next === FINAL_WAVE ? "flagship" : next % BOSS_EVERY ? null : next === BOSS_EVERY ? "bossTitan" : "bossTitan2";
    if (this.waveTimer < 0) {
      this.waveTimer = boss ? 4 : 2.5;
      this.hud.banner(boss === "flagship" ? "Финальная битва" : boss ? `Волна ${next} · Босс` : `Волна ${next}`, this.waveTimer);
      if (boss) this.sfx.bossAlarm();
    }
    this.waveTimer -= dt;
    if (this.waveTimer <= 0) {
      this.wave = next;
      if (boss) {
        this.enemies.spawnBoss(boss, this);
        // The flagship brings its own drones; the others come with an escort.
        this.enemies.spawnWave(boss === "flagship" ? 2 : Math.max(1, Math.floor(next / 3)), this);
      } else this.enemies.spawnWave(next, this);
      this.waveTimer = -1;
    }
  }

  /** Camera shake that fades with distance from the player. */
  addShake(dist: number, amount: number) {
    this.shake = Math.min(1, this.shake + amount * Math.max(0, 1 - dist / 80));
  }

  hurtPlayer(dmg: number, cause: "enemy" | "fall" = "enemy") {
    if (this.state !== "playing" || !this.player.alive) return;
    this.deathCause = cause;
    this.player.hp = Math.max(0, this.player.hp - dmg);
    this.hud.damage();
    this.sfx.hurt();
    this.shake = Math.min(1, this.shake + 0.3);
    if (this.player.hp <= 0) this.die();
  }

  private deathCause: "enemy" | "fall" = "enemy";

  private die() {
    this.state = "dead";
    this.sfx.jet(0);
    this.sfx.laser(false);
    this.sfx.tesla(false);
    for (const b of this.beams) b.hide();
    document.exitPointerLock();
    this.player.die();
    setTimeout(() => {
      this.fx.explosion(this.player.chest(), 1.8);
      this.sfx.explode(true);
      this.shake = 1;
      this.player.hide();
    }, 1100);
    setTimeout(() => {
      const title = this.deathCause === "fall" ? "Едрить ты камикадзе" : "Робот уничтожен";
      this.hud.showOverlay(title, `Счёт: ${this.score} · Волна: ${this.wave}<br>Кликни, чтобы сыграть ещё`);
    }, 2400);
  }

  /** The flagship has crashed: every robot left shuts down and blows up, and the game is won. */
  onFinalBossDown() {
    const left = [...this.enemies.list];
    left.forEach((e, i) => setTimeout(() => this.enemies.damage(e, 1e9, this, true), 600 + i * 120));
    setTimeout(() => {
      if (this.state !== "playing") return;
      this.state = "won";
      this.sfx.jet(0);
      this.sfx.laser(false);
      this.sfx.tesla(false);
      for (const b of this.beams) b.hide();
      this.sfx.victory();
      document.exitPointerLock();
      this.hud.showOverlay("Победа!", `Флагман сбит, Луна свободна.<br>Счёт: ${this.score}<br>Кликни, чтобы сыграть ещё`);
    }, 3500);
  }

  onBuildingDestroyed() {
    this.score += 200;
  }

  onEnemyKilled(e: Enemy) {
    this.score += e.spec.score;
    const dist = Vector3.Distance(e.pos, this.player.pos);
    if (e.spec.rig.death) this.fx.spark(e.pos.add(new Vector3(0, e.spec.hit[0][0], 0)), 30);
    else {
      const size = e.spec.boss ? 4 : e.kind === "heavyDrone" ? 1.6 : 1;
      this.fx.explosion(e.pos, size);
      if (e.spec.boss) for (let i = 1; i <= 4; i++) setTimeout(() => this.fx.explosion(e.pos.add(new Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 30)), 2), i * 250);
      this.sfx.explode(size > 1, dist);
      this.addShake(dist, 0.4);
    }
    if (e.spec.boss) {
      for (let i = 0; i < 3; i++) this.pickups.spawn(e.pos.add(new Vector3((i - 1) * 4, 0, 3)));
      this.hud.banner(`${e.spec.name} уничтожен`, 2.5);
    } else if (Math.random() < e.spec.drop) this.pickups.spawn(e.pos);
  }
}
