import { DurableObject } from "cloudflare:workers";
import { createResumeToken, isResumeToken, isRoomId, sha256Hex } from "../shared/ids";
import type { IceServer } from "../shared/ice-servers";
import { parseClientMessage, PROTOCOL_VERSION, type ClientMessage } from "../shared/protocol";
import {
  admitPeer,
  leavePeer,
  linkGen,
  newRoom,
  parseCapacity,
  rebuildLink,
  relaySignal,
  touchPeer,
  type RoomState,
} from "../shared/room-state";
import { logEvent } from "./log";
import { fetchTurnIceServers, turnRequested } from "./turn";

const notedCloses = new WeakSet<WebSocket>();

interface SocketAttachment {
  role: "pending" | "peer";
  peerId?: string;
  at: number;
  /** Messages in the current window. Two numbers, so the attachment stays small however busy the socket is. */
  windowStart: number;
  windowCount: number;
  expiresAt: number;
  roomId: string;
  /** How many people the room holds: two, or a conference. The index decides, not the client. */
  capacity: number;
}

interface TurnCache {
  mode: "on" | "error" | "off";
  iceServers: IceServer[];
  expiresAt: number;
}

/** Sockets beyond the seats: a returning peer opens its new one before the old one is closed. */
const SPARE_SOCKETS = 2;
const MESSAGE_WINDOW_MS = 10_000;
// A Mac with several interfaces plus TURN trickles dozens of candidates per ICE restart, to every peer it is linked with.
const MESSAGE_LIMIT_PER_LINK = 100;
const INDEX_TOUCH_MS = 60 * 60 * 1000;

