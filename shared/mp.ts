// Multiplayer rules and messages, shared by the game (src/) and the server (server/).
// Plain TypeScript with nothing to compile away, so Node can run it as is.
import { ROOFS } from "./roofs.ts";

/** The city grid, as in src/city.ts: crossings of the streets. */
const BLOCKS = 8;
const BLOCK = 36;
const ROAD = 14;
const STEP = BLOCK + ROAD;
const HALF = (BLOCKS * BLOCK + (BLOCKS + 1) * ROAD) / 2;
export const crossingXZ = (i: number, j: number): [number, number] => [-HALF + ROAD / 2 + i * STEP, -HALF + ROAD / 2 + j * STEP];

export const MAX_PLAYERS = 4;
/** Points to win: a held flag earns one a second, a kill earns KILL_POINTS. */
export const TARGET_SCORE = 500;
export const KILL_POINTS = 15;
/** Seconds the winner is shown before the next round starts. */
export const ROUND_BREAK = 12;
/** Seconds dead before a player is back at their base. */
export const RESPAWN_TIME = 5;

/** A capture zone: a flag at (x, y, z), taken by standing within `radius` of it at about its height. */
export interface Flag {
  name: string;
  at: [number, number];
  /** 0 on a crossing; a roof's height for a flag up on a building. */
  y: number;
  radius: number;
}

/**
 * Five flags on crossings, and four up on roofs. The city is the same for everyone (built from a
 * fixed seed), so the roofs are given here: the middles and heights of four tall buildings, one in
 * each quarter. Buildings don't fall in multiplayer, so the roofs stay.
 */
export const FLAGS: Flag[] = [
  { name: "А", at: crossingXZ(4, 4), y: 0, radius: 14 },
  { name: "Б", at: crossingXZ(2, 2), y: 0, radius: 14 },
  { name: "В", at: crossingXZ(6, 2), y: 0, radius: 14 },
  { name: "Г", at: crossingXZ(2, 6), y: 0, radius: 14 },
  { name: "Д", at: crossingXZ(6, 6), y: 0, radius: 14 },
  { name: "Е", at: [-75, 75], y: 31.64, radius: 15 },
  { name: "Ж", at: [-125, 25], y: 33.28, radius: 15 },
  { name: "З", at: [66.5, 66.5], y: 37.69, radius: 8.5 },
  { name: "И", at: [66.5, -83.5], y: 28.4, radius: 8.5 },
];

/** Whether a robot at (x, y, z) is in a flag's zone: near it, and on its roof (or low over the crossing). */
export function inZone(f: Flag, x: number, y: number, z: number) {
  const above = y - f.y;
  return above > -1 && above < (f.y ? 12 : 30) && Math.hypot(x - f.at[0], z - f.at[1]) < f.radius;
}

/** Seconds a robot can't be hurt after coming back at base (or until it opens fire). */
export const SPAWN_GUARD = 4;
/** Seconds to take a neutral flag, and to take one from another player. */
export const CAPTURE_TIME = 4;
export const RECAPTURE_TIME = 6;

/** Each player's home corner, in order of joining. */
export const BASES = [crossingXZ(0, 0), crossingXZ(8, 8), crossingXZ(8, 0), crossingXZ(0, 8)];
export const COLORS = ["#ff7a1a", "#2fd5ff", "#b6ff3a", "#ff3bd0"];

/** Weapon crates: how many lie about, how soon a taken one comes back somewhere else. */
export const CRATES = 6;
export const CRATE_RESPAWN = 20;
/** Middles of the street stretches between crossings: where crates can turn up. */
export const CRATE_SPOTS: [number, number][] = [];
for (let i = 0; i <= BLOCKS; i++) {
  for (let j = 0; j < BLOCKS; j++) {
    const [ax, az] = crossingXZ(i, j), [, bz] = crossingXZ(i, j + 1);
    CRATE_SPOTS.push([ax, (az + bz) / 2], [(az + bz) / 2, ax]);
  }
}

/** Coins and tripwire kits lying in the streets: how many, and how soon a picked-up one turns up again elsewhere. */
export const COINS = 32;
export const WIRE_KITS = 4;
export const ITEM_RESPAWN = 12;
/** Points a coin is worth; every BOOST_EVERY points of coins earns an upgrade. */
export const COIN_POINTS = 10;
export const BOOST_EVERY = 100;
/** Tripwires: how many one can carry and have set at once, how long the wire is, what it does. */
export const MAX_WIRES = 3;
export const MAX_MINES = 3;
export const WIRE_LENGTH = 24;
/** Seconds before a new tripwire goes live (so setting one at your feet doesn't blow you up). */
export const MINE_ARM = 1.5;
export const MINE_DAMAGE = 55;

