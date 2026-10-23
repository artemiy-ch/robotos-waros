// Robot Wars multiplayer server: rooms of up to four players fighting over flags.
// Each client moves its own robot and reports it; the server relays what everyone needs to see,
// passes hits on to whoever was hit, and is the judge of flags, crates, kills and the score.
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  BASES,
  TURRET_COST,
  TURRET_POINTS,
  BOUNTY_POINTS,
  DROP_AT,
  HEADSHOT_POINTS,
  leaderOf,
  BOT_POINTS,
  BOTS,
  WORLD,
  WORLD_MINES,
  WORLD_MINE_RESPAWN,
  worldWire,
  CAPTURE_TIME,
  COIN_POINTS,
  COINS,
  ITEM_RESPAWN,
  MAX_MINES,
  WIRE_KITS,
  WIRE_LENGTH,
  inZone,
  coinSpot,
  streetSpot,
  type ItemInfo,
  type MineInfo,
  COLORS,
  CRATE_RESPAWN,
  CRATE_SPOTS,
  CRATES,
  FLAGS,
  flagsFor,
  KILL_POINTS,
  MAX_PLAYERS,
  MP_MAPS,
  basesFor,
  inSpan,
  type MapName,
  PROTOCOL,
  RECAPTURE_TIME,
  ROUND_BREAK,
  TARGET_SCORE,
  type ClientMessage,
  type CrateInfo,
  type FlagState,
  type PilotState,
  type PlayerInfo,
  type ServerMessage,
  type Weapon,
} from "../shared/mp.ts";

const PORT = Number(process.env.PORT ?? 2567);
const TICK = 1 / 20;
/** Biggest hit one message may carry (a rocket salvo, a slam), against cheating clients. */
const MAX_HIT = 60;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

interface Client {
  ws: WebSocket;
  info: PlayerInfo;
  state: PilotState | null;
  /** When its last state came in: a player whose tab is hidden stops sending, and holds no zone. */
  seen: number;
}
/** Milliseconds without news before a player stops counting in a zone. */
const STALE = 2000;

interface Room {
  code: string;
  clients: Map<number, Client>;
  flags: FlagState[];
  crates: CrateInfo[];
  /** Seconds left until a taken crate is replaced. */
  respawns: number[];
  /** Seconds of flag income banked towards the next point. */
  income: number;
  winner: number | null;
  breakT: number;
  nextId: number;
  nextCrate: number;
  items: ItemInfo[];
  /** Items picked up, waiting to come back: kind and seconds left. */
  itemRespawns: { kind: ItemInfo["kind"]; t: number }[];
  mines: MineInfo[];
  nextItem: number;
  nextMine: number;
  /** Whose game runs the bots: the longest in the room. */
  host: number;
  /** Seconds until each tripped tripwire of the server's own is set again somewhere. */
  wireRespawns: number[];
  /** The map this round is on, and whether it is the night round there (each map gets a day round, then a night one). */
  map: MapName;
  night: boolean;
  /** Seconds to this round's drop pod (below zero once it has come). */
  dropT: number;
}

const rooms = new Map<string, Room>();

