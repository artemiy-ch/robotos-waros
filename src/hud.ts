import { HALF, SIZE, type City } from "./city";
import type { Game } from "./game";
import { SPECIAL_TIME, SPECIALS } from "./player";
import type { Upgrade } from "./upgrades";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private hpFill = byId("hp-fill");
  private hpText = byId("hp-text");
  private rocketFill = byId("rocket-fill");
  private fuelFill = byId("fuel-fill");
  private laserRow = byId("laser-row");
  private laserFill = byId("laser-fill");
  private laserText = byId("laser-text");
  private laserLabel = byId("laser-label");
  private bossBar = byId("boss");
  private bossName = byId("boss-name");
  private bossFill = byId("boss-fill");
  private upgradesEl = byId("upgrades");
  private upgradeCards = byId("upgrade-cards");
  private score = byId("score");
  private wave = byId("wave");
  private left = byId("left");
  private hit = byId("hitmarker");
  private vignette = byId("damage");
  private flashEl = byId("flash");
  private fadeEl = byId("fade");
  private warningEl = byId("warning");
  private warningT = 0;
  private bannerEl = byId("banner");
  private overlay = byId("overlay");
  private ovTitle = byId("ov-title");
  private ovText = byId("ov-text");
  private map = byId<HTMLCanvasElement>("minimap");
  private mapCtx = this.map.getContext("2d")!;
  private mapBg = document.createElement("canvas");
  private hitT = 0;
  private dmgT = 0;
  private bannerT = 0;
  private flashT = 0;
  private mapVersion = -1;

  constructor(private city: City) {}

  /** Map background: redrawn whenever a building falls or the city is restored. */
  private drawMapBackground() {
    const city = this.city;
    this.mapVersion = city.version;
    const w = (this.mapBg.width = this.mapBg.height = this.map.width);
    const c = this.mapBg.getContext("2d")!;
    const s = w / SIZE;
    c.fillStyle = "#30343b";
    c.fillRect(0, 0, w, w);
    c.fillStyle = "#8b929c";
    for (const b of city.boxes) {
      c.fillRect((b.minX + HALF) * s, (HALF - b.maxZ) * s, Math.max(1, (b.maxX - b.minX) * s), Math.max(1, (b.maxZ - b.minZ) * s));
    }
  }

  onOverlayClick(fn: () => void) {
    this.overlay.addEventListener("click", fn);
  }

  showOverlay(title: string, html: string) {
    this.ovTitle.textContent = title;
    this.ovText.innerHTML = html;
    this.overlay.classList.remove("hidden");
  }

  hideOverlay() {
    this.overlay.classList.add("hidden");
  }

  hitMarker() {
    this.hitT = 0.12;
  }

  damage() {
    this.dmgT = Math.min(1, this.dmgT + 0.6);
  }

  /** A red, blinking alert under the boss bar. */
  warning(text: string) {
    this.warningEl.textContent = `⚠ ${text} ⚠`;
    this.warningT = 1.6;
  }

  /** Blacks the screen out (1) or clears it (0), for scene changes. */
  fade(amount: number) {
    this.fadeEl.style.opacity = String(amount);
  }

  /** A burst of light on screen from a nearby explosion; amount 0..1. */
  flash(amount: number) {
    this.flashT = Math.min(0.8, Math.max(this.flashT, amount));
  }

  showUpgrades(options: Upgrade[], levels: Map<string, number>) {
    this.upgradeCards.replaceChildren(
      ...options.map((u, i) => {
        const card = document.createElement("div");
        card.className = "upgrade";
        const level = levels.get(u.id) ?? 0;
        card.innerHTML = `<kbd>${i + 1}</kbd><b></b><span></span><small>уровень ${level} → ${level + 1} из ${u.max}</small>`;
        card.querySelector("b")!.textContent = u.name;
        card.querySelector("span")!.textContent = u.text;
        return card;
      }),
    );
    this.upgradesEl.classList.remove("hidden");
  }

  hideUpgrades() {
    this.upgradesEl.classList.add("hidden");
  }

  banner(text: string, seconds: number) {
    this.bannerEl.textContent = text;
    this.bannerT = seconds;
  }

  update(dt: number, g: Game) {
    const hp = g.player.hp / g.player.maxHp;
    this.hpFill.style.width = `${hp * 100}%`;
    this.hpFill.style.background = hp > 0.5 ? "#4be37a" : hp > 0.25 ? "#ffc23d" : "#ff4b4b";
    this.hpText.textContent = String(Math.ceil(g.player.hp));
    const ready = 1 - g.player.rocketCd / g.player.stats.rocketCooldown;
    this.rocketFill.style.width = `${ready * 100}%`;
    this.rocketFill.classList.toggle("ready", ready >= 1);
    this.fuelFill.style.width = `${g.player.fuel * 100}%`;
    this.fuelFill.classList.toggle("low", g.player.fuel < 0.2);
    const special = g.player.special;
    this.laserRow.classList.toggle("hidden", !special);
    if (special) {
      const { name, color } = SPECIALS[special];
      this.laserLabel.textContent = special === "laser" ? name : "Тесла";
      this.laserFill.style.width = `${(g.player.specialT / SPECIAL_TIME) * 100}%`;
      this.laserFill.style.background = color;
      this.laserFill.style.boxShadow = `0 0 8px ${color}`;
      this.laserText.style.color = color;
      this.laserText.textContent = `${Math.ceil(g.player.specialT)}с`;
    }
    this.score.textContent = String(g.score);
    this.wave.textContent = String(g.wave);
    this.left.textContent = String(g.enemies.list.length);
    const boss = g.enemies.boss;
    this.bossBar.classList.toggle("hidden", !boss);
    if (boss) {
      this.bossName.textContent = boss.spec.name;
      this.bossFill.style.width = `${Math.max(0, boss.hp / boss.spec.hp) * 100}%`;
    }

    this.hitT -= dt;
    this.hit.style.opacity = this.hitT > 0 ? "1" : "0";
    this.dmgT = Math.max(0, this.dmgT - dt * 2);
    this.vignette.style.opacity = String(this.dmgT);
    this.flashT = Math.max(0, this.flashT - dt * 3);
    this.flashEl.style.opacity = String(this.flashT);
    this.bannerT -= dt;
    this.warningT -= dt;
    this.warningEl.style.opacity = this.warningT > 0 && Math.floor(this.warningT * 6) % 2 === 0 ? "1" : "0";
    this.bannerEl.style.opacity = String(Math.max(0, Math.min(1, this.bannerT)));

    this.drawMap(g);
  }

  private drawMap(g: Game) {
    const c = this.mapCtx;
    const s = this.map.width / SIZE;
    const px = (x: number) => (x + HALF) * s;
    const pz = (z: number) => (HALF - z) * s;
    if (this.mapVersion !== this.city.version) this.drawMapBackground();
    c.drawImage(this.mapBg, 0, 0);

    c.fillStyle = "#ffb020";
    for (const k of g.loot.crates) {
      if (k.opened >= 0) continue;
      c.fillStyle = "#ffd21a";
      c.fillRect(px(k.pos.x) - 3, pz(k.pos.z) - 3, 6, 6);
    }

    c.fillStyle = "#4be37a";
    for (const k of g.pickups.list) c.fillRect(px(k.root.position.x) - 2, pz(k.root.position.z) - 2, 4, 4);

    for (const e of g.enemies.list) {
      c.fillStyle = "#ff3b3b";
      c.beginPath();
      c.arc(px(e.pos.x), pz(e.pos.z), e.spec.boss ? 7 : e.kind === "titan" || e.kind === "heavyDrone" ? 4 : 2.5, 0, Math.PI * 2);
      c.fill();
    }

    c.save();
    c.translate(px(g.player.pos.x), pz(g.player.pos.z));
    c.rotate(g.player.yaw);
    c.fillStyle = "#3ee8ff";
    c.beginPath();
    c.moveTo(0, -6);
    c.lineTo(4.5, 5);
    c.lineTo(-4.5, 5);
    c.closePath();
    c.fill();
    c.restore();
  }
}