/** Somewhere on a street between two crossings, off the middle line. */
export function streetSpot(): [number, number] {
  const i = Math.floor(Math.random() * (BLOCKS + 1)), j = Math.floor(Math.random() * BLOCKS);
  const [a, from] = crossingXZ(i, j);
  const along = from + ROAD / 2 + 2 + Math.random() * (STEP - ROAD - 4);
  const side = a + (Math.random() - 0.5) * (ROAD - 4);
  return Math.random() < 0.5 ? [side, along] : [along, side];
}

/** Where a coin goes: in the street, up in the air over it, or on a roof. */
export function coinSpot(): [number, number, number] {
  const r = Math.random();
  if (r < 0.4) return [...streetSpot(), 1.6];
  if (r < 0.65) return [...streetSpot(), 8 + Math.random() * 22];
  const [x, z, h, hw, hd] = ROOFS[Math.floor(Math.random() * ROOFS.length)];
  return [x + (Math.random() - 0.5) * Math.max(0, hw * 2 - 3), z + (Math.random() - 0.5) * Math.max(0, hd * 2 - 3), h + 1.6];
}

export type Weapon = "laser" | "tesla" | "shawarma";
export type Skin = "dark" | "light" | "rainbow";

/** What each client says about its own robot, 20 times a second. */
export interface PilotState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vz: number;
  /** On the ground, jets firing, alive. */
  g: boolean;
  th: boolean;
  al: boolean;
  /** Left and right buttons held; crate weapon in hand. */
  f: boolean;
  alt: boolean;
  sp: Weapon | null;
  /** Where its crosshair is. */
  ax: number;
  ay: number;
  az: number;
  hp: number;
  /** Still under the spawn guard. */
  pr: boolean;
}

export interface PlayerInfo {
  id: number;
  nick: string;
  skin: Skin;
  color: string;
  base: number;
  score: number;
  kills: number;
}

export interface FlagState {
  owner: number | null;
  /** Who is taking it, and how far along (0..1). */
  taker: number | null;
  progress: number;
  contested: boolean;
}

export interface CrateInfo {
  id: number;
  x: number;
  z: number;
  weapon: Weapon;
}

export interface ItemInfo {
  id: number;
  kind: "coin" | "wire";
  x: number;
  y: number;
  z: number;
}

/** A tripwire: a line from a to b that blows up anyone but its owner who runs into it. */
export interface MineInfo {
  id: number;
  owner: number;
  a: [number, number, number];
  b: [number, number, number];
}

export type ClientMessage =
  | { t: "join"; room: string | null; nick: string; skin: Skin }
  | { t: "state"; s: PilotState }
  | { t: "hit"; to: number; dmg: number }
  | { t: "stun"; to: number; s: number }
  | { t: "died"; by: number | null }
  | { t: "rocket"; from: [number, number, number]; dir: [number, number, number] }
  | { t: "take"; crate: number }
  | { t: "grab"; item: number }
  | { t: "plant"; a: [number, number, number]; b: [number, number, number] }
  | { t: "trip"; mine: number }
  | { t: "look"; nick: string; skin: Skin };

export type ServerMessage =
  | { t: "welcome"; id: number; room: string; players: PlayerInfo[]; flags: FlagState[]; crates: CrateInfo[]; items: ItemInfo[]; mines: MineInfo[]; winner: number | null }
  | { t: "full" }
  | { t: "nope" }
  | { t: "joined"; player: PlayerInfo }
  | { t: "left"; id: number }
  | { t: "look"; id: number; nick: string; skin: Skin }
  | { t: "snap"; ps: Record<number, PilotState>; flags: FlagState[]; scores: Record<number, [number, number]> }
  | { t: "hurt"; from: number; dmg: number }
  | { t: "stunned"; from: number; s: number }
  | { t: "kill"; killer: number | null; victim: number }
  | { t: "rocket"; id: number; from: [number, number, number]; dir: [number, number, number] }
  | { t: "captured"; flag: number; by: number }
  | { t: "crate"; crate: CrateInfo }
  | { t: "taken"; crate: number; by: number }
  | { t: "item"; item: ItemInfo }
  | { t: "grabbed"; item: number; by: number; kind: ItemInfo["kind"] }
  | { t: "mine"; mine: MineInfo }
  | { t: "boom"; mine: number; victim: number | null }
  | { t: "win"; id: number }
  | { t: "round" };
