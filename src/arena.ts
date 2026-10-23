import { Color3, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, Vector3 } from "@babylonjs/core";
import {
  BASES,
  BOTS,
  WORLD,
  TURRET_COST,
  leaderOf,
  type BotState,
  BOOST_EVERY,
  COIN_POINTS,
  MAX_WIRES,
  MINE_ARM,
  MINE_DAMAGE,
  streetSpot,
  WIRE_LENGTH,
  type ItemInfo,
  type MineInfo,
  SPAWN_GUARD,
  inZone,
  FLAGS,
  RESPAWN_TIME,
  TARGET_SCORE,
  type FlagState,
  type PilotState,
  type PlayerInfo,
  type ServerMessage,
} from "../shared/mp";
import { Enemies, type Enemy, type Kind } from "./enemies";
import type { Game } from "./game";
import type { Net } from "./net";
import { Player } from "./player";
import { PRIMARY_LIST, type Primary } from "./primary";
import { paintHero } from "./skins";
import { NEUTRAL_TURRET, turretSpot } from "./turret";
import { segSphere } from "./util";
import { LaserBeam } from "./weapons";

/** How often our robot's state goes out (and saved-up hits with it). */
const SEND_INTERVAL = 0.05;
/** A death within this many seconds of being hit is that player's kill. */
const KILL_CREDIT = 8;
const BULLET_SPEED = 170;
const LASER_RANGE = 220;
const NEUTRAL = "#d9dde3";
/** How close one has to come to pick up a coin or a tripwire kit, and how far off a tripwire can be set. */
const GRAB_RADIUS = 3.4;
const PLANT_REACH = 45;
/** Bots: how many the host keeps going (more with more players), how often it adds one, how often it reports them. */
const BOTS_BASE = 6;
const BOTS_PER_PLAYER = 3;
const BOTS_MAX = 18;
const BOT_SPAWN_EVERY = 2;
const BOT_SEND = 0.1;

/** Another player in the room: their robot (for show, and a target in the enemy list) and its name tag. */
interface Remote {
  info: PlayerInfo;
  player: Player;
  state: PilotState | null;
  tag: HTMLElement;
  hpBar: HTMLElement;
  beams: LaserBeam[] | null;
  /** Their game has gone quiet (hidden tab, lost connection): the robot stands frozen. */
  quiet: boolean;
  /** Time to the next round of their minigun, for show. */
  miniT?: number;
  /** Timers for the show copies of their tesla zaps, buster shots and lobbed shawarmas. */
  zapT: number;
  blastT: number;
  lobT: number;
  gun: number;
}

/** A flag in its zone: pole, cloth in the owner's colour, a ring round the zone, and a ring that fills as it is taken. */
interface FlagView {
  cloth: StandardMaterial;
  ring: StandardMaterial;
  progress: Mesh;
  progressMat: StandardMaterial;
  clothMesh: Mesh;
}

/**
 * Multiplayer: up to four players fighting over five flags across the city. This keeps the other
 * players' robots in step with the server, shows the flags and the score, and tells the server
 * what our robot does, whom it hits and who brought it down.
 */
export class Arena {
  readonly me: number;
  readonly room: string;
  private infos = new Map<number, PlayerInfo>();
  private remotes = new Map<number, Remote>();
  private flags: FlagState[];
  private views: FlagView[] = [];
  private flagMeshes: Mesh[] = [];
  winner: number | null;
  private sendT = 0;
  /** Who hit us last and when (and whether in the head): their kill if we go down soon after. */
  private lastHit: { id: number; t: number; head?: boolean } | null = null;
  /** Who has the price on their head now, and the beam of light over them. */
  private leader: number | null = null;
  private bountyBeam: Mesh | null = null;
  private time = 0;
  private respawnT = -1;
  private ui: HTMLElement;
  private board: HTMLElement;
  private flagBar: HTMLElement;
  private capture: HTMLElement;
  private feed: HTMLElement;
  private items = new Map<number, { info: ItemInfo; mesh: Mesh; asked: number }>();
  /** Tripwires, with when each was set (it goes live MINE_ARM seconds later). */
  private mines = new Map<number, { info: MineInfo; meshes: Mesh[]; asked: boolean; born: number }>();
  private itemBases: Record<ItemInfo["kind"], Mesh>;
  private wireMat: StandardMaterial;
  private ownWireMat: StandardMaterial;
  /** Our coins so far (each BOOST_EVERY of them is a boost), tripwires in hand, and how the next one goes up. */
  /** Seconds of the spawn guard left: no damage, no tripwires, until it runs out or we shoot. */
  guard = 0;
  /** Who runs the bots; on the host, the next bot and report, where the bots head, and its timer. */
  private host: number;
  private botT = 2;
  private botSendT = 0;
  navTarget: Vector3 | null = null;
  private navT = 0;
  /** Hits on the host's bots since the last flush. */
  private botHits = new Map<number, number>();
  private coinPoints = 0;
  private wires = 0;
  private vertical = false;
  private preview: Mesh;

  constructor(private g: Game, private net: Net, welcome: Extract<ServerMessage, { t: "welcome" }>) {
    this.me = welcome.id;
    this.room = welcome.room;
    this.flags = welcome.flags;
    this.winner = welcome.winner;
    this.host = welcome.host;
    this.ui = document.createElement("div");
    this.ui.id = "mp";
    document.body.classList.add("mp");
    this.ui.innerHTML = `<div id="mp-flags"></div><div id="mp-board"></div><div id="mp-capture"></div><div id="mp-feed"></div>`;
    document.getElementById("hud")!.append(this.ui);
    this.flagBar = this.ui.querySelector("#mp-flags")!;
    this.board = this.ui.querySelector("#mp-board")!;
    this.capture = this.ui.querySelector("#mp-capture")!;
    this.feed = this.ui.querySelector("#mp-feed")!;
    this.buildFlags();
    this.itemBases = this.buildItems();
    this.wireMat = this.glow("wire", "#ff3030", 0.55);
    this.ownWireMat = this.glow("ownWire", "#ff5a5a", 0.95);
    this.preview = MeshBuilder.CreateCylinder("wirePreview", { diameter: 0.12, height: 1, tessellation: 6 }, g.scene);
    this.preview.material = this.glow("wirePreview", "#ffffff", 0.35);
    this.preview.isPickable = false;
    this.preview.setEnabled(false);
    for (const p of welcome.players) this.addPlayer(p);
    for (const c of welcome.crates) g.loot.add(c);
    for (const it of welcome.items) this.addItem(it);
    for (const m of welcome.mines) this.addMine(m);
    // Our robot's trim in our colour, so the others can tell us apart.
    paintHero(g.player.mech, g.skin, this.color);
    this.home(false, true);
  }

