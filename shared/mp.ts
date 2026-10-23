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

/** Bumped whenever the messages or the rules change: a game and a server of different versions don't play together. */
export const PROTOCOL = 14;

/**
 * The maps: the city, its overgrown ruins in the jungle, the city flooded, and the Moon station.
 * All four share the city's street grid; rooms go round them, two rounds on each: by day, then by night. The Moon's
 * buildings are domes and towers, so its four roof flags stand on crossings instead (see flagsFor).
 */
export type MapName = "city" | "jungle" | "flood" | "moon";
export const MP_MAPS: MapName[] = ["city", "jungle", "flood", "moon"];

/** Which crossings each map's play area runs between: the jungle is the middle of the city, walled in by forest. */
export const MAP_SPAN: Record<MapName, [number, number]> = { city: [0, BLOCKS], jungle: [1, BLOCKS - 1], flood: [0, BLOCKS], moon: [0, BLOCKS] };

/** The edges of a map's play area (a square, the same along x and z). */
export function spanEdges(map: MapName): [number, number] {
  const [lo, hi] = MAP_SPAN[map];
  return [crossingXZ(lo, lo)[0] - ROAD / 2, crossingXZ(hi, hi)[0] + ROAD / 2];
}

export function inSpan(map: MapName, x: number, z: number) {
  const [a, b] = spanEdges(map);
  return x > a && x < b && z > a && z < b;
}

/** Each player's home corner on a map, in order of joining. */
export function basesFor(map: MapName) {
  const [lo, hi] = MAP_SPAN[map];
  return [crossingXZ(lo, lo), crossingXZ(hi, hi), crossingXZ(hi, lo), crossingXZ(lo, hi)];
}

export const MAX_PLAYERS = 4;
/** Points to win: a held flag earns one a second, a kill earns KILL_POINTS. */
export const TARGET_SCORE = 1000;
export const KILL_POINTS = 15;
/** Extra for a kill with a shot to the head (which does HEADSHOT times the damage). */
export const HEADSHOT_POINTS = 10;
export const HEADSHOT = 1.75;
/** The leader (with at least BOUNTY_FROM points) has a price on their head: this much for bringing them down instead of KILL_POINTS. */
export const BOUNTY_POINTS = 50;
export const BOUNTY_FROM = 50;
/** One drop pod a round, this many seconds in. */
export const DROP_AT = 90;

/** Who has the price on their head: the one in the lead, once they have BOUNTY_FROM points; nobody on a tie. */
export function leaderOf(scores: { id: number; score: number }[]): number | null {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  if (!sorted.length || sorted[0].score < BOUNTY_FROM || sorted[1]?.score === sorted[0].score) return null;
  return sorted[0].id;
}
/** Points for bringing down a bot; and the "player" bots count as when they kill someone. */
export const BOT_POINTS = 5;
export const BOTS = -1;
/** Seconds the winner is shown before the next round starts. */
export const ROUND_BREAK = 12;
/**
 * Turrets on the flags: a neutral one (shoots every player) on each at the start of a round; once
 * it is destroyed, whoever holds the flag can put up their own for TURRET_COST points, which shoots
 * only the others. Bringing one down is worth TURRET_POINTS.
 */
export const TURRET_COST = 60;
export const TURRET_POINTS = 20;
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
  { name: "A", at: crossingXZ(4, 4), y: 0, radius: 14 },
  { name: "B", at: crossingXZ(2, 2), y: 0, radius: 14 },
  { name: "C", at: crossingXZ(6, 2), y: 0, radius: 14 },
  { name: "D", at: crossingXZ(2, 6), y: 0, radius: 14 },
  { name: "E", at: crossingXZ(6, 6), y: 0, radius: 14 },
  { name: "F", at: [-75, 75], y: 31.64, radius: 15 },
  { name: "G", at: [-125, 25], y: 33.28, radius: 15 },
  { name: "H", at: [66.5, 66.5], y: 37.69, radius: 8.5 },
  { name: "I", at: [66.5, -83.5], y: 28.4, radius: 8.5 },
];

/** On the Moon the roof flags F–I come down onto the crossings round the middle, a cross about A. */
const MOON_CROSSINGS: [number, number][] = [[2, 4], [4, 2], [6, 4], [4, 6]];
const MOON_FLAGS: Flag[] = FLAGS.map((f, i) => (f.y ? { ...f, at: crossingXZ(MOON_CROSSINGS[i - 5][0], MOON_CROSSINGS[i - 5][1]), y: 0, radius: 14 } : f));

/** A map's flags (the same nine, by name; where they stand differs on the Moon). */
export function flagsFor(map: MapName) {
  return map === "moon" ? MOON_FLAGS : FLAGS;
}

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
/** As different from each other as they come: red, blue, yellow, green. */
export const COLORS = ["#ff2e2e", "#2f7bff", "#ffd60a", "#2bdc4a"];

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

/** Tripwires the server sets by itself near the flags (owner WORLD), and how soon a tripped one is replaced. */
export const WORLD = 0;
export const WORLD_MINES = 5;
export const WORLD_MINE_RESPAWN = 10;

/**
 * A tripwire near a flag: across a street leading into its crossing (sometimes a post standing up,
 * against flyers), or across its roof. Returns its two ends.
 */
