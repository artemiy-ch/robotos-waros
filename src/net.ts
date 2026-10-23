import { PROTOCOL, type ClientMessage, type MapName, type ServerMessage, type Skin } from "../shared/mp";

/** Where the multiplayer server is: VITE_MP_SERVER when built for the web, the local one in development. */
export const SERVER_URL: string = import.meta.env.VITE_MP_SERVER ?? `ws://${location.hostname || "localhost"}:2567`;

/** The connection to the multiplayer server. */
export class Net {
  private ws: WebSocket;
  /** Hits on each player since the last flush, so a laser doesn't send sixty messages a second. */
  private hits = new Map<number, number>();
  /** Players hit in the head since the last flush. */
  private heads = new Set<number>();
  closed = false;

  constructor(onMessage: (msg: ServerMessage) => void, onClose: (reason: string) => void) {
    this.ws = new WebSocket(SERVER_URL);
    this.ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error(err);
      }
    };
    this.ws.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      onClose("Связь с сервером потеряна");
    };
    this.ws.onerror = () => {
      if (this.closed) return;
      this.closed = true;
      onClose("Сервер недоступен");
    };
  }

  /** Joins a room by code, or makes a new one (room null). */
  join(room: string | null, nick: string, skin: Skin, map: MapName) {
    const go = () => this.send({ t: "join", room, nick, skin, v: PROTOCOL, map });
    if (this.ws.readyState === WebSocket.OPEN) go();
    else this.ws.addEventListener("open", go, { once: true });
  }

  send(msg: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  hit(to: number, dmg: number, head = false) {
    this.hits.set(to, (this.hits.get(to) ?? 0) + dmg);
    if (head) this.heads.add(to);
  }

  /** Sends the hits saved up since last time. */
  flush() {
    for (const [to, dmg] of this.hits) if (dmg > 0) this.send({ t: "hit", to, dmg: Math.round(dmg * 100) / 100, head: this.heads.has(to) || undefined });
    this.hits.clear();
    this.heads.clear();
  }

  close() {
    this.closed = true;
    this.ws.close();
  }
}