export class RoomDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "expected-websocket" }, { status: 426 });
    }
    const expiry = Number(request.headers.get("x-wirecall-expires"));
    const roomId = request.headers.get("x-wirecall-room") ?? "";
    const capacity = parseCapacity(request.headers.get("x-wirecall-capacity"));
    if (!Number.isFinite(expiry) || expiry <= Date.now() || !isRoomId(roomId)) {
      return Response.json({ error: "expired" }, { status: 410 });
    }
    this.ensureSchema();
    if (this.ctx.getWebSockets().length >= capacity + SPARE_SOCKETS) {
      return Response.json({ error: "room-full" }, { status: 409 });
    }
    this.rememberRoom(roomId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      role: "pending",
      at: Date.now(),
      windowStart: 0,
      windowCount: 0,
      expiresAt: expiry,
      roomId,
      capacity,
    } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      ws.close(1003, "bad-message");
      return;
    }
    const attachment = readAttachment(ws);
    const now = Date.now();
    if (now - attachment.windowStart >= MESSAGE_WINDOW_MS) {
      attachment.windowStart = now;
      attachment.windowCount = 0;
    }
    attachment.windowCount += 1;
    ws.serializeAttachment(attachment);
    if (attachment.windowCount > MESSAGE_LIMIT_PER_LINK * (attachment.capacity - 1)) {
      ws.close(1008, "rate");
      return;
    }
    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      logEvent("signal-rejected", { code: parsed.code, bytes: message.length });
      ws.close(1008, parsed.code);
      return;
    }
    if (attachment.role !== "peer" || !attachment.peerId) {
      if (parsed.message.type !== "hello") {
        ws.close(1008, "hello-first");
        return;
      }
      await this.admit(ws, attachment, parsed.message);
      return;
    }
    this.handlePeer(ws, attachment, parsed.message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (notedCloses.has(ws)) return;
    notedCloses.add(ws);
    const attachment = readAttachment(ws);
    if (attachment.role !== "peer" || !attachment.peerId) return;
    if (replacedByNewerSocket(this.ctx.getWebSockets(), attachment.peerId, ws)) return;
    const state = this.readRoom();
    if (!state || !state.peers.some((peer) => peer.peerId === attachment.peerId)) return;
    // The seat and resume hash stay so the same person can hello again. Hangup and the stale sweep remove it.
    // gone: false tells the other side to keep its media connection: only the signaling socket is away.
    this.sendToPeers({ type: "peer-left", peerId: attachment.peerId, gone: false, peerCount: state.peers.length }, attachment.peerId);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close(1001, "dropped");
    logEvent("socket-closed", { peers: state.peers.length });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    logEvent("socket-error");
    ws.close(1011, "error");
  }

  async alarm(): Promise<void> {
    const state = this.readRoom();
    if (!state) return;
    if (Date.now() >= state.expiresAt) {
      for (const socket of this.ctx.getWebSockets()) socket.close(4004, "expired");
      this.ctx.storage.sql.exec("DELETE FROM room");
      this.ctx.storage.sql.exec("DELETE FROM turn_cache");
      await this.ctx.storage.deleteAlarm();
      logEvent("room-expired");
      return;
    }
    await this.schedule(state);
  }

  private async admit(
    ws: WebSocket,
    attachment: SocketAttachment,
    hello: Extract<ClientMessage, { type: "hello" }>,
  ): Promise<void> {
    const ice = await this.iceServers();
    const resumeHash = hello.resume && isResumeToken(hello.resume) ? await sha256Hex(hello.resume) : null;
    const resumeToken = createResumeToken();
    const newResumeHash = await sha256Hex(resumeToken);
    const now = Date.now();
    const ttlMs = ttlFromEnv(this.env);
    // Hashes are ready before the read. The decision about the seat and the write stay synchronous.
    let state = this.readRoom() ?? newRoom(now, Math.max(ttlMs, attachment.expiresAt - now));
    if (attachment.expiresAt > state.expiresAt) state = { ...state, expiresAt: attachment.expiresAt };
    const admitted = admitPeer(state, {
      now,
      ttlMs,
      resumeHash,
      newPeerId: crypto.randomUUID(),
      newResumeHash,
      livePeerIds: livePeers(this.ctx.getWebSockets(), ws),
      capacity: attachment.capacity,
      keep: hello.keep ?? null,
    });
    if (!admitted.ok) {
      this.writeRoom(admitted.state);
      const code = admitted.code === "room-full" ? 4000 : admitted.code === "rate" ? 1008 : 4004;
      ws.close(code, admitted.code);
      logEvent("admit-rejected", { code: admitted.code });
      return;
    }
    this.writeRoom(admitted.state);
    ws.serializeAttachment({ ...attachment, role: "peer", peerId: admitted.peerId });
    if (admitted.resumed) closeOtherSockets(this.ctx.getWebSockets(), admitted.peerId, ws);
    const online = livePeers(this.ctx.getWebSockets(), ws);
    this.send(ws, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      peerId: admitted.peerId,
      capacity: attachment.capacity,
      peerCount: admitted.peerCount,
      expiresAt: admitted.expiresAt,
      resumed: admitted.resumed,
      peers: admitted.links.map((link) => ({ peerId: link.peerId, gen: link.gen, polite: link.polite, online: online.includes(link.peerId) })),
      turnMode: ice.mode,
      iceServers: ice.iceServers,
      resumeToken,
    });
    for (const link of admitted.links) {
      // An unchanged gen means the returning peer kept its connection and the other side keeps its own too.
      // A new gen makes the two start a fresh one, with TURN credentials that are still valid.
      this.sendToPeer(link.peerId, {
        type: admitted.resumed ? "peer-back" : "peer-joined",
        peerId: admitted.peerId,
        gen: link.gen,
        polite: !link.polite,
        peerCount: admitted.peerCount,
        turnMode: ice.mode,
        iceServers: ice.iceServers,
      });
    }
    logEvent("peer-joined", { peers: admitted.peerCount, resumed: admitted.resumed, turnMode: ice.mode });
    await this.schedule(admitted.state);
    this.touchIndex(attachment.roomId, admitted.expiresAt, true);
  }

  private handlePeer(ws: WebSocket, attachment: SocketAttachment, message: ClientMessage): void {
    const peerId = attachment.peerId;
    if (!peerId) {
      ws.close(1008, "hello-first");
      return;
    }
    const now = Date.now();
    const ttlMs = ttlFromEnv(this.env);
    const state = this.readRoom();
    if (!state) {
      ws.close(4004, "expired");
      return;
    }
    const livePeerIds = livePeers(this.ctx.getWebSockets(), null);
    if (message.type === "ping") {
      const touched = touchPeer(state, peerId, now, ttlMs, livePeerIds);
      this.writeRoom(touched.state);
      for (const removed of touched.removedPeerIds) {
        closePeerSockets(this.ctx.getWebSockets(), removed);
        this.sendToPeers({ type: "peer-left", peerId: removed, gone: true, peerCount: touched.state.peers.length });
      }
      if (!touched.known) {
        ws.close(4004, "expired");
        return;
      }
      this.send(ws, { type: "pong" });
      this.touchIndex(attachment.roomId, touched.state.expiresAt, false);
      return;
    }
    if (message.type === "hangup") {
      const left = leavePeer(state, peerId);
      this.writeRoom(left.state);
      this.sendToPeers({ type: "peer-left", peerId, gone: true, peerCount: left.peerCount }, peerId);
      ws.close(1000, "hangup");
      return;
    }
    if (message.type === "restart") {
      // The side that may not offer asks the offering side for an ICE restart, and gets an ack back.
      if (linkGen(state, peerId, message.to) === message.gen) {
        this.sendToPeer(message.to, { type: "restart", from: peerId, gen: message.gen, ack: message.ack });
      }
      return;
    }
    if (message.type === "rebuild") {
      this.ctx.waitUntil(this.rebuild(peerId, message.to, message.gen));
      return;
    }
    if (message.type !== "signal") {
      ws.close(1008, "bad-message");
      return;
    }
    const relayed = relaySignal(state, {
      now,
      ttlMs,
      fromPeerId: peerId,
      toPeerId: message.to,
      gen: message.gen,
      livePeerIds,
    });
    if (!relayed.ok) {
      ws.close(1008, relayed.code);
      return;
    }
    this.writeRoom(relayed.state);
    if (relayed.deliver) {
      this.sendToPeer(message.to, { type: "signal", from: peerId, kind: message.kind, payload: message.payload, gen: message.gen });
    }
    logEvent("signal", { kind: message.kind, bytes: message.payload.length, stale: !relayed.deliver });
    this.touchIndex(attachment.roomId, relayed.state.expiresAt, false);
  }

  private async rebuild(fromPeerId: string, toPeerId: string, gen: number): Promise<void> {
    const ice = await this.iceServers();
    const state = this.readRoom();
    if (!state) return;
    const next = rebuildLink(state, fromPeerId, toPeerId, gen);
    // A request for an older generation is the second of two simultaneous ones. The pair has already rebuilt.
    if (!next.bumped) return;
    this.writeRoom(next.state);
    const fresh = { type: "rebuild", gen: next.gen, peerCount: next.state.peers.length, turnMode: ice.mode, iceServers: ice.iceServers };
    // Only these two start over. Everyone else in the room keeps talking on the connections they have.
    this.sendToPeer(fromPeerId, { ...fresh, peerId: toPeerId });
    this.sendToPeer(toPeerId, { ...fresh, peerId: fromPeerId });
    logEvent("room-rebuild", { peers: next.state.peers.length });
  }

  private async iceServers(): Promise<TurnCache> {
    const cached = this.readTurn();
    const now = Date.now();
    if (cached && cached.expiresAt > now + 60_000) return cached;
    const fetched = await fetchTurnIceServers(this.env);
    const expiresAt = fetched.mode === "on" ? now + 50 * 60 * 1000 : now + 30_000;
    const cache: TurnCache = { mode: fetched.mode, iceServers: fetched.iceServers, expiresAt };
    this.writeTurn(cache);
    if (fetched.mode === "error") logEvent("turn-unavailable", { requested: turnRequested(this.env) });
    return cache;
  }

  private touchIndex(roomId: string, expiresAt: number, force: boolean): void {
    if (!isRoomId(roomId)) return;
    const now = Date.now();
    const previous = this.indexTouchedAt();
    if (!force && now - previous < INDEX_TOUCH_MS) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO runtime (id, room_id, index_touch) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, index_touch = excluded.index_touch",
      roomId,
      now,
    );
    const index = this.env.ROOM_INDEX.getByName("index");
    this.ctx.waitUntil(
      index.touch(roomId, expiresAt, now).then(
        () => undefined,
        () => logEvent("index-touch-failed"),
      ),
    );
  }

  private rememberRoom(roomId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO runtime (id, room_id, index_touch) VALUES (1, ?, COALESCE((SELECT index_touch FROM runtime WHERE id = 1), 0)) ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id",
      roomId,
    );
  }

  private indexTouchedAt(): number {
    const row = this.ctx.storage.sql.exec<{ index_touch: number }>("SELECT index_touch FROM runtime WHERE id = 1").toArray()[0];
    return row?.index_touch ?? 0;
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turn_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL,
        body TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        room_id TEXT NOT NULL,
        index_touch INTEGER NOT NULL
      );
      -- Seats of the two-person protocol. Its pages cannot join any more, so nothing reads these.
      DROP TABLE IF EXISTS meta;
      DROP TABLE IF EXISTS peers;
      DROP TABLE IF EXISTS signals;
      DROP TABLE IF EXISTS session;
    `);
  }

  private readRoom(): RoomState | null {
    this.ensureSchema();
    const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM room WHERE id = 1").toArray()[0];
    if (!row) return null;
    return JSON.parse(row.body) as RoomState;
  }

  /** The whole room is one small row: a handful of seats and the generation of each pair. */
  private writeRoom(state: RoomState): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO room (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      JSON.stringify(state),
    );
  }

  private readTurn(): TurnCache | null {
    const row = this.ctx.storage.sql
      .exec<{ mode: "on" | "error" | "off"; body: string; expires_at: number }>(
        "SELECT mode, body, expires_at FROM turn_cache WHERE id = 1",
      )
      .toArray()[0];
    if (!row) return null;
    const parsed = JSON.parse(row.body) as { iceServers?: IceServer[] };
    return { mode: row.mode, iceServers: parsed.iceServers ?? [], expiresAt: row.expires_at };
  }

  private writeTurn(cache: TurnCache): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO turn_cache (id, mode, body, expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, body = excluded.body, expires_at = excluded.expires_at`,
      cache.mode,
      JSON.stringify({ iceServers: cache.iceServers }),
      cache.expiresAt,
    );
  }

  private sendToPeers(message: object, exceptPeerId?: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment.role !== "peer" || !attachment.peerId || attachment.peerId === exceptPeerId) continue;
      this.send(socket, message);
    }
  }

  private sendToPeer(peerId: string, message: object): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment.role === "peer" && attachment.peerId === peerId) this.send(socket, message);
    }
  }

  private send(ws: WebSocket, message: object): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  private async schedule(state: RoomState): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === state.expiresAt) return;
    await this.ctx.storage.setAlarm(state.expiresAt);
  }
}