  get isHost() {
    return this.host === this.me;
  }

  /** Our colour in this room. */
  get color() {
    return this.mine.color;
  }

  private glow(name: string, hex: string, alpha: number) {
    const m = new StandardMaterial(name, this.g.scene);
    m.diffuseColor = Color3.Black();
    m.emissiveColor = Color3.FromHexString(hex);
    m.disableLighting = true;
    m.alpha = alpha;
    return m;
  }

  private get mine() {
    return this.infos.get(this.me)!;
  }

  // ---- Players ----

  private addPlayer(info: PlayerInfo) {
    this.infos.set(info.id, info);
    if (info.id === this.me) return;
    const g = this.g;
    const player = new Player(g.models, g.scene, g.shadows, g.fx, true);
    // Its own copies of the hero's paint, so its skin doesn't repaint everyone else.
    for (const m of player.mech.meshes) if (m.material) m.material = m.material.clone(m.material.name);
    paintHero(player.mech, info.skin, info.color);
    const [x, z] = BASES[info.base];
    player.respawn(new Vector3(x, 0, z));
    g.enemies.addPilot(info.id, player.mech, player.pos, info.color);
    const tag = document.createElement("div");
    tag.className = "mp-tag";
    tag.style.color = info.color;
    tag.innerHTML = `<span></span><div class="mp-tag-hp"><i></i></div>`;
    tag.querySelector("span")!.textContent = info.nick;
    this.ui.append(tag);
    this.remotes.set(info.id, { info, player, state: null, tag, hpBar: tag.querySelector("i")!, beams: null, quiet: false, zapT: 0, blastT: 0, lobT: 0, gun: 0 });
  }

  private removePlayer(id: number) {
    this.infos.delete(id);
    const r = this.remotes.get(id);
    if (!r) return;
    this.g.enemies.removePilot(id);
    this.g.arsenal.forget(id);
    r.player.dispose();
    for (const b of r.beams ?? []) b.dispose();
    r.tag.remove();
    this.remotes.delete(id);
  }

  /**
   * Back in the fight, facing the middle of the city: at our corner when a round starts; after that
   * at one of our flags, or anywhere in the streets if we hold none. `keep` holds on to the upgrades.
   */
  private home(keep = true, start = false) {
    let x: number, y = 0, z: number;
    const ours = FLAGS.filter((_, i) => this.flags[i]?.owner === this.me);
    if (start) [x, z] = BASES[this.mine.base];
    else if (ours.length) {
      const f = ours[Math.floor(Math.random() * ours.length)];
      const a = Math.random() * Math.PI * 2, d = f.radius * 0.4;
      [x, z, y] = [f.at[0] + Math.cos(a) * d, f.at[1] + Math.sin(a) * d, f.y];
    } else [x, z] = streetSpot();
    const p = this.g.player;
    p.respawn(new Vector3(x, y, z), keep);
    this.guard = SPAWN_GUARD;
    p.yaw = p.facing = Math.atan2(-x, -z);
    this.respawnT = -1;
    this.lastHit = null;
  }

  private nick(id: number | null) {
    return id === null ? "" : this.infos.get(id)?.nick ?? "кто-то";
  }

  private colored(id: number) {
    const info = this.infos.get(id);
    const span = document.createElement("b");
    span.style.color = info?.color ?? "#fff";
    span.textContent = info?.nick ?? "кто-то";
    return span.outerHTML;
  }

  // ---- Messages ----

