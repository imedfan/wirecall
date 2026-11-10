import type { SignalKind } from "./protocol";

export const MAX_PEERS = 2;
export const STALE_PEER_MS = 90_000;
export const JOIN_WINDOW_MS = 10 * 60 * 1000;
export const JOIN_LIMIT = 240;
export const MAX_ICE_PER_PEER = 20;

export interface PeerRecord {
  peerId: string;
  resumeHash: string;
  polite: boolean;
  joinedAt: number;
  lastSeen: number;
}

export interface QueuedSignal {
  fromPeerId: string;
  kind: SignalKind;
  payload: string;
}

export interface RoomState {
  createdAt: number;
  expiresAt: number;
  peers: PeerRecord[];
  queued: QueuedSignal[];
  joinWindowStart: number;
  joinCount: number;
}

export function newRoom(now: number, ttlMs: number): RoomState {
  return {
    createdAt: now,
    expiresAt: now + ttlMs,
    peers: [],
    queued: [],
    joinWindowStart: now,
    joinCount: 0,
  };
}

export type AdmitResult =
  | {
      ok: true;
      state: RoomState;
      peerId: string;
      polite: boolean;
      resumed: boolean;
      peerCount: number;
      expiresAt: number;
      flush: QueuedSignal[];
      notify: "joined" | "reset" | "none";
    }
  | { ok: false; state: RoomState; code: "expired" | "rate" | "room-full" };

export function admitPeer(
  state: RoomState,
  input: {
    now: number;
    ttlMs: number;
    resumeHash: string | null;
    newPeerId: string;
    newResumeHash: string;
    livePeerIds: readonly string[];
  },
): AdmitResult {
  if (input.now >= state.expiresAt) return { ok: false, state, code: "expired" };
  const rated = noteJoin(sweepStale(state, input.now, input.livePeerIds), input.now);
  if (!rated.ok) return { ok: false, state: rated.state, code: "rate" };
  let next = extendExpiry(rated.state, input.now, input.ttlMs);
  const existing = input.resumeHash ? next.peers.find((peer) => peer.resumeHash === input.resumeHash) : undefined;
  if (existing) {
    next = {
      ...next,
      peers: next.peers.map((peer) => (peer.peerId === existing.peerId ? { ...peer, resumeHash: input.newResumeHash, lastSeen: input.now } : peer)),
    };
    return {
      ok: true,
      state: next,
      peerId: existing.peerId,
      polite: existing.polite,
      resumed: true,
      peerCount: next.peers.length,
      expiresAt: next.expiresAt,
      flush: next.queued.filter((signal) => signal.fromPeerId !== existing.peerId),
      notify: "reset",
    };
  }
  if (next.peers.length >= MAX_PEERS) return { ok: false, state: next, code: "room-full" };
  const polite = next.peers.length === 1;
  const peer: PeerRecord = {
    peerId: input.newPeerId,
    resumeHash: input.newResumeHash,
    polite,
    joinedAt: input.now,
    lastSeen: input.now,
  };
  next = { ...next, peers: [...next.peers, peer] };
  return {
    ok: true,
    state: next,
    peerId: peer.peerId,
    polite,
    resumed: false,
    peerCount: next.peers.length,
    expiresAt: next.expiresAt,
    flush: next.queued,
    notify: next.peers.length === 2 ? "joined" : "none",
  };
}

export function relaySignal(
  state: RoomState,
  input: { now: number; ttlMs: number; fromPeerId: string; kind: SignalKind; payload: string; livePeerIds: readonly string[] },
): { ok: true; state: RoomState; toPeerIds: string[] } | { ok: false; state: RoomState; code: "unknown-peer" | "expired" } {
  if (input.now >= state.expiresAt) return { ok: false, state, code: "expired" };
  const swept = sweepStale(state, input.now, input.livePeerIds);
  const sender = swept.peers.find((peer) => peer.peerId === input.fromPeerId);
  if (!sender) return { ok: false, state: swept, code: "unknown-peer" };
  const peers = swept.peers.map((peer) => (peer.peerId === sender.peerId ? { ...peer, lastSeen: input.now } : peer));
  const queued = enqueueSignal(swept.queued, { fromPeerId: sender.peerId, kind: input.kind, payload: input.payload });
  const next = extendExpiry({ ...swept, peers, queued }, input.now, input.ttlMs);
  return { ok: true, state: next, toPeerIds: peers.filter((peer) => peer.peerId !== sender.peerId).map((peer) => peer.peerId) };
}