const send = (ws: WebSocket, msg: ServerMessage) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};
const broadcast = (room: Room, msg: ServerMessage, except?: number) => {
  const data = JSON.stringify(msg);
  for (const [id, c] of room.clients) if (id !== except && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
};

function newCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

const freshFlags = (): FlagState[] => FLAGS.map(() => ({ owner: null, taker: null, progress: 0, contested: false, turret: WORLD }));

function createRoom(map: MapName): Room {
  const room: Room = {
    code: newCode(), clients: new Map(), flags: freshFlags(), crates: [], respawns: [], income: 0, winner: null, breakT: 0, nextId: 1, nextCrate: 1,
    items: [], itemRespawns: [], mines: [], nextItem: 1, nextMine: 1, host: 0, wireRespawns: [], dropT: DROP_AT, map, night: false,
  };
  for (let i = 0; i < WORLD_MINES; i++) addWorldMine(room, false);
  for (let i = 0; i < CRATES; i++) addCrate(room, false);
  for (let i = 0; i < COINS; i++) addItem(room, "coin", false);
  for (let i = 0; i < WIRE_KITS; i++) addItem(room, "wire", false);
  rooms.set(room.code, room);
  return room;
}

/** A crate somewhere on the streets, away from the flags, the bases and the other crates. */
function addCrate(room: Room, announce: boolean) {
  const clear = (x: number, z: number) =>
    inSpan(room.map, x, z) &&
    [...flagsFor(room.map).map((f) => f.at), ...basesFor(room.map)].every(([fx, fz]) => Math.hypot(fx - x, fz - z) > 25) &&
    room.crates.every((c) => Math.hypot(c.x - x, c.z - z) > 40);
  let spot = CRATE_SPOTS[Math.floor(Math.random() * CRATE_SPOTS.length)];
  for (let tries = 0; tries < 50 && !clear(...spot); tries++) spot = CRATE_SPOTS[Math.floor(Math.random() * CRATE_SPOTS.length)];
  // Lasers mostly; tesla guns and shawarma busters a quarter of the time each.
  const r = Math.random();
  const weapon: Weapon = r < 0.25 ? "tesla" : r < 0.5 ? "shawarma" : "laser";
  const crate = { id: room.nextCrate++, x: spot[0], z: spot[1], weapon };
  room.crates.push(crate);
  if (announce) broadcast(room, { t: "crate", crate });
}

/** A coin or a tripwire kit somewhere in the streets, not on top of another. */
function addItem(room: Room, kind: ItemInfo["kind"], announce: boolean) {
  // Coins anywhere, even up in the air and on roofs; tripwire kits in the streets.
  const pick = (): [number, number, number] => (kind === "coin" ? coinSpot(room.map) : [...streetSpot(room.map), 1.6]);
  let spot = pick();
  for (let tries = 0; tries < 30 && room.items.some((o) => Math.hypot(o.x - spot[0], o.z - spot[1], o.y - spot[2]) < 12); tries++) spot = pick();
  const item = { id: room.nextItem++, kind, x: spot[0], y: spot[2], z: spot[1] };
  room.items.push(item);
  if (announce) broadcast(room, { t: "item", item });
}

/** One of the server's own tripwires, near a random flag. */
function addWorldMine(room: Room, announce: boolean) {
  const flags = flagsFor(room.map);
  const [a, b] = worldWire(flags[Math.floor(Math.random() * flags.length)]);
  const mine = { id: room.nextMine++, owner: WORLD, a, b };
  room.mines.push(mine);
  if (announce) broadcast(room, { t: "mine", mine });
}

/** A fresh round: no winner, no flags held, nobody's points or tripwires (the server's own stay). */
/** A new map: the crates and items go and come back where they can be reached on it. */
function reseed(room: Room) {
  for (const c of room.crates) broadcast(room, { t: "taken", crate: c.id, by: 0 });
  for (const it of room.items) broadcast(room, { t: "grabbed", item: it.id, by: 0, kind: it.kind });
  room.crates = [];
  room.items = [];
  room.respawns = [];
  room.itemRespawns = [];
  for (let i = 0; i < CRATES; i++) addCrate(room, true);
  for (let i = 0; i < COINS; i++) addItem(room, "coin", true);
  for (let i = 0; i < WIRE_KITS; i++) addItem(room, "wire", true);
}

/** A fresh round; `next` moves on to the next map (after a win, not when a second player arrives). */
function newRound(room: Room, next = false) {
  // After a win: the same map by night, or after the night round the next map by day.
  if (next && !room.night) room.night = true;
  else if (next) {
    room.night = false;
    room.map = MP_MAPS[(MP_MAPS.indexOf(room.map) + 1) % MP_MAPS.length];
    reseed(room);
  }
  room.winner = null;
  room.dropT = DROP_AT;
  // Last round's pod, if nobody got it, goes.
  for (const c of room.crates.filter((k) => k.drop)) broadcast(room, { t: "taken", crate: c.id, by: 0 });
  room.crates = room.crates.filter((k) => !k.drop);
  room.flags = freshFlags();
  for (const c of room.clients.values()) c.info.score = c.info.kills = 0;
  for (const m of room.mines.filter((x) => x.owner !== WORLD)) broadcast(room, { t: "boom", mine: m.id, victim: null });
  room.mines = room.mines.filter((x) => x.owner === WORLD);
  broadcast(room, { t: "round", map: room.map, night: room.night });
}

const finite = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

function freeBase(room: Room) {
  const used = new Set([...room.clients.values()].map((c) => c.info.base));
  return BASES.findIndex((_, i) => !used.has(i));
}

function join(ws: WebSocket, msg: Extract<ClientMessage, { t: "join" }>): [Room, Client] | null {
  if (msg.v !== PROTOCOL) {
    send(ws, { t: "old" });
    return null;
  }
  let room: Room | undefined;
  if (msg.room) {
    room = rooms.get(msg.room.toUpperCase());
    if (!room) {
      send(ws, { t: "nope" });
      return null;
    }
  } else room = createRoom(MP_MAPS.includes(msg.map as MapName) ? (msg.map as MapName) : "city");
  if (room.clients.size >= MAX_PLAYERS) {
    send(ws, { t: "full" });
    return null;
  }
  const base = freeBase(room);
  const info: PlayerInfo = { id: room.nextId++, nick: msg.nick.slice(0, 16) || "Пилот", skin: msg.skin, color: COLORS[base], base, score: 0, kills: 0 };
  const client: Client = { ws, info, state: null, seen: 0 };
  room.clients.set(info.id, client);
  if (!room.clients.has(room.host)) room.host = info.id;
  send(ws, { t: "welcome", map: room.map, night: room.night, host: room.host, id: info.id, room: room.code, players: [...room.clients.values()].map((c) => c.info), flags: room.flags, crates: room.crates, items: room.items, mines: room.mines, winner: room.winner });
  broadcast(room, { t: "joined", player: info }, info.id);
  console.log(`${room.code}: ${info.nick} joined (${room.clients.size})`);
  // Someone to play against at last: the round so far was only practice.
  if (room.clients.size === 2) newRound(room);
  return [room, client];
}

function leave(room: Room, id: number) {
  room.clients.delete(id);
  for (const m of room.mines.filter((x) => x.owner === id)) {
    room.mines.splice(room.mines.indexOf(m), 1);
    broadcast(room, { t: "boom", mine: m.id, victim: null });
  }
  for (const f of room.flags) {
    if (f.owner === id) f.owner = null;
    if (f.turret === id) f.turret = null;
    if (f.taker === id) (f.taker = null), (f.progress = 0);
  }
  broadcast(room, { t: "left", id });
  if (!room.clients.size) return void rooms.delete(room.code);
  // The bots move to whoever has been in the room longest.
  if (room.host === id) {
    room.host = Math.min(...room.clients.keys());
    broadcast(room, { t: "host", id: room.host });
  }
}

function handle(room: Room, me: Client, msg: ClientMessage) {
  const id = me.info.id;
  switch (msg.t) {
    case "state":
      me.state = msg.s;
      me.seen = Date.now();
      break;
    case "hit": {
      const target = room.clients.get(msg.to);
      if (target && target !== me && room.winner === null) send(target.ws, { t: "hurt", from: id, dmg: Math.min(MAX_HIT, Math.max(0, msg.dmg)), head: !!msg.head });
      break;
    }
    case "stun": {
      const target = room.clients.get(msg.to);
      if (target && target !== me) send(target.ws, { t: "stunned", from: id, s: Math.min(3, msg.s) });
      break;
    }
    case "died": {
      if (msg.by === BOTS || msg.by === WORLD) {
        broadcast(room, { t: "kill", killer: msg.by, victim: id });
        break;
      }
      const killer = msg.by !== null && msg.by !== id ? room.clients.get(msg.by) : undefined;
      // The leader's head is worth more; a shot to the head adds a little.
      const bounty = !!killer && leaderOf([...room.clients.values()].map((c) => c.info)) === id;
      const head = !!killer && !!msg.head;
      if (killer && room.winner === null) {
        killer.info.kills++;
        killer.info.score += (bounty ? BOUNTY_POINTS : KILL_POINTS) + (head ? HEADSHOT_POINTS : 0);
      }
      broadcast(room, { t: "kill", killer: killer ? killer.info.id : null, victim: id, head, bounty });
      break;
    }
    case "rocket":
      broadcast(room, { t: "rocket", id, from: msg.from, dir: msg.dir }, id);
      break;
    case "take": {
      const i = room.crates.findIndex((c) => c.id === msg.crate);
      if (i < 0) break;
      const [taken] = room.crates.splice(i, 1);
      if (!taken.drop) room.respawns.push(CRATE_RESPAWN);
      broadcast(room, { t: "taken", crate: msg.crate, by: id });
      break;
    }
    case "grab": {
      const i = room.items.findIndex((it) => it.id === msg.item);
      if (i < 0) break;
      const [item] = room.items.splice(i, 1);
      room.itemRespawns.push({ kind: item.kind, t: ITEM_RESPAWN });
      if (item.kind === "coin" && room.winner === null) me.info.score += COIN_POINTS;
      broadcast(room, { t: "grabbed", item: item.id, by: id, kind: item.kind });
      break;
    }
    case "plant": {
      if (!finite(msg.a) || !finite(msg.b) || Math.hypot(msg.a[0] - msg.b[0], msg.a[1] - msg.b[1], msg.a[2] - msg.b[2]) > WIRE_LENGTH + 1) break;
      // Too many set: the oldest one goes quietly.
      const own = room.mines.filter((m) => m.owner === id);
      if (own.length >= MAX_MINES) {
        room.mines.splice(room.mines.indexOf(own[0]), 1);
        broadcast(room, { t: "boom", mine: own[0].id, victim: null });
      }
      const mine = { id: room.nextMine++, owner: id, a: msg.a, b: msg.b };
      room.mines.push(mine);
      broadcast(room, { t: "mine", mine });
      break;
    }
    case "trip": {
      const i = room.mines.findIndex((m) => m.id === msg.mine);
      if (i < 0) break;
      const [gone] = room.mines.splice(i, 1);
      if (gone.owner === WORLD) room.wireRespawns.push(WORLD_MINE_RESPAWN);
      broadcast(room, { t: "boom", mine: msg.mine, victim: id });
      break;
    }
    case "bots":
      if (id === room.host && Array.isArray(msg.list)) broadcast(room, { t: "bots", list: msg.list.slice(0, 40) }, id);
      break;
    case "bothit": {
      const host = room.clients.get(room.host);
      if (host && host !== me) send(host.ws, { t: "bothit", from: id, bot: msg.bot, dmg: Math.min(MAX_HIT, Math.max(0, msg.dmg)) });
      break;
    }
    case "bothurt": {
      const target = room.clients.get(msg.to);
      // A player's turret's shot counts as theirs.
      const from = msg.by !== undefined && room.clients.has(msg.by) ? msg.by : BOTS;
      if (id === room.host && target && target !== me) send(target.ws, { t: "hurt", from, dmg: Math.min(MAX_HIT, Math.max(0, msg.dmg)) });
      break;
    }
    case "turret": {
      // Our own turret on our flag, if there is none and we can pay for it.
      const f = room.flags[msg.flag];
      if (!f || f.owner !== id || f.turret !== null || me.info.score < TURRET_COST || room.winner !== null) break;
      me.info.score -= TURRET_COST;
      f.turret = id;
      broadcast(room, { t: "turretup", flag: msg.flag, by: id });
      break;
    }
    case "turretdown": {
      const f = room.flags[msg.flag];
      if (id !== room.host || !f || f.turret === null) break;
      const owner = f.turret;
      f.turret = null;
      const killer = msg.killer !== null ? room.clients.get(msg.killer) : undefined;
      if (killer && killer.info.id !== owner && room.winner === null) killer.info.score += TURRET_POINTS;
      broadcast(room, { t: "turretdown", flag: msg.flag, killer: killer ? killer.info.id : null });
      break;
    }
    case "botkill": {
      const killer = room.clients.get(msg.killer);
      if (id === room.host && killer && room.winner === null) killer.info.score += BOT_POINTS;
      break;
    }
    case "look":
      me.info.nick = msg.nick.slice(0, 16) || "Пилот";
      me.info.skin = msg.skin;
      broadcast(room, { t: "look", id, nick: me.info.nick, skin: me.info.skin }, id);
      break;
  }
}

/** Flags: one player alone in a zone takes it; two or more hold each other up. */
function updateFlags(room: Room, dt: number) {
  flagsFor(room.map).forEach((flag, i) => {
    const f = room.flags[i];
    const now = Date.now();
    const inside = [...room.clients.values()].filter((c) => {
      const s = c.state;
      return s && now - c.seen < STALE && s.al && inZone(flag, s.x, s.y, s.z);
    });
    f.contested = inside.length > 1;
    if (f.contested) return;
    const who = inside[0]?.info.id ?? null;
    // A turret that isn't yours holds the flag: bring it down first.
    if (who === null || who === f.owner || (f.turret !== null && f.turret !== who)) {
      f.progress = Math.max(0, f.progress - dt / CAPTURE_TIME);
      if (f.progress === 0) f.taker = null;
      return;
    }
    if (f.taker !== who) {
      f.taker = who;
      f.progress = 0;
    }
    f.progress += dt / (f.owner === null ? CAPTURE_TIME : RECAPTURE_TIME);
    if (f.progress >= 1) {
      f.owner = who;
      f.taker = null;
      f.progress = 0;
      broadcast(room, { t: "captured", flag: i, by: who });
    }
  });
}

function tick(room: Room, dt: number) {
  if (room.winner !== null) {
    room.breakT -= dt;
    if (room.breakT <= 0) {
      newRound(room, true);
    }
  } else {
    updateFlags(room, dt);
    // Every held flag pays its owner a point a second.
    room.income += dt;
    if (room.income >= 1) {
      room.income -= 1;
      for (const f of room.flags) {
        const owner = f.owner !== null ? room.clients.get(f.owner) : undefined;
        if (owner) owner.info.score++;
      }
    }
    const best = [...room.clients.values()].sort((a, b) => b.info.score - a.info.score)[0];
    if (best && best.info.score >= TARGET_SCORE) {
      room.winner = best.info.id;
      room.breakT = ROUND_BREAK;
      broadcast(room, { t: "win", id: best.info.id });
    }
  }
  // Once a round a pod with a minigun comes down on a street somewhere.
  if (room.dropT > 0 && room.winner === null) {
    room.dropT -= dt;
    if (room.dropT <= 0) {
      const [x, z] = streetSpot(room.map);
      const crate = { id: room.nextCrate++, x, z, weapon: "minigun" as const, drop: true };
      room.crates.push(crate);
      broadcast(room, { t: "crate", crate });
    }
  }
  for (let i = room.wireRespawns.length - 1; i >= 0; i--) {
    room.wireRespawns[i] -= dt;
    if (room.wireRespawns[i] > 0) continue;
    room.wireRespawns.splice(i, 1);
    addWorldMine(room, true);
  }
  for (let i = room.itemRespawns.length - 1; i >= 0; i--) {
    const r = room.itemRespawns[i];
    r.t -= dt;
    if (r.t > 0) continue;
    room.itemRespawns.splice(i, 1);
    addItem(room, r.kind, true);
  }
  for (let i = room.respawns.length - 1; i >= 0; i--) {
    room.respawns[i] -= dt;
    if (room.respawns[i] > 0) continue;
    room.respawns.splice(i, 1);
    addCrate(room, true);
  }
  const ps: Record<number, PilotState> = {};
  const scores: Record<number, [number, number]> = {};
  // Players whose game has stopped sending (a hidden tab, a lost connection).
  const quiet: number[] = [];
  const now = Date.now();
  for (const [id, c] of room.clients) {
    if (c.state) ps[id] = c.state;
    if (now - c.seen > STALE) quiet.push(id);
    scores[id] = [c.info.score, c.info.kills];
  }
  broadcast(room, { t: "snap", ps, flags: room.flags, scores, quiet });
}

const http = createServer((req, res) => {
  // Kept out of search engines: a robots.txt that says no, and the same in every reply.
  const headers = { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" };
  res.writeHead(200, headers);
  // Otherwise Fly's health check, and a sign of life for anyone opening the address.
  res.end(req.url === "/robots.txt" ? "User-agent: *\nDisallow: /\n" : "ok\n");
});
const wss = new WebSocketServer({ server: http });

/** Connections that answered the last ping; one that misses a ping is dead and dropped. */
const alive = new WeakSet<WebSocket>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 10_000);

wss.on("connection", (ws) => {
  let room: Room | null = null;
  let me: Client | null = null;
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));
  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!room || !me) {
      if (msg.t !== "join") return;
      const joined = join(ws, msg);
      if (joined) [room, me] = joined;
      return;
    }
    // A bad message from one game mustn't bring the server (and every room) down.
    try {
      handle(room, me, msg);
    } catch (err) {
      console.error(err);
    }
  });
  ws.on("close", () => {
    if (room && me) {
      console.log(`${room.code}: ${me.info.nick} left`);
      leave(room, me.info.id);
    }
  });
});

// Timers run on the real time between ticks, which a busy machine stretches.
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  for (const room of rooms.values()) {
    try {
      tick(room, dt);
    } catch (err) {
      console.error(err);
    }
  }
}, TICK * 1000);

http.listen(PORT, () => console.log(`Robot Wars server on :${PORT}`));
