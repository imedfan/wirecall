import { DurableObject } from "cloudflare:workers";
import { createResumeToken, isResumeToken, isRoomId, sha256Hex } from "../shared/ids";
import type { IceServer } from "../shared/ice-servers";
import { parseClientMessage, type ClientMessage, type SignalKind } from "../shared/protocol";
import { bumpRate } from "../shared/rate";
import {
  admitPeer,
  leavePeer,
  newRoom,
  relaySignal,
  touchPeer,
  type QueuedSignal,
  type RoomState,
} from "../shared/room-state";
import { logEvent } from "./log";
import { fetchTurnIceServers, turnRequested } from "./turn";

interface SocketAttachment {
  role: "pending" | "peer";
  peerId?: string;
  at: number;
  stamps: number[];
  expiresAt: number;
  roomId: string;
}

interface TurnCache {
  mode: "on" | "error" | "off";
  iceServers: IceServer[];
  expiresAt: number;
}

const MAX_SOCKETS = 4;
const MESSAGE_WINDOW_MS = 10_000;
const MESSAGE_LIMIT = 50;
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
    if (!Number.isFinite(expiry) || expiry <= Date.now() || !isRoomId(roomId)) {
      return Response.json({ error: "expired" }, { status: 410 });
    }
    this.ensureSchema();
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
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
      stamps: [],
      expiresAt: expiry,
      roomId,
    } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      ws.close(1003, "bad-message");
      return;
    }
    const attachment = readAttachment(ws);
    const rate = bumpRate(attachment.stamps, Date.now(), MESSAGE_WINDOW_MS, MESSAGE_LIMIT);
    attachment.stamps = rate.stamps;
    ws.serializeAttachment(attachment);
    if (!rate.ok) {
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
    const attachment = readAttachment(ws);
    if (attachment.role !== "peer" || !attachment.peerId) return;
    if (replacedByNewerSocket(this.ctx.getWebSockets(), attachment.peerId, ws)) return;
    const state = this.readRoom();
    if (!state) return;
    const result = leavePeer(state, attachment.peerId);
    this.writeRoom(result.state);
    if (result.removed) this.sendToPeers({ type: "peer-left", peerCount: result.peerCount }, attachment.peerId);
    logEvent("peer-left", { peers: result.peerCount });
    await this.schedule(result.state);
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
      this.ctx.storage.sql.exec("DELETE FROM meta");
      this.ctx.storage.sql.exec("DELETE FROM peers");
      this.ctx.storage.sql.exec("DELETE FROM signals");
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
    // Hashes are ready before the read. The two-peer decision and the write stay synchronous.
    let state = this.readRoom() ?? newRoom(now, Math.max(ttlMs, attachment.expiresAt - now));
    if (attachment.expiresAt > state.expiresAt) state = { ...state, expiresAt: attachment.expiresAt };
    const admitted = admitPeer(state, {
      now,
      ttlMs,
      resumeHash,
      newPeerId: crypto.randomUUID(),
      newResumeHash,
      livePeerIds: livePeers(this.ctx.getWebSockets(), ws),
    });
    if (!admitted.ok) {
      this.writeRoom(admitted.state);
      const code = admitted.code === "room-full" ? 4000 : admitted.code === "rate" ? 1008 : 4004;
      ws.close(code, admitted.code);
      logEvent("admit-rejected", { code: admitted.code });
      return;
    }
    this.writeRoom(admitted.state);
    if (admitted.resumed) closeOtherSockets(this.ctx.getWebSockets(), admitted.peerId, ws);
    ws.serializeAttachment({ ...attachment, role: "peer", peerId: admitted.peerId });
    this.send(ws, {
      type: "welcome",
      protocol: 1,
      peerId: admitted.peerId,
      polite: admitted.polite,
      peerCount: admitted.peerCount,
      expiresAt: admitted.expiresAt,
      resumed: admitted.resumed,
      turnMode: ice.mode,
      iceServers: ice.iceServers,
      resumeToken,
    });
    if (admitted.notify === "joined") {
      this.sendToPeers({ type: "peer-joined", peerCount: admitted.peerCount }, admitted.peerId);
    } else if (admitted.notify === "reset") {
      this.sendToPeers({ type: "peer-reset", peerCount: admitted.peerCount }, admitted.peerId);
    }
    for (const signal of admitted.flush) this.send(ws, signalMessage(signal));
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
        this.sendToPeers({ type: "peer-left", peerCount: touched.state.peers.length });
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
      this.sendToPeers({ type: "peer-left", peerCount: left.peerCount }, peerId);
      ws.close(1000, "hangup");
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
      kind: message.kind,
      payload: message.payload,
      livePeerIds,
    });
    if (!relayed.ok) {
      ws.close(1008, relayed.code);
      return;
    }
    this.writeRoom(relayed.state);
    const outbound = { type: "signal" as const, kind: message.kind, payload: message.payload };
    for (const target of relayed.toPeerIds) this.sendToPeer(target, outbound);
    logEvent("signal", { kind: message.kind, bytes: message.payload.length, targets: relayed.toPeerIds.length });
    this.touchIndex(attachment.roomId, relayed.state.expiresAt, false);
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
      CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        join_window_start INTEGER NOT NULL,
        join_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS peers (
        peer_id TEXT PRIMARY KEY,
        resume_hash TEXT NOT NULL,
        polite INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_peer TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
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
    `);
  }

  private readRoom(): RoomState | null {
    this.ensureSchema();
    const meta = this.ctx.storage.sql
      .exec<{ created_at: number; expires_at: number; join_window_start: number; join_count: number }>(
        "SELECT created_at, expires_at, join_window_start, join_count FROM meta WHERE id = 1",
      )
      .toArray()[0];
    if (!meta) return null;
    const peers = this.ctx.storage.sql
      .exec<{ peer_id: string; resume_hash: string; polite: number; joined_at: number; last_seen: number }>(
        "SELECT peer_id, resume_hash, polite, joined_at, last_seen FROM peers",
      )
      .toArray()
      .map((row) => ({
        peerId: row.peer_id,
        resumeHash: row.resume_hash,
        polite: row.polite === 1,
        joinedAt: row.joined_at,
        lastSeen: row.last_seen,
      }));
    const queued = this.ctx.storage.sql
      .exec<{ from_peer: string; kind: SignalKind; payload: string }>("SELECT from_peer, kind, payload FROM signals ORDER BY id")
      .toArray()
      .map((row) => ({ fromPeerId: row.from_peer, kind: row.kind, payload: row.payload }));
    return {
      createdAt: meta.created_at,
      expiresAt: meta.expires_at,
      joinWindowStart: meta.join_window_start,
      joinCount: meta.join_count,
      peers,
      queued,
    };
  }

  private writeRoom(state: RoomState): void {
    this.ctx.storage.sql.exec("DELETE FROM signals");
    this.ctx.storage.sql.exec("DELETE FROM peers");
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (id, created_at, expires_at, join_window_start, join_count)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         join_window_start = excluded.join_window_start,
         join_count = excluded.join_count`,
      state.createdAt,
      state.expiresAt,
      state.joinWindowStart,
      state.joinCount,
    );
    for (const peer of state.peers) {
      this.ctx.storage.sql.exec(
        "INSERT INTO peers (peer_id, resume_hash, polite, joined_at, last_seen) VALUES (?, ?, ?, ?, ?)",
        peer.peerId,
        peer.resumeHash,
        peer.polite ? 1 : 0,
        peer.joinedAt,
        peer.lastSeen,
      );
    }
    for (const signal of state.queued) {
      this.ctx.storage.sql.exec(
        "INSERT INTO signals (from_peer, kind, payload) VALUES (?, ?, ?)",
        signal.fromPeerId,
        signal.kind,
        signal.payload,
      );
    }
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
  if (!value || (value.role !== "pending" && value.role !== "peer") || !Array.isArray(value.stamps)) {
    return { role: "pending", at: Date.now(), stamps: [], expiresAt: 0, roomId: "" };
  }
  return {
    role: value.role,
    peerId: value.peerId,
    at: value.at ?? Date.now(),
    stamps: value.stamps.filter((stamp) => typeof stamp === "number"),
    expiresAt: value.expiresAt ?? 0,
    roomId: value.roomId ?? "",
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

function signalMessage(signal: QueuedSignal): { type: "signal"; kind: SignalKind; payload: string } {
  return { type: "signal", kind: signal.kind, payload: signal.payload };
}