export function worldWire(f: Flag): [[number, number, number], [number, number, number]] {
  const [x, z] = f.at;
  const r = (n: number) => Math.round(n * 100) / 100;
  if (f.y) {
    const cx = x + (Math.random() - 0.5) * f.radius, cz = z + (Math.random() - 0.5) * f.radius;
    const half = Math.min(f.radius * 0.9, WIRE_LENGTH / 2);
    const alongX = Math.random() < 0.5;
    return [
      [r(alongX ? cx - half : cx), r(f.y + 1.2), r(alongX ? cz : cz - half)],
      [r(alongX ? cx + half : cx), r(f.y + 1.2), r(alongX ? cz : cz + half)],
    ];
  }
  const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];
  const out = 18 + Math.random() * 12;
  const cx = x + dir[0] * out, cz = z + dir[1] * out;
  if (Math.random() < 0.3) {
    const side = (Math.random() - 0.5) * (ROAD - 4);
    const px = cx + dir[1] * side, pz = cz + dir[0] * side;
    return [[r(px), 0.3, r(pz)], [r(px), 14, r(pz)]];
  }
  const half = ROAD / 2 - 0.5;
  return [
    [r(cx - dir[1] * half), 1.2, r(cz - dir[0] * half)],
    [r(cx + dir[1] * half), 1.2, r(cz + dir[0] * half)],
  ];
}

/** Somewhere on a street between two crossings, off the middle line. */
export function streetSpot(map: MapName = "city"): [number, number] {
  const [lo, hi] = MAP_SPAN[map];
  const i = lo + Math.floor(Math.random() * (hi - lo + 1)), j = lo + Math.floor(Math.random() * (hi - lo));
  const [a, from] = crossingXZ(i, j);
  const along = from + ROAD / 2 + 2 + Math.random() * (STEP - ROAD - 4);
  const side = a + (Math.random() - 0.5) * (ROAD - 4);
  return Math.random() < 0.5 ? [side, along] : [along, side];
}

/** Where a coin goes: in the street, up in the air over it, or on a roof. */
export function coinSpot(map: MapName = "city"): [number, number, number] {
  // The jungle's roofs are mostly gone and the Moon's are domes: their coins are in the streets and up in the air.
  const r = Math.random() * (map === "jungle" || map === "moon" ? 0.65 : 1);
  if (r < 0.4) return [...streetSpot(map), 1.6];
  if (r < 0.65) return [...streetSpot(map), 8 + Math.random() * 22];
  const roofs = ROOFS.filter(([x, z]) => inSpan(map, x, z));
  const [x, z, h, hw, hd] = roofs[Math.floor(Math.random() * roofs.length)];
  return [x + (Math.random() - 0.5) * Math.max(0, hw * 2 - 3), z + (Math.random() - 0.5) * Math.max(0, hd * 2 - 3), h + 1.6];
}

export type Weapon = "laser" | "tesla" | "shawarma" | "minigun";
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
  /** The starting weapon on its left button. */
  w: string;
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
  /** The turret on it: WORLD (0) for a neutral one, a player's id for theirs, null for none. */
  turret: number | null;
}

export interface CrateInfo {
  id: number;
  x: number;
  z: number;
  weapon: Weapon;
  /** Dropped from the sky (the minigun pod) rather than lying about. */
  drop?: boolean;
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

/** One of the host's bots, as the others are told: [number, kind, x, y, z, yaw, shots since last time, aim x, y, z]. */
export type BotState = [number, string, number, number, number, number, number, number, number, number, number?];

export type ClientMessage =
  | { t: "join"; room: string | null; nick: string; skin: Skin; v: number; map?: MapName }
  | { t: "state"; s: PilotState }
  | { t: "hit"; to: number; dmg: number; head?: boolean }
  | { t: "stun"; to: number; s: number }
  | { t: "died"; by: number | null; head?: boolean }
  | { t: "rocket"; from: [number, number, number]; dir: [number, number, number] }
  | { t: "take"; crate: number }
  | { t: "grab"; item: number }
  | { t: "plant"; a: [number, number, number]; b: [number, number, number] }
  | { t: "trip"; mine: number }
  | { t: "bots"; list: BotState[] }
  | { t: "bothit"; bot: number; dmg: number }
  | { t: "bothurt"; to: number; dmg: number; by?: number }
  | { t: "turret"; flag: number }
  | { t: "turretdown"; flag: number; killer: number | null }
  | { t: "botkill"; killer: number }
  | { t: "look"; nick: string; skin: Skin };

export type ServerMessage =
  | { t: "welcome"; id: number; room: string; players: PlayerInfo[]; flags: FlagState[]; crates: CrateInfo[]; items: ItemInfo[]; mines: MineInfo[]; winner: number | null; host: number; map: MapName; night: boolean }
  | { t: "full" }
  | { t: "old" }
  | { t: "nope" }
  | { t: "joined"; player: PlayerInfo }
  | { t: "left"; id: number }
  | { t: "look"; id: number; nick: string; skin: Skin }
  | { t: "snap"; ps: Record<number, PilotState>; flags: FlagState[]; scores: Record<number, [number, number]>; quiet: number[] }
  | { t: "hurt"; from: number; dmg: number; head?: boolean }
  | { t: "stunned"; from: number; s: number }
  | { t: "kill"; killer: number | null; victim: number; head?: boolean; bounty?: boolean }
  | { t: "rocket"; id: number; from: [number, number, number]; dir: [number, number, number] }
  | { t: "captured"; flag: number; by: number }
  | { t: "crate"; crate: CrateInfo }
  | { t: "taken"; crate: number; by: number }
  | { t: "item"; item: ItemInfo }
  | { t: "grabbed"; item: number; by: number; kind: ItemInfo["kind"] }
  | { t: "mine"; mine: MineInfo }
  | { t: "boom"; mine: number; victim: number | null }
  | { t: "host"; id: number }
  | { t: "turretup"; flag: number; by: number }
  | { t: "turretdown"; flag: number; killer: number | null }
  | { t: "bots"; list: BotState[] }
  | { t: "bothit"; from: number; bot: number; dmg: number }
  | { t: "win"; id: number }
  | { t: "round"; map: MapName; night: boolean };