  onMessage(msg: ServerMessage) {
    const g = this.g;
    switch (msg.t) {
      case "joined":
        this.addPlayer(msg.player);
        this.log(`${this.colored(msg.player.id)} в игре`);
        break;
      case "left":
        this.log(`${this.colored(msg.id)} вышел`);
        this.removePlayer(msg.id);
        break;
      case "look": {
        const info = this.infos.get(msg.id);
        if (!info) break;
        info.nick = msg.nick;
        info.skin = msg.skin;
        const r = this.remotes.get(msg.id);
        if (r) {
          r.tag.querySelector("span")!.textContent = msg.nick;
          paintHero(r.player.mech, msg.skin, info.color);
        }
        break;
      }
      case "snap":
        this.flags = msg.flags;
        for (const [id, s] of Object.entries(msg.ps)) {
          const r = this.remotes.get(Number(id));
          if (r) r.state = s;
        }
        for (const r of this.remotes.values()) {
          const quiet = msg.quiet?.includes(r.info.id) ?? false;
          if (quiet !== r.quiet) r.tag.querySelector("span")!.textContent = quiet ? `${r.info.nick} · нет связи` : r.info.nick;
          r.quiet = quiet;
        }
        for (const [id, [score, kills]] of Object.entries(msg.scores)) {
          const info = this.infos.get(Number(id));
          if (info) (info.score = score), (info.kills = kills);
        }
        g.score = this.mine.score;
        break;
      case "hurt":
        this.lastHit = { id: msg.from, t: this.time, head: msg.head };
        g.hurtPlayer(msg.dmg);
        break;
      case "stunned":
        this.lastHit = { id: msg.from, t: this.time };
        g.player.stunT = Math.max(g.player.stunT, msg.s);
        g.hud.callout("Тебя накормили!");
        g.sfx.nom();
        break;
      case "kill": {
        const { killer, victim } = msg;
        const extra = (msg.head ? " · <b>ХЕДШОТ</b>" : "") + (msg.bounty ? " · награда за голову!" : "");
        this.log(
          killer === BOTS
            ? `Боты сбили ${this.colored(victim)}`
            : killer === WORLD
              ? `${this.colored(victim)} подорвался на растяжке`
              : killer === null ? `${this.colored(victim)} разбился` : `${this.colored(killer)} сбил ${this.colored(victim)}${extra}`,
        );
        if (killer === this.me) {
          g.hud.callout(msg.bounty ? "Награда за голову! +50" : msg.head ? "ХЕДШОТ!" : `Сбит: ${this.nick(victim)}`);
          g.sfx.callout(msg.bounty || msg.head ? 2 : 0);
        }
        break;
      }
      case "rocket": {
        const from = Vector3.FromArray(msg.from), dir = Vector3.FromArray(msg.dir);
        g.projectiles.rocket(from, dir, g, true);
        g.sfx.rocket(0.8 * Math.max(0, 1 - Vector3.Distance(from, g.player.pos) / 150));
        break;
      }
      case "captured":
        if (msg.by === this.me) {
          g.hud.banner(`Флаг ${FLAGS[msg.flag].name} твой`, 2);
          g.sfx.powerup();
        } else this.log(`${this.colored(msg.by)} взял флаг ${FLAGS[msg.flag].name}`);
        break;
      case "crate":
        g.loot.add(msg.crate, g);
        break;
      case "taken": {
        const pod = g.loot.crates.find((c) => c.id === msg.crate)?.drop;
        g.loot.open(msg.crate, msg.by === this.me, g);
        if (pod && msg.by > 0 && msg.by !== this.me) this.log(`${this.colored(msg.by)} забрал шестистволку`);
        break;
      }
      case "host":
        this.host = msg.id;
        // Taking over the bots: the copies go, and ours will come.
        if (this.isHost) for (const e of g.enemies.list.filter((x) => x.remoteBot !== undefined)) g.enemies.dropRemoteBot(e, g, true);
        break;
      case "bots":
        if (!this.isHost) this.syncBots(msg.list);
        break;
      case "bothit": {
        const e = g.enemies.list.find((x) => x.netId === msg.bot && x.remoteBot === undefined && x.pilot === undefined);
        if (!e) break;
        e.by = msg.from;
        g.enemies.damage(e, msg.dmg, g, true);
        e.by = undefined;
        break;
      }
      case "turretup":
        if (msg.by === this.me) {
          g.hud.banner(`Твоя турель на флаге ${FLAGS[msg.flag].name}`, 2);
          g.sfx.powerup();
        } else this.log(`${this.colored(msg.by)} поставил турель на ${FLAGS[msg.flag].name}`);
        break;
      case "turretdown":
        if (msg.killer === this.me) g.hud.callout(`Турель разбита! +20`);
        else if (msg.killer !== null) this.log(`${this.colored(msg.killer)} разбил турель на ${FLAGS[msg.flag].name}`);
        break;
      case "item":
        this.addItem(msg.item);
        break;
      case "grabbed":
        this.grabbed(msg.item, msg.by, msg.kind);
        break;
      case "mine":
        this.addMine(msg.mine);
        break;
      case "boom":
        this.boom(msg.mine, msg.victim);
        break;
      case "win":
        this.winner = msg.id;
        g.hud.banner(msg.id === this.me ? "Ты победил!" : `Победил ${this.nick(msg.id)}`, 8);
        if (msg.id === this.me) g.sfx.victory();
        break;
      case "round":
        this.winner = null;
        for (const info of this.infos.values()) info.score = info.kills = 0;
        g.hud.banner("Новый раунд", 2);
        this.coinPoints = 0;
        this.home(false, true);
        break;
    }
  }

  // ---- Our side ----

  /** Every other player's robot, hit by one of our weapons. */
  hitPilot(id: number, dmg: number, head = false) {
    this.net.hit(id, dmg, head);
  }

  stunPilot(id: number, seconds: number) {
    if (seconds > 0) this.net.send({ t: "stun", to: id, s: seconds });
  }

  rocket(from: Vector3, dir: Vector3) {
    this.net.send({ t: "rocket", from: from.asArray() as [number, number, number], dir: dir.asArray() as [number, number, number] });
  }

  /** We went down: whoever hit us last (lately) gets the kill; back at base after a while. */
  died() {
    const by = this.lastHit && this.time - this.lastHit.t < KILL_CREDIT ? this.lastHit.id : null;
    this.net.send({ t: "died", by, head: by !== null && by > 0 && !!this.lastHit?.head });
    this.respawnT = RESPAWN_TIME;
    this.g.hud.banner(by === BOTS ? "Тебя сбили боты" : by === WORLD ? "Подорвался на растяжке" : by !== null ? `Тебя сбил ${this.nick(by)}` : "Робот уничтожен", 2.5);
  }

  look(nick: string, skin: PlayerInfo["skin"]) {
    this.mine.nick = nick;
    this.mine.skin = skin;
    this.net.send({ t: "look", nick, skin });
  }

