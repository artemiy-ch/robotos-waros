import { SKINS, type Skin } from "./skins";
import { PRIMARIES, PRIMARY_LIST, type Primary } from "./primary";
import { HALF, SIZE, type City } from "./city";
import type { Game } from "./game";
import { SPECIALS } from "./player";
import type { Upgrade } from "./upgrades";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private hpFill = byId("hp-fill");
  private hpText = byId("hp-text");
  private shieldFill = byId("shield-fill");
  private shieldText = byId("shield-text");
  private shieldHitEl = byId("shield-hit");
  private shieldHitT = 0;
  private aura = byId("aura");
  private auraLevel = 0;
  private auraT = 0;
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
  private calloutEl = byId("callout");
  private popupsEl = byId("popups");
  private combo = byId("combo");
  private comboText = byId("combo-text");
  private comboFill = byId("combo-fill");
  private diveFill = byId("dive-fill");
  private bannerEl = byId("banner");
  private overlay = byId("overlay");
  private ovTitle = byId("ov-title");
  private ovText = byId("ov-text");
  private pilot = byId("pilot");
  private nick = byId<HTMLInputElement>("nick");
  private pilotRow = byId("pilot-row");
  private pilotName = byId("pilot-name");
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

  onOverlayClick(fn: (e: MouseEvent) => void) {
    this.overlay.addEventListener("click", fn);
  }

  /** The big start button under the menus: its label, or hidden (null). */
  startButton(label: string | null) {
    const b = byId("start");
    b.classList.toggle("hidden", label === null);
    if (label) b.textContent = label;
  }

  /** The menus are up and their start button can be pressed. */
  get canStart() {
    return !this.overlay.classList.contains("hidden") && !byId("start").classList.contains("hidden");
  }

  overlayText(html: string) {
    this.ovText.innerHTML = html;
  }

  private modeButtons: HTMLButtonElement[] = [];
  private onMode: (mode: "solo" | "mp") => void = () => {};

  /** The starting weapon cards: name, a line about it, damage / range / rate as pips. */
  setupWeapons(current: Primary, onChange: (w: Primary) => void) {
    const box = byId("weapons");
    const labels = ["Урон", "Дальность", "Темп"];
    box.innerHTML = PRIMARY_LIST.map((w) => {
      const p = PRIMARIES[w];
      const bars = p.bars.map((n, i) => `<div class="wbar"><span>${labels[i]}</span><b>${"●".repeat(n)}<em>${"●".repeat(5 - n)}</em></b></div>`).join("");
      return `<button type="button" class="weapon" data-w="${w}"><strong>${p.name}</strong><small>${p.blurb}</small>${bars}</button>`;
    }).join("");
    const buttons = [...box.querySelectorAll<HTMLButtonElement>(".weapon")];
    const select = (w: Primary) => buttons.forEach((b) => b.classList.toggle("selected", b.dataset.w === w));
    select(current);
    for (const b of buttons) {
      b.addEventListener("click", () => {
        const w = b.dataset.w as Primary;
        select(w);
        onChange(w);
      });
    }
  }

  /** The single-player / multiplayer switch on the start screen, and the room controls. */
  setupModes(h: { mode(mode: "solo" | "mp"): void; create(): void; join(code: string): void }) {
    this.onMode = h.mode;
    this.modeButtons = [...this.pilot.querySelectorAll<HTMLButtonElement>(".mode")];
    for (const b of this.modeButtons) b.addEventListener("click", () => this.pickMode(b.dataset.mode as "solo" | "mp"));
    const code = byId<HTMLInputElement>("mp-code");
    const join = () => {
      if (code.value.length === 4) h.join(code.value);
      else this.mpStatus("Код — четыре буквы");
    };
    byId("mp-create").addEventListener("click", () => h.create());
    byId("mp-join").addEventListener("click", join);
    code.addEventListener("input", () => (code.value = code.value.toUpperCase().replace(/[^A-Z]/g, "")));
    code.addEventListener("keydown", (e) => {
      if (e.key === "Enter") join();
    });
  }

  pickMode(mode: "solo" | "mp", code?: string) {
    for (const b of this.modeButtons) b.classList.toggle("selected", b.dataset.mode === mode);
    byId("mp-menu").classList.toggle("hidden", mode !== "mp");
    if (code) byId<HTMLInputElement>("mp-code").value = code.toUpperCase();
    this.onMode(mode);
  }

  mpStatus(text: string) {
    byId("mp-status").textContent = text;
  }

  /** The start/end screen; `pilot` also shows the nickname and skin picker. */
  showOverlay(title: string, html: string, pilot = false) {
    this.ovTitle.textContent = title;
    this.ovText.innerHTML = html;
    this.pilot.classList.toggle("hidden", !pilot);
    this.overlay.classList.remove("hidden");
  }

  /** Fills in the picker and calls back whenever the name or the skin changes. */
  setupPilot(nick: string, skin: Skin, onChange: (nick: string, skin: Skin) => void) {
    let current = skin;
    const buttons = [...this.pilot.querySelectorAll<HTMLButtonElement>(".skin")];
    const select = () => buttons.forEach((b) => b.classList.toggle("selected", b.dataset.skin === current));
    const changed = () => {
      const name = this.nick.value.trim().slice(0, 16);
      this.pilotName.textContent = name;
      this.pilotRow.classList.toggle("hidden", !name);
      onChange(name, current);
    };
    this.nick.value = nick;
    select();
    // Clicks in here pick things; they must not start the game.
    this.pilot.addEventListener("click", (e) => e.stopPropagation());
    this.nick.addEventListener("input", changed);
    this.nick.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.nick.blur();
    });
    for (const b of buttons) {
      b.addEventListener("click", () => {
        if (SKINS.includes(b.dataset.skin as Skin)) current = b.dataset.skin as Skin;
        select();
        changed();
      });
    }
    changed();
  }

  hideOverlay() {
    this.overlay.classList.add("hidden");
  }

  hitMarker() {
    this.hitT = 0.12;
  }

  /** A blue flash at the screen edges: the shield took the hit. */
  shieldHit() {
    this.shieldHitT = Math.min(0.8, this.shieldHitT + 0.4);
  }

  damage() {
    this.dmgT = Math.min(1, this.dmgT + 0.6);
  }

  /** A big kill-streak shout in the middle of the screen. */
  callout(text: string) {
    this.calloutEl.textContent = text;
    this.calloutEl.classList.remove("show");
    void this.calloutEl.offsetWidth; // restart the animation
    this.calloutEl.classList.add("show");
  }

  /** Points floating up from a kill, at screen position (x, y). */
  popup(x: number, y: number, text: string, big: boolean) {
    const el = document.createElement("div");
    el.className = big ? "popup big" : "popup";
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.popupsEl.append(el);
    setTimeout(() => el.remove(), 950);
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
        card.className = u.legendary ? "upgrade legendary" : "upgrade";
        const level = levels.get(u.id) ?? 0;
        const foot = u.legendary ? `<small class="tag">трофей босса</small>` : `<small>уровень ${level} → ${level + 1} из ${u.max}</small>`;
        card.innerHTML = `<kbd>${i + 1}</kbd><b></b><span></span>${foot}`;
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
    const p = g.player;
    this.shieldFill.style.width = `${(p.shield / p.maxShield) * 100}%`;
    this.shieldFill.classList.toggle("charging", p.shield < p.maxShield);
    this.shieldText.textContent = String(Math.ceil(p.shield));
    this.shieldHitT = Math.max(0, this.shieldHitT - dt * 2.5);
    this.shieldHitEl.style.opacity = String(this.shieldHitT);
    const ready = 1 - g.player.rocketCd / g.player.stats.rocketCooldown;
    this.rocketFill.style.width = `${ready * 100}%`;
    this.rocketFill.classList.toggle("ready", ready >= 1);
    this.fuelFill.style.width = `${g.player.fuel * 100}%`;
    this.fuelFill.classList.toggle("low", g.player.fuel < 0.2);
    const dive = 1 - g.player.diveCd / g.player.stats.diveCooldown;
    this.diveFill.style.width = `${dive * 100}%`;
    this.diveFill.classList.toggle("ready", dive >= 1);
    this.combo.classList.toggle("hidden", g.streak < 2);
    if (g.streak >= 2) {
      this.comboText.textContent = `Серия ${g.streak} · ×${g.multiplier}`;
      this.comboFill.style.width = `${(g.streakT / 3) * 100}%`;
    }
    const special = g.player.special;
    this.laserRow.classList.toggle("hidden", !special);
    // Glow round the screen while a crate weapon is in hand; it pulses in its last seconds.
    this.auraT += dt;
    const left = g.player.specialT;
    const glow = !special ? 0 : left < 4 ? 0.15 + 0.75 * (0.5 + 0.5 * Math.sin(this.auraT * (14 - left * 2))) : 0.55;
    this.auraLevel += (glow - this.auraLevel) * Math.min(1, dt * (left < 4 ? 30 : 4));
    this.aura.style.opacity = String(this.auraLevel);
    if (special) {
      const { short, color } = SPECIALS[special];
      this.aura.style.setProperty("--aura", color);
      this.laserLabel.textContent = short;
      this.laserFill.style.width = `${(g.player.specialT / g.player.specialMax) * 100}%`;
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

    // In a room the crates and repair kits aren't on the map: finding them is part of it.
    c.fillStyle = "#ffb020";
    for (const k of g.arena ? [] : g.loot.crates) {
      if (k.opened >= 0) continue;
      c.fillStyle = "#ffd21a";
      c.fillRect(px(k.pos.x) - 3, pz(k.pos.z) - 3, 6, 6);
    }

    g.arena?.drawMap(c, px, pz);

    c.fillStyle = "#4be37a";
    for (const k of g.arena ? [] : g.pickups.list) c.fillRect(px(k.root.position.x) - 2, pz(k.root.position.z) - 2, 4, 4);

    // Other players aren't on the map: finding them is part of it.
    for (const e of g.enemies.list) {
      if (e.pilot !== undefined) continue;
      c.fillStyle = "#ff3b3b";
      c.beginPath();
      c.arc(px(e.pos.x), pz(e.pos.z), e.spec.boss ? 7 : e.pilot !== undefined || e.kind === "titan" || e.kind === "heavyDrone" ? 4 : 2.5, 0, Math.PI * 2);
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