function ttlFromEnv(env: Env): number {
  const parsed = Number(env.ROOM_TTL_SECONDS);
  const seconds = Number.isFinite(parsed) ? parsed : 1_209_600;
  return Math.min(Math.max(seconds, 3600), 30 * 24 * 3600) * 1000;
}

function readAttachment(ws: WebSocket): SocketAttachment {
  const value = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
  if (!value || (value.role !== "pending" && value.role !== "peer")) {
    return { role: "pending", at: Date.now(), windowStart: 0, windowCount: 0, expiresAt: 0, roomId: "", capacity: parseCapacity(undefined) };
  }
  return {
    role: value.role,
    peerId: value.peerId,
    at: value.at ?? Date.now(),
    windowStart: value.windowStart ?? 0,
    windowCount: value.windowCount ?? 0,
    expiresAt: value.expiresAt ?? 0,
    roomId: value.roomId ?? "",
    capacity: parseCapacity(value.capacity),
  };
}

function livePeers(sockets: readonly WebSocket[], except: WebSocket | null): string[] {
  const ids: string[] = [];
  for (const socket of sockets) {
    if (socket === except || socket.readyState !== WebSocket.OPEN) continue;
    const attachment = readAttachment(socket);
    if (attachment.role === "peer" && attachment.peerId) ids.push(attachment.peerId);
  }
  return ids;
}

function closeOtherSockets(sockets: readonly WebSocket[], peerId: string, keep: WebSocket): void {
  for (const socket of sockets) {
    if (socket === keep) continue;
    if (readAttachment(socket).peerId === peerId) socket.close(4002, "replaced");
  }
}

function closePeerSockets(sockets: readonly WebSocket[], peerId: string): void {
  for (const socket of sockets) {
    if (readAttachment(socket).peerId === peerId) socket.close(4004, "stale");
  }
}

function replacedByNewerSocket(sockets: readonly WebSocket[], peerId: string, closed: WebSocket): boolean {
  return sockets.some((socket) => {
    if (socket === closed || socket.readyState !== WebSocket.OPEN) return false;
    return readAttachment(socket).peerId === peerId;
  });
}