  update(dt: number, aim: Vector3) {
    const g = this.g;
    this.time += dt;
    if (this.respawnT >= 0) {
      this.respawnT -= dt;
      g.hud.banner(`Возрождение через ${Math.max(1, Math.ceil(this.respawnT))}…`, 0.3);
      if (this.respawnT < 0) this.home();
    }
    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = SEND_INTERVAL;
      const p = g.player, v = p.velocity;
      const r = (n: number) => Math.round(n * 100) / 100;
      this.net.send({
        t: "state",
        s: {
          x: r(p.pos.x), y: r(p.pos.y), z: r(p.pos.z), yaw: r(p.yaw), pitch: r(p.pitch), vx: r(v.x), vz: r(v.z),
          g: p.grounded, th: p.thrusting, al: p.alive, f: g.input.fire && g.state === "playing", alt: g.input.alt && g.state === "playing",
          sp: p.special, ax: r(aim.x), ay: r(aim.y), az: r(aim.z), hp: Math.round(p.hp + p.shield),
          pr: this.guard > 0,
          w: g.primary,
        },
      });
      this.net.flush();
      for (const [bot, dmg] of this.botHits) this.net.send({ t: "bothit", bot, dmg: Math.round(dmg * 100) / 100 });
      this.botHits.clear();
    }
    if (this.isHost) this.runBots(dt);
    if (g.state === "playing" && g.player.alive && g.input.pressed("KeyB")) this.buyTurret();
    if (this.guard > 0) {
      const shooting = g.state === "playing" && (g.input.fire || g.input.alt || g.input.down("KeyE"));
      this.guard = shooting ? 0 : Math.max(0, this.guard - dt);
      g.player.mech.setFlash(this.guard > 0 && Math.sin(this.time * 18) > 0);
    }
    for (const r of this.remotes.values()) this.updateRemote(r, dt);
    this.updateBounty();
    this.updateFlags();
    this.updateItems(dt);
    this.updateMines();
    this.updateUi();
  }

  // ---- The price on the leader's head ----

  /** A tall beam of gold over whoever leads, for everyone to hunt; and a word to the leader. */
  private updateBounty() {
    const g = this.g;
    const leader = leaderOf([...this.infos.values()]);
    if (leader !== this.leader) {
      if (leader === this.me) g.hud.banner("За твою голову назначена награда!", 2.5);
      else if (leader !== null) this.log(`За голову ${this.colored(leader)} назначена награда`);
      for (const r of this.remotes.values()) r.tag.querySelector("span")!.textContent = (r.info.id === leader ? "★ " : "") + r.info.nick;
      this.leader = leader;
    }
    const r = leader !== null ? this.remotes.get(leader) : undefined;
    if (!r || !r.state?.al) {
      this.bountyBeam?.setEnabled(false);
      return;
    }
    if (!this.bountyBeam) {
      this.bountyBeam = MeshBuilder.CreateCylinder("bountyBeam", { diameter: 1.6, height: 70, tessellation: 10 }, g.scene);
      const m = this.glow("bountyBeam", "#ffd60a", 0.3);
      m.alphaMode = 1; // additive
      this.bountyBeam.material = m;
      this.bountyBeam.isPickable = false;
      this.flagMeshes.push(this.bountyBeam);
    }
    this.bountyBeam.setEnabled(true);
    this.bountyBeam.position.set(r.player.pos.x, r.player.pos.y + 40, r.player.pos.z);
  }

  // ---- Turrets ----

  /** When the host last reported each flag's turret destroyed. */
  private turretGone = new Map<number, number>();

  private turretColor(owner: number) {
    return owner > 0 ? this.infos.get(owner)?.color ?? NEUTRAL_TURRET : NEUTRAL_TURRET;
  }

  /** The host keeps a turret on each flag that should have one, in its owner's colours. */
  private runTurrets() {
    const g = this.g;
    const turrets = new Map(g.enemies.list.filter((e) => e.kind === "turret" && e.remoteBot === undefined).map((e) => [e.turretFlag!, e]));
    this.flags.forEach((f, i) => {
      const e = turrets.get(i);
      if (f.turret === null || f.turret === undefined) {
        if (e) g.enemies.dropRemoteBot(e, g, true);
        return;
      }
      if (!e) {
        if (this.time - (this.turretGone.get(i) ?? -9) < 3) return;
        const flag = FLAGS[i];
        g.enemies.spawnTurret(i, turretSpot(flag.at, flag.y, flag.radius), f.turret, this.turretColor(f.turret));
      } else if (e.turretOwner !== f.turret) g.enemies.setTurretOwner(e, f.turret, this.turretColor(f.turret));
    });
  }

  /** B on our own flag with no turret: put up ours, if we have the points. */
  private buyTurret() {
    const g = this.g, p = g.player;
    const here = FLAGS.findIndex((f) => inZone(f, p.pos.x, p.pos.y, p.pos.z));
    const f = this.flags[here];
    if (!f || f.owner !== this.me || f.turret !== null) return;
    if (this.mine.score < TURRET_COST) return g.hud.banner(`Турель стоит ${TURRET_COST} очков`, 1.5);
    this.net.send({ t: "turret", flag: here });
  }

  // ---- Bots ----

  /**
   * The robot a bot at `pos` goes for, among the players still standing and not just back from the
   * dead (us included): mostly the nearest, but one it can see beats one behind a wall, a damaged one
   * is finished off, and the leader draws fire. With nobody to fight it holds its fire.
   */
  targetFor(pos: Vector3, turretOwner?: number) {
    const g = this.g, p = g.player;
    // A player's turret spares them; a neutral one (or a bot) goes for anyone.
    const spare = turretOwner !== undefined && turretOwner > 0 ? turretOwner : null;
    const top = [...this.infos.values()].reduce((a, b) => (b.score > a.score ? b : a));
    // Only a real lead counts, not the first few points.
    const leader = top.score > 50 ? top.id : null;
    const cost = (id: number, chest: Vector3, hp: number) => {
      const d = Vector3.Distance(pos, chest);
      const seen = d < 120 && g.city.lineOfSight(pos, chest);
      return d - (seen ? 45 : 0) - (hp < 70 ? 20 : 0) - (id === leader ? 15 : 0);
    };
    let best = { chest: p.chest(), vel: p.velocity, alive: p.alive && this.guard === 0 && spare !== this.me };
    let bestCost = best.alive ? cost(this.me, best.chest, p.hp + p.shield) : Infinity;
    for (const r of this.remotes.values()) {
      const s = r.state;
      if (!s || !s.al || s.pr || r.info.id === spare) continue;
      const chest = r.player.chest();
      const c = cost(r.info.id, chest, s.hp);
      if (c < bestCost) {
        bestCost = c;
        best = { chest, vel: new Vector3(s.vx, 0, s.vz), alive: true };
      }
    }
    return best;
  }

  /** Another player in the way of a bot's shot (host only), or null. */
  hitRemote(a: Vector3, b: Vector3, spare?: number) {
    for (const r of this.remotes.values()) {
      if (!r.state?.al || r.state.pr || r.info.id === spare) continue;
      if (r.player.hitSpheres().some(([c, rad]) => segSphere(a, b, c, rad))) return r.info.id;
    }
    return null;
  }

  /** A bot's shot hit us (we are the host): if it brings us down, the bots get the kill. */
  hitByBot(by?: number) {
    this.lastHit = { id: by ?? BOTS, t: this.time };
  }

  /** A bot's shot hit another player (host only). */
  botHurt(id: number, dmg: number, by?: number) {
    this.net.send({ t: "bothurt", to: id, dmg: Math.round(dmg * 100) / 100, by });
  }

  /** Our shot hit one of the host's bots. */
  hitBot(id: number, dmg: number) {
    this.botHits.set(id, (this.botHits.get(id) ?? 0) + dmg);
  }

  /** A bot went down in our game (we are the host): whoever hit it last gets the points. */
  botKilled(e: Enemy) {
    if (e.kind === "turret") {
      // Until the server says so, the flag still lists it: no new one meanwhile.
      this.turretGone.set(e.turretFlag!, this.time);
      this.net.send({ t: "turretdown", flag: e.turretFlag!, killer: e.by ?? this.me });
    }
    else this.net.send({ t: "botkill", killer: e.by ?? this.me });
  }

  /** The host keeps the bots coming, sends them roaming between the players, and tells everyone where they are. */
  private runBots(dt: number) {
    const g = this.g;
    this.runTurrets();
    const bots = g.enemies.list.filter((e) => e.pilot === undefined && e.remoteBot === undefined && e.kind !== "turret");
    const want = Math.min(BOTS_MAX, BOTS_BASE + BOTS_PER_PLAYER * this.infos.size);
    this.botT -= dt;
    if (bots.length < want && this.botT <= 0) {
      this.botT = BOT_SPAWN_EVERY;
      g.enemies.spawnBot(g);
    }
    // The street routes lead to one player at a time, a different one every few seconds; half the
    // time the one in the lead, so nobody runs away with the round.
    this.navT -= dt;
    if (this.navT <= 0) {
      this.navT = 6;
      const alive = [{ id: this.me, pos: g.player.pos, ok: g.player.alive }, ...[...this.remotes.values()].map((r) => ({ id: r.info.id, pos: r.player.pos, ok: !!r.state?.al }))].filter((x) => x.ok);
      const leader = [...this.infos.values()].reduce((a, b) => (b.score > a.score ? b : a)).id;
      const chase = alive.find((x) => x.id === leader && Math.random() < 0.5) ?? alive[Math.floor(Math.random() * alive.length)];
      if (chase) this.navTarget = chase.pos.clone();
    }
    this.botSendT -= dt;
    if (this.botSendT > 0) return;
    this.botSendT = BOT_SEND;
    const r = (n: number) => Math.round(n * 10) / 10;
    const ours = g.enemies.list.filter((e) => e.pilot === undefined && e.remoteBot === undefined);
    const list: BotState[] = ours.map((e) => {
      const fired = e.fired ?? 0;
      e.fired = 0;
      const aim = e.aim ?? e.pos;
      return [e.netId!, e.kind, r(e.pos.x), r(e.pos.y), r(e.pos.z), r(e.yaw), fired, r(aim.x), r(aim.y), r(aim.z), e.turretFlag];
    });
    this.net.send({ t: "bots", list });
  }

  /** The host's report: copies come, move, fire and go to match it. */
  private syncBots(list: BotState[]) {
    const g = this.g;
    const copies = new Map(g.enemies.list.filter((e) => e.remoteBot !== undefined).map((e) => [e.remoteBot!, e]));
    const seen = new Set<number>();
    for (const [id, kind, x, y, z, yaw, fired, ax, ay, az, flag] of list) {
      if (!Enemies.BOT_KINDS.includes(kind as Kind) && kind !== "turret") continue;
      seen.add(id);
      let e = copies.get(id);
      if (!e) e = g.enemies.addRemoteBot(id, kind as Kind, x, y, z, yaw);
      // A turret's copy shows whose it is.
      if (kind === "turret" && flag !== undefined) {
        const owner = this.flags[flag]?.turret ?? WORLD;
        if (e.turretOwner !== owner) g.enemies.setTurretOwner(e, owner, this.turretColor(owner));
        e.turretFlag = flag;
      }
      e.netPos!.set(x, y, z);
      e.netYaw = yaw;
      if (fired) g.enemies.showShots(e, fired, new Vector3(ax, ay, az), g);
    }
    for (const [id, e] of copies) if (!seen.has(id)) g.enemies.dropRemoteBot(e, g);
  }

  // ---- Coins and tripwire kits ----

  private buildItems() {
    const scene = this.g.scene;
    // A gold coin standing on its edge, and a red reel of tripwire.
    const coin = MeshBuilder.CreateCylinder("coin", { diameter: 1.5, height: 0.2, tessellation: 20 }, scene);
    coin.rotation.x = Math.PI / 2;
    coin.bakeCurrentTransformIntoVertices();
    const gold = new StandardMaterial("coin", scene);
    gold.diffuseColor = new Color3(1, 0.78, 0.15);
    gold.emissiveColor = new Color3(0.55, 0.38, 0.02);
    gold.specularColor = new Color3(1, 0.9, 0.5);
    coin.material = gold;
    const reel = MeshBuilder.CreateCylinder("wireKit", { diameter: 1.1, height: 0.7, tessellation: 14 }, scene);
    reel.material = this.glow("wireKit", "#ff3030", 1);
    for (const m of [coin, reel]) {
      m.isPickable = false;
      m.setEnabled(false);
      this.flagMeshes.push(m);
    }
    return { coin, wire: reel };
  }

  private addItem(info: ItemInfo) {
    const mesh = this.itemBases[info.kind].clone(`item${info.id}`);
    mesh.setEnabled(true);
    mesh.position.set(info.x, info.y, info.z);
    this.items.set(info.id, { info, mesh, asked: -9 });
  }

  private grabbed(id: number, by: number, kind: ItemInfo["kind"]) {
    const item = this.items.get(id);
    if (item) {
      this.g.fx.spark(item.mesh.position, 12);
      item.mesh.dispose();
      this.items.delete(id);
    }
    if (by !== this.me) return;
    const g = this.g;
    if (kind === "wire") {
      this.wires = Math.min(MAX_WIRES, this.wires + 1);
      g.hud.banner(`Растяжка ${this.wires}/${MAX_WIRES} · F`, 2);
      g.sfx.powerup();
      return;
    }
    const before = Math.floor(this.coinPoints / BOOST_EVERY);
    this.coinPoints += COIN_POINTS;
    g.sfx.coin();
    g.popup(g.player.chest().addInPlaceFromFloats(0, 2.5, 0), `+${COIN_POINTS}`);
    if (Math.floor(this.coinPoints / BOOST_EVERY) > before) g.offerBoost();
  }

  /** Spinning items; walking up to one asks the server for it (the first to ask gets it). */
  private updateItems(dt: number) {
    const p = this.g.player;
    for (const [id, it] of this.items) {
      it.mesh.rotation.y += dt * 2.5;
      it.mesh.position.y = it.info.y + Math.sin(this.time * 3 + id) * 0.25;
      // Some coins hang in the air or sit on roofs: close enough means at about the same height, too.
      const near = Math.hypot(it.info.x - p.pos.x, it.info.z - p.pos.z) < GRAB_RADIUS && Math.abs(p.pos.y + 2.5 - it.info.y) < 3.5;
      if (!near || !p.alive || this.time - it.asked < 1) continue;
      if (it.info.kind === "wire" && this.wires >= MAX_WIRES) continue;
      it.asked = this.time;
      this.net.send({ t: "grab", item: id });
    }
  }

  // ---- Tripwires ----

  private addMine(info: MineInfo) {
    const scene = this.g.scene;
    const a = Vector3.FromArray(info.a), b = Vector3.FromArray(info.b);
    const wire = MeshBuilder.CreateCylinder(`mine${info.id}`, { diameter: 0.09, height: 1, tessellation: 6 }, scene);
    this.stretch(wire, a, b);
    wire.material = info.owner === this.me ? this.ownWireMat : this.wireMat;
    const meshes = [wire];
    for (const end of [a, b]) {
      const peg = MeshBuilder.CreateBox(`minePeg${info.id}`, { size: 0.45 }, scene);
      peg.position.copyFrom(end);
      peg.material = this.ownWireMat;
      meshes.push(peg);
    }
    for (const m of meshes) m.isPickable = false;
    this.mines.set(info.id, { info, meshes, asked: false, born: this.time });
  }

  /** Lays a unit-height cylinder from a to b. */
  private stretch(m: Mesh, a: Vector3, b: Vector3) {
    const d = b.subtract(a);
    m.position.copyFrom(a.add(b).scale(0.5));
    m.scaling.set(1, d.length(), 1);
    // The cylinder runs along Y; turn Y onto a→b.
    const up = Vector3.Up(), dir = d.normalize();
    const axis = Vector3.Cross(up, dir);
    const angle = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(up, dir))));
    m.rotationQuaternion = axis.lengthSquared() < 1e-6 ? null : Quaternion.RotationAxis(axis.normalize(), angle);
    if (!m.rotationQuaternion) m.rotation.x = dir.y < 0 ? Math.PI : 0;
  }

  private boom(id: number, victim: number | null) {
    const mine = this.mines.get(id);
    if (!mine) return;
    for (const m of mine.meshes) m.dispose();
    this.mines.delete(id);
    const g = this.g;
    const at = Vector3.FromArray(mine.info.a).add(Vector3.FromArray(mine.info.b)).scale(0.5);
    if (victim === null) return g.fx.pop(at);
    const where = victim === this.me ? g.player.chest() : this.remotes.get(victim)?.player.chest() ?? at;
    g.fx.explosion(where, 1.4);
    g.sfx.explode(false, Vector3.Distance(where, g.player.pos));
    g.addShake(Vector3.Distance(where, g.player.pos), 0.6);
    if (victim === this.me) {
      this.lastHit = mine.info.owner === this.me ? null : { id: mine.info.owner, t: this.time };
      g.hurtPlayer(MINE_DAMAGE);
      g.hud.callout("Растяжка!");
    } else if (mine.info.owner === this.me) g.hud.callout(`${this.nick(victim)} на растяжке!`);
    if (victim === this.me && mine.info.owner === this.me) g.hud.callout("На своей же растяжке!");
  }

  /** Setting tripwires (F, R to turn), and running into other people's. */
  private updateMines() {
    const g = this.g, p = g.player;
    const blink = 0.4 + 0.25 * Math.sin(this.time * 6);
    this.wireMat.alpha = blink;
    if (p.alive && this.guard === 0) {
      const spheres = p.hitSpheres();
      for (const [id, m] of this.mines) {
        // Our own as well: watch your step.
        if (m.asked || this.time - m.born < MINE_ARM) continue;
        const a = Vector3.FromArray(m.info.a), b = Vector3.FromArray(m.info.b);
        if (spheres.some(([c, r]) => segSphere(a, b, c, r + 0.2))) {
          m.asked = true;
          this.net.send({ t: "trip", mine: id });
        }
      }
    }
    const playing = g.state === "playing" && p.alive;
    if (playing && g.input.pressed("KeyR") && this.wires > 0) {
      this.vertical = !this.vertical;
      g.hud.banner(this.vertical ? "Растяжка: вертикально" : "Растяжка: горизонтально", 1.2);
    }
    const spot = playing && this.wires > 0 ? this.wireSpot() : null;
    this.preview.setEnabled(!!spot);
    if (!spot) return;
    this.stretch(this.preview, spot[0], spot[1]);
    if (!g.input.pressed("KeyF")) return;
    this.wires--;
    g.sfx.click();
    const r = (v: Vector3) => v.asArray().map((n) => Math.round(n * 100) / 100) as [number, number, number];
    this.net.send({ t: "plant", a: r(spot[0]), b: r(spot[1]) });
  }

  /**
   * Where a tripwire would go: on the surface under the crosshair, within reach. Horizontal runs
   * across the way we look (on the ground, at shin height) or along a wall; vertical stands up
   * from the ground or runs up the wall. Cut short where it would go into a wall.
   */
  private wireSpot(): [Vector3, Vector3] | null {
    const g = this.g, look = g.player.look(), o = g.camera.position;
    const hit = g.city.raycastHit(o, look, PLANT_REACH);
    if (hit.t >= PLANT_REACH) return null;
    const n = hit.normal, up = Vector3.Up();
    const p = o.add(look.scale(hit.t));
    const flat = Math.abs(n.y) > 0.7;
    if (this.vertical && flat) {
      const a = p.add(up.scale(0.3));
      return [a, a.add(up.scale(Math.min(WIRE_LENGTH, g.city.raycast(a, up, WIRE_LENGTH) - 0.2)))];
    }
    const centre = p.add(n.scale(flat ? 1.2 : 0.8));
    const dir = this.vertical ? up : flat ? new Vector3(-look.z, 0, look.x).normalize() : Vector3.Cross(n, up).normalize();
    const reach = (d: Vector3) => Math.min(WIRE_LENGTH / 2, g.city.raycast(centre, d, WIRE_LENGTH / 2) - 0.2);
    return [centre.add(dir.scale(-reach(dir.scale(-1)))), centre.add(dir.scale(reach(dir)))];
  }

  /** Another robot: where the server last saw it, posed and firing (for show) like ours. */
  private updateRemote(r: Remote, dt: number) {
    const g = this.g, s = r.state, p = r.player;
    if (!s) return;
    if (!s.al && p.alive) {
      p.die();
      setTimeout(() => {
        if (p.alive) return;
        g.fx.explosion(p.chest(), 1.8);
        g.sfx.explode(true, Vector3.Distance(p.pos, g.player.pos));
        p.hide();
      }, 1100);
    } else if (s.al && !p.alive) p.respawn(new Vector3(s.x, s.y, s.z));
    p.follow(dt, s);
    const e = g.enemies.list.find((x) => x.pilot === r.info.id);
    if (e) {
      e.pos.copyFrom(p.pos);
      e.yaw = p.facing;
    }
    const aim = new Vector3(s.ax, s.ay, s.az);
    const firing = s.f && s.al;
    const weapon: Primary = PRIMARY_LIST.includes(s.w as Primary) ? (s.w as Primary) : "guns";
    p.pose(dt, aim, firing && weapon === "guns");
    // A robot just back from the dead blinks while nothing can hurt it.
    const enemy = g.enemies.list.find((x) => x.pilot === r.info.id);
    if (enemy && s.pr) enemy.flashT = Math.sin(this.time * 18) > 0 ? 0.05 : 0;
    // Their shots, for show: the damage is dealt by their game.
    g.arsenal.fire(r.info.id, weapon, dt, firing && !s.sp, p, aim, g, false);
    if (firing && !s.sp && weapon === "guns") {
      const shot = p.fire(dt, true);
      if (shot) g.projectiles.spawn(shot.from, shot.dir.scale(BULLET_SPEED), "tracer", 0);
    }
    // Their minigun, for show: the same forty rounds a second.
    r.miniT = (r.miniT ?? 0) - dt;
    if (firing && s.sp === "minigun") {
      const near = Vector3.Distance(p.pos, g.player.pos);
      while (r.miniT <= 0) {
        r.miniT += 0.025;
        r.gun = 1 - r.gun;
        const from = p.guns[r.gun].muzzlePosition();
        const dir = aim.subtract(from).normalize().addInPlaceFromFloats((Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.06).normalize();
        g.projectiles.spawn(from, dir.scale(BULLET_SPEED), "tracer", 0);
        if (r.gun) g.sfx.minigun(near);
      }
    } else r.miniT = Math.max(r.miniT, 0);
    const lasing = firing && s.sp === "laser";
    if (lasing) r.beams ??= [new LaserBeam(g.scene), new LaserBeam(g.scene)];
    p.guns.forEach((gun, i) => {
      if (!r.beams) return;
      if (!lasing) return r.beams[i].hide();
      const from = gun.muzzlePosition();
      const dir = aim.subtract(from).normalize();
      r.beams[i].show(from, from.add(dir.scale(g.city.raycast(from, dir, LASER_RANGE))));
    });
    r.zapT -= dt;
    r.blastT -= dt;
    r.lobT -= dt;
    if (firing && s.sp === "tesla" && r.zapT <= 0) {
      r.zapT = 0.1;
      r.gun = 1 - r.gun;
      g.lightning.zap(p.guns[r.gun].muzzlePosition(), aim);
    }
    if (firing && s.sp === "shawarma" && r.blastT <= 0) {
      r.blastT = 0.11;
      r.gun = 1 - r.gun;
      const from = p.guns[r.gun].muzzlePosition();
      g.shawarma.blast(from, aim.subtract(from).normalize(), 0);
    }
    if (s.alt && s.al && r.lobT <= 0) {
      r.lobT = 0.45;
      g.shawarma.lob(p.chest().addInPlaceFromFloats(0, 0.8, 0), aim, 0);
    }
  }

  // ---- Flags ----

  private buildFlags() {
    const scene = this.g.scene;
    const glowing = (name: string, alpha = 1) => {
      const m = new StandardMaterial(name, scene);
      m.diffuseColor = Color3.Black();
      m.emissiveColor = Color3.FromHexString(NEUTRAL);
      m.disableLighting = true;
      m.alpha = alpha;
      return m;
    };
    const pole = MeshBuilder.CreateCylinder("flagPole", { diameter: 0.35, height: 14, tessellation: 8 }, scene);
    pole.material = new StandardMaterial("flagPole", scene);
    (pole.material as StandardMaterial).diffuseColor = new Color3(0.55, 0.57, 0.6);
    pole.setEnabled(false);
    this.flagMeshes.push(pole);
    FLAGS.forEach((flag, i) => {
      const [x, z] = flag.at;
      // On a roof the pole stands to one side, clear of anything in the middle.
      const px = flag.y ? x + flag.radius * 0.5 : x;
      const p = pole.createInstance(`flagPole${i}`);
      p.position.set(px, flag.y + 7, z);
      this.g.shadows.addShadowCaster(p);
      const cloth = glowing(`flagCloth${i}`);
      const clothMesh = MeshBuilder.CreateBox(`flagCloth${i}`, { width: 4.2, height: 2.6, depth: 0.08 }, scene);
      clothMesh.position.set(px + 2.2, flag.y + 12.5, z);
      clothMesh.material = cloth;
      const ring = glowing(`flagRing${i}`, 0.55);
      const ringMesh = MeshBuilder.CreateTorus(`flagRing${i}`, { diameter: flag.radius * 2, thickness: 0.35, tessellation: 64 }, scene);
      ringMesh.position.set(x, flag.y + 0.12, z);
      ringMesh.material = ring;
      const progressMat = glowing(`flagProgress${i}`, 0.3);
      const progress = MeshBuilder.CreateDisc(`flagProgress${i}`, { radius: flag.radius, tessellation: 48 }, scene);
      progress.rotation.x = Math.PI / 2;
      progress.position.set(x, flag.y + 0.1, z);
      progress.material = progressMat;
      progress.setEnabled(false);
      for (const m of [clothMesh, ringMesh, progress]) m.isPickable = false;
      this.flagMeshes.push(clothMesh, ringMesh, progress);
      this.views.push({ cloth, ring, progress, progressMat, clothMesh });
    });
  }

  private flagColor(id: number | null) {
    return Color3.FromHexString(id === null ? NEUTRAL : this.infos.get(id)?.color ?? NEUTRAL);
  }

  private updateFlags() {
    this.flags.forEach((f, i) => {
      const v = this.views[i];
      if (!v) return;
      const owner = this.flagColor(f.owner);
      v.cloth.emissiveColor = owner;
      v.ring.emissiveColor = f.contested ? (Math.sin(this.time * 12) > 0 ? new Color3(1, 0.2, 0.2) : owner) : owner;
      v.clothMesh.rotation.y = Math.sin(this.time * 2 + i) * 0.15;
      const taking = f.taker !== null && f.progress > 0;
      v.progress.setEnabled(taking);
      if (taking) {
        v.progress.scaling.setAll(Math.max(0.02, f.progress));
        v.progressMat.emissiveColor = this.flagColor(f.taker);
      }
    });
  }

  // ---- Screen ----

  private updateUi() {
    const g = this.g;
    // Name tags over the other robots.
    const w = g.engine.getRenderWidth(), h = g.engine.getRenderHeight();
    const canvas = g.engine.getRenderingCanvas()!;
    const transform = g.scene.getTransformMatrix();
    const viewport = g.camera.viewport.toGlobal(w, h);
    for (const r of this.remotes.values()) {
      const p = r.player;
      const at = Vector3.Project(new Vector3(p.pos.x, p.pos.y + 6.6, p.pos.z), Matrix.Identity(), transform, viewport);
      const dist = Vector3.Distance(p.pos, g.camera.position);
      const shown = r.state?.al && at.z > 0 && at.z < 1 && dist < 300;
      r.tag.style.display = shown ? "" : "none";
      if (!shown) continue;
      r.tag.style.transform = `translate(${(at.x / w) * canvas.clientWidth}px, ${(at.y / h) * canvas.clientHeight}px) translate(-50%, -100%)`;
      r.hpBar.style.width = `${Math.max(0, Math.min(1, (r.state?.hp ?? 0) / 160)) * 100}%`;
    }

    // The flags along the top, coloured by owner; one being taken blinks in the taker's colour.
    this.flagBar.innerHTML = this.flags
      .map((f, i) => {
        const owner = f.owner === null ? NEUTRAL : this.infos.get(f.owner)?.color ?? NEUTRAL;
        const blink = (f.taker !== null && f.progress > 0) || f.contested ? " blink" : "";
        return `<span class="mp-flag${blink}" style="border-color:${owner};color:${owner}">${FLAGS[i].name}</span>`;
      })
      .join("");

    // Score board: first to TARGET_SCORE.
    const rows = [...this.infos.values()].sort((a, b) => b.score - a.score);
    this.board.innerHTML =
      `<div class="mp-room">Комната <b>${this.room}</b> · до ${TARGET_SCORE}</div>` +
      rows
        .map((p) => {
          const held = this.flags.filter((f) => f.owner === p.id).length;
          const row = document.createElement("div");
          row.className = p.id === this.me ? "mp-row me" : "mp-row";
          row.innerHTML = `<i style="background:${p.color}"></i><span></span><b>${p.score}</b><em>⚑${held} ✖${p.kills}</em>`;
          row.querySelector("span")!.textContent = p.nick;
          return row.outerHTML;
        })
        .join("") +
      `<div class="mp-own">Монеты: ${this.coinPoints % BOOST_EVERY}/${BOOST_EVERY} до буста</div>` +
      (this.wires ? `<div class="mp-own">Растяжки: ${this.wires} · F поставить · R ${this.vertical ? "↕" : "↔"}</div>` : "");

    // Taking a flag: how far along, or that someone is in the way.
    const pos = g.player.pos;
    const here = FLAGS.findIndex((f) => inZone(f, pos.x, pos.y, pos.z));
    const f = here >= 0 ? this.flags[here] : null;
    let text = "";
    if (f && g.player.alive) {
      const name = FLAGS[here].name;
      if (f.contested) text = `Флаг ${name} оспаривается!`;
      else if (f.owner === this.me)
        text = f.turret === null ? `Флаг ${name} твой · B — поставить турель (${TURRET_COST})` : `Флаг ${name} твой`;
      else if (f.taker === this.me) text = `Захват флага ${name}: ${Math.round(f.progress * 100)}%`;
      else text = `Захват флага ${name}…`;
    }
    this.capture.textContent = text;
    this.capture.style.opacity = text ? "1" : "0";
  }

  private log(html: string) {
    const line = document.createElement("div");
    line.innerHTML = html;
    this.feed.prepend(line);
    setTimeout(() => line.remove(), 6000);
    while (this.feed.children.length > 5) this.feed.lastElementChild!.remove();
  }

  /** The minimap: our tripwires, and each flag as a letter in its owner's colour. Coins and weapons are for finding. */
  drawMap(c: CanvasRenderingContext2D, px: (x: number) => number, pz: (z: number) => number) {
    // The leader, whom everyone hunts: the only player on the map (a pulsing gold star in their colour).
    const lead = this.leader !== null ? this.remotes.get(this.leader) : undefined;
    if (lead?.state?.al) {
      const x = px(lead.player.pos.x), y = pz(lead.player.pos.z), r = 6 + Math.sin(this.time * 6) * 1.5;
      c.fillStyle = "#ffd60a";
      c.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2, d = i % 2 ? r * 0.45 : r;
        c.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
      }
      c.closePath();
      c.fill();
      c.strokeStyle = lead.info.color;
      c.lineWidth = 1.5;
      c.stroke();
    }
    // A drop pod on its way down or waiting: the one thing worth marking.
    for (const k of this.g.loot.crates) {
      if (!k.drop || k.opened >= 0) continue;
      c.fillStyle = Math.sin(this.time * 8) > 0 ? "#ffd60a" : "#fff3a0";
      c.beginPath();
      c.arc(px(k.pos.x), pz(k.pos.z), 6, 0, Math.PI * 2);
      c.fill();
    }
    c.strokeStyle = "#ff5a5a";
    c.lineWidth = 2;
    for (const m of this.mines.values()) {
      if (m.info.owner !== this.me) continue;
      c.beginPath();
      c.moveTo(px(m.info.a[0]), pz(m.info.a[2]));
      c.lineTo(px(m.info.b[0]), pz(m.info.b[2]));
      c.stroke();
    }
    c.font = "bold 11px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    this.flags.forEach((f, i) => {
      const [x, z] = FLAGS[i].at;
      c.fillStyle = f.owner === null ? NEUTRAL : this.infos.get(f.owner)?.color ?? NEUTRAL;
      c.beginPath();
      c.arc(px(x), pz(z), 7, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#111";
      c.fillText(FLAGS[i].name, px(x), pz(z) + 0.5);
    });
  }

  dispose() {
    for (const id of [...this.remotes.keys()]) this.removePlayer(id);
    for (const it of this.items.values()) it.mesh.dispose();
    for (const m of this.mines.values()) for (const mesh of m.meshes) mesh.dispose();
    this.preview.dispose();
    paintHero(this.g.player.mech, this.g.skin);
    for (const m of this.flagMeshes) m.dispose();
    this.ui.remove();
    document.body.classList.remove("mp");
    this.net.close();
  }
}
