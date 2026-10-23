// Robot Wars multiplayer server: rooms of up to four players fighting over flags.
// Each client moves its own robot and reports it; the server relays what everyone needs to see,
// passes hits on to whoever was hit, and is the judge of flags, crates, kills and the score.
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  BASES,
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
  KILL_POINTS,
  MAX_PLAYERS,
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

const freshFlags = (): FlagState[] => FLAGS.map(() => ({ owner: null, taker: null, progress: 0, contested: false }));

function createRoom(): Room {
  const room: Room = {
    code: newCode(), clients: new Map(), flags: freshFlags(), crates: [], respawns: [], income: 0, winner: null, breakT: 0, nextId: 1, nextCrate: 1,
    items: [], itemRespawns: [], mines: [], nextItem: 1, nextMine: 1,
  };
  for (let i = 0; i < CRATES; i++) addCrate(room, false);
  for (let i = 0; i < COINS; i++) addItem(room, "coin", false);
  for (let i = 0; i < WIRE_KITS; i++) addItem(room, "wire", false);
  rooms.set(room.code, room);
  return room;
}

/** A crate somewhere on the streets, away from the flags, the bases and the other crates. */
function addCrate(room: Room, announce: boolean) {
  const clear = (x: number, z: number) =>
    [...FLAGS.map((f) => f.at), ...BASES].every(([fx, fz]) => Math.hypot(fx - x, fz - z) > 25) &&
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
  const pick = (): [number, number, number] => (kind === "coin" ? coinSpot() : [...streetSpot(), 1.6]);
  let spot = pick();
  for (let tries = 0; tries < 30 && room.items.some((o) => Math.hypot(o.x - spot[0], o.z - spot[1], o.y - spot[2]) < 12); tries++) spot = pick();
  const item = { id: room.nextItem++, kind, x: spot[0], y: spot[2], z: spot[1] };
  room.items.push(item);
  if (announce) broadcast(room, { t: "item", item });
}

const finite = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

function freeBase(room: Room) {
  const used = new Set([...room.clients.values()].map((c) => c.info.base));
  return BASES.findIndex((_, i) => !used.has(i));
}

function join(ws: WebSocket, msg: Extract<ClientMessage, { t: "join" }>): [Room, Client] | null {
  let room: Room | undefined;
  if (msg.room) {
    room = rooms.get(msg.room.toUpperCase());
    if (!room) {
      send(ws, { t: "nope" });
      return null;
    }
  } else room = createRoom();
  if (room.clients.size >= MAX_PLAYERS) {
    send(ws, { t: "full" });
    return null;
  }
  const base = freeBase(room);
  const info: PlayerInfo = { id: room.nextId++, nick: msg.nick.slice(0, 16) || "Пилот", skin: msg.skin, color: COLORS[base], base, score: 0, kills: 0 };
  const client: Client = { ws, info, state: null, seen: 0 };
  room.clients.set(info.id, client);
  send(ws, { t: "welcome", id: info.id, room: room.code, players: [...room.clients.values()].map((c) => c.info), flags: room.flags, crates: room.crates, items: room.items, mines: room.mines, winner: room.winner });
  broadcast(room, { t: "joined", player: info }, info.id);
  console.log(`${room.code}: ${info.nick} joined (${room.clients.size})`);
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
    if (f.taker === id) (f.taker = null), (f.progress = 0);
  }
  broadcast(room, { t: "left", id });
  if (!room.clients.size) rooms.delete(room.code);
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
      if (target && target !== me && room.winner === null) send(target.ws, { t: "hurt", from: id, dmg: Math.min(MAX_HIT, Math.max(0, msg.dmg)) });
      break;
    }
    case "stun": {
      const target = room.clients.get(msg.to);
      if (target && target !== me) send(target.ws, { t: "stunned", from: id, s: Math.min(3, msg.s) });
      break;
    }
    case "died": {
      const killer = msg.by !== null && msg.by !== id ? room.clients.get(msg.by) : undefined;
      if (killer && room.winner === null) {
        killer.info.kills++;
        killer.info.score += KILL_POINTS;
      }
      broadcast(room, { t: "kill", killer: killer ? killer.info.id : null, victim: id });
      break;
    }
    case "rocket":
      broadcast(room, { t: "rocket", id, from: msg.from, dir: msg.dir }, id);
      break;
    case "take": {
      const i = room.crates.findIndex((c) => c.id === msg.crate);
      if (i < 0) break;
      room.crates.splice(i, 1);
      room.respawns.push(CRATE_RESPAWN);
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
      room.mines.splice(i, 1);
      broadcast(room, { t: "boom", mine: msg.mine, victim: id });
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
  FLAGS.forEach((flag, i) => {
    const f = room.flags[i];
    const now = Date.now();
    const inside = [...room.clients.values()].filter((c) => {
      const s = c.state;
      return s && now - c.seen < STALE && s.al && inZone(flag, s.x, s.y, s.z);
    });
    f.contested = inside.length > 1;
    if (f.contested) return;
    const who = inside[0]?.info.id ?? null;
    if (who === null || who === f.owner) {
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
      room.winner = null;
      room.flags = freshFlags();
      for (const c of room.clients.values()) c.info.score = c.info.kills = 0;
      for (const m of room.mines) broadcast(room, { t: "boom", mine: m.id, victim: null });
      room.mines = [];
      broadcast(room, { t: "round" });
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
  for (const [id, c] of room.clients) {
    if (c.state) ps[id] = c.state;
    scores[id] = [c.info.score, c.info.kills];
  }
  broadcast(room, { t: "snap", ps, flags: room.flags, scores });
}

const http = createServer((req, res) => {
  // Kept out of search engines: a robots.txt that says no, and the same in every reply.
  const headers = { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" };
  res.writeHead(200, headers);
  // Otherwise Fly's health check, and a sign of life for anyone opening the address.
  res.end(req.url === "/robots.txt" ? "User-agent: *\nDisallow: /\n" : "ok\n");
});
const wss = new WebSocketServer({ server: http });

wss.on("connection", (ws) => {
  let room: Room | null = null;
  let me: Client | null = null;
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
    handle(room, me, msg);
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
  for (const room of rooms.values()) tick(room, dt);
}, TICK * 1000);

http.listen(PORT, () => console.log(`Robot Wars server on :${PORT}`));