export function leavePeer(state: RoomState, peerId: string): { state: RoomState; removed: boolean; peerCount: number } {
  const existed = state.peers.some((peer) => peer.peerId === peerId);
  const peers = state.peers.filter((peer) => peer.peerId !== peerId);
  const queued = state.queued.filter((signal) => signal.fromPeerId !== peerId);
  return { state: { ...state, peers, queued }, removed: existed, peerCount: peers.length };
}

export function touchPeer(
  state: RoomState,
  peerId: string,
  now: number,
  ttlMs: number,
  livePeerIds: readonly string[],
): { state: RoomState; removedPeerIds: string[]; known: boolean } {
  if (now >= state.expiresAt) {
    const removedPeerIds = state.peers.map((peer) => peer.peerId);
    return { state: { ...state, peers: [], queued: [] }, removedPeerIds, known: false };
  }
  const swept = sweepStale(state, now, livePeerIds);
  const removedPeerIds = state.peers
    .filter((peer) => !swept.peers.some((kept) => kept.peerId === peer.peerId))
    .map((peer) => peer.peerId);
  const peers = swept.peers.map((peer) => (peer.peerId === peerId ? { ...peer, lastSeen: now } : peer));
  const known = peers.some((peer) => peer.peerId === peerId);
  return { state: extendExpiry({ ...swept, peers }, now, ttlMs), removedPeerIds, known };
}

function noteJoin(state: RoomState, now: number): { ok: boolean; state: RoomState } {
  const fresh = now - state.joinWindowStart >= JOIN_WINDOW_MS;
  const joinWindowStart = fresh ? now : state.joinWindowStart;
  const joinCount = fresh ? 0 : state.joinCount;
  if (joinCount >= JOIN_LIMIT) return { ok: false, state: { ...state, joinWindowStart, joinCount } };
  return { ok: true, state: { ...state, joinWindowStart, joinCount: joinCount + 1 } };
}

function sweepStale(state: RoomState, now: number, livePeerIds: readonly string[]): RoomState {
  const peers = state.peers.filter((peer) => now - peer.lastSeen <= STALE_PEER_MS || livePeerIds.includes(peer.peerId));
  const ids = new Set(peers.map((peer) => peer.peerId));
  return { ...state, peers, queued: state.queued.filter((signal) => ids.has(signal.fromPeerId)) };
}

function extendExpiry(state: RoomState, now: number, ttlMs: number): RoomState {
  return { ...state, expiresAt: Math.max(state.expiresAt, now + ttlMs) };
}

function enqueueSignal(queued: readonly QueuedSignal[], signal: QueuedSignal): QueuedSignal[] {
  if (signal.kind === "offer") {
    const kept = queued.filter((entry) => entry.fromPeerId !== signal.fromPeerId);
    return [...kept, signal];
  }
  if (signal.kind === "answer") {
    const kept = queued.filter((entry) => !(entry.fromPeerId === signal.fromPeerId && entry.kind === "answer"));
    return [...kept, signal];
  }
  const ice = queued.filter((entry) => entry.fromPeerId === signal.fromPeerId && entry.kind === "ice");
  const others = queued.filter((entry) => !(entry.fromPeerId === signal.fromPeerId && entry.kind === "ice"));
  const nextIce = [...ice, signal].slice(-MAX_ICE_PER_PEER);
  return [...others, ...nextIce];
}
