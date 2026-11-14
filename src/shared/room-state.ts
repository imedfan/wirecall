import { timingSafeEqualString } from "./ids";
import type { KeptLink } from "./protocol";

export type RoomKind = "pair" | "group";

export const PAIR_CAPACITY = 2;
/**
 * A conference is a mesh: every browser sends its picture to every other one directly. Six people is
 * five outgoing videos from a phone, which is about as much as a phone and a home uplink can carry.
 */
export const GROUP_CAPACITY = 6;
export const STALE_PEER_MS = 90_000;
/**
 * A full room gives the seat of someone whose socket has been gone this long to a newcomer. It is nearly always
 * the same person: the tab was killed, or the link was opened again from the messenger, and the resume token
 * stayed in the old tab. Shorter than the sweep, longer than a socket takes to come back after a network change.
 */
export const EVICT_AWAY_MS = 15_000;
/** A seat's last-seen time is saved again only when it moved this far. Every ping and signal moves it a little. */
const SEEN_SAVE_STEP_MS = 30_000;
export const JOIN_WINDOW_MS = 10 * 60 * 1000;
export const JOIN_LIMIT = 240;

export function capacityOf(kind: RoomKind): number {
  return kind === "group" ? GROUP_CAPACITY : PAIR_CAPACITY;
}

/** Only the two known sizes exist. Anything else, a missing header included, is a room for two. */
export function parseCapacity(value: unknown): number {
  return Number(value) === GROUP_CAPACITY ? GROUP_CAPACITY : PAIR_CAPACITY;
}

export interface PeerRecord {
  peerId: string;
  resumeHash: string;
  /** Order of arrival. Of any two peers, the one that came first makes the offers. */
  seq: number;
  joinedAt: number;
  lastSeen: number;
}

export interface RoomState {
  createdAt: number;
  expiresAt: number;
  peers: PeerRecord[];
  joinWindowStart: number;
  joinCount: number;
  /** A counter that only grows. Every new connection generation takes its next value. */
  gen: number;
  /**
   * Generation of the media connection each pair of peers shares, by linkKey. It changes whenever the two
   * must start a new RTCPeerConnection. Signals carry it, so nothing from an older connection reaches a newer one.
   */
  links: Record<string, number>;
}

/** One connection as the admitted peer sees it. */
export interface AdmittedLink {
  peerId: string;
  gen: number;
  /** The admitted peer answers on this link, the other one offers. */
  polite: boolean;
  /** The admitted peer still holds the connection of this generation, so neither side rebuilds it. */
  kept: boolean;
}

export function newRoom(now: number, ttlMs: number): RoomState {
  return {
    createdAt: now,
    expiresAt: now + ttlMs,
    peers: [],
    joinWindowStart: now,
    joinCount: 0,
    gen: 0,
    links: {},
  };
}

export function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function linkGen(state: RoomState, a: string, b: string): number | undefined {
  return state.links[linkKey(a, b)];
}

export type AdmitResult =
  | {
      ok: true;
      state: RoomState;
      peerId: string;
      resumed: boolean;
      peerCount: number;
      expiresAt: number;
      /** Every other peer in the room, with the connection the admitted one has or must build to it. */
      links: AdmittedLink[];
      /** Seats this admission emptied: stale ones, and one given up to the newcomer. The others must be told. */
      removedPeerIds: string[];
    }
  | { ok: false; state: RoomState; code: "expired" | "rate" | "room-full"; removedPeerIds: string[] };

export function admitPeer(
  state: RoomState,
  input: {
    now: number;
    ttlMs: number;
    resumeHash: string | null;
    newPeerId: string;
    newResumeHash: string;
    livePeerIds: readonly string[];
    capacity?: number;
    /** Connections the client still holds, if any. */
    keep?: readonly KeptLink[] | null;
  },
): AdmitResult {
  if (input.now >= state.expiresAt) return { ok: false, state, code: "expired", removedPeerIds: [] };
  const rated = noteJoin(sweepStale(state, input.now, input.livePeerIds), input.now);
  const removed = (after: RoomState): string[] =>
    state.peers.filter((peer) => !after.peers.some((kept) => kept.peerId === peer.peerId)).map((peer) => peer.peerId);
  if (!rated.ok) return { ok: false, state: rated.state, code: "rate", removedPeerIds: removed(rated.state) };
  let next = extendExpiry(rated.state, input.now, input.ttlMs);
  const existing = input.resumeHash
    ? next.peers.find((peer) => timingSafeEqualString(peer.resumeHash, input.resumeHash ?? ""))
    : undefined;
  if (existing) {
    const others = next.peers.filter((peer) => peer.peerId !== existing.peerId);
    const links = { ...next.links };
    let gen = next.gen;
    const admitted = others.map((other): AdmittedLink => {
      const key = linkKey(existing.peerId, other.peerId);
      const named = input.keep?.find((link) => link.peerId === other.peerId)?.gen;
      // A signaling drop alone must not cost a working call. Only a connection this peer lost is built again.
      const kept = named !== undefined && named === links[key];
      if (!kept) {
        gen += 1;
        links[key] = gen;
      }
      return { peerId: other.peerId, gen: links[key] ?? gen, polite: existing.seq > other.seq, kept };
    });
    next = {
      ...next,
      gen,
      links,
      peers: next.peers.map((peer) => (peer.peerId === existing.peerId ? { ...peer, resumeHash: input.newResumeHash, lastSeen: input.now } : peer)),
    };
    return {
      ok: true,
      state: next,
      peerId: existing.peerId,
      resumed: true,
      peerCount: next.peers.length,
      expiresAt: next.expiresAt,
      links: admitted,
      removedPeerIds: removed(next),
    };
  }
  if (next.peers.length >= (input.capacity ?? PAIR_CAPACITY)) {
    const away = longestAway(next, input.now, input.livePeerIds);
    if (!away) return { ok: false, state: next, code: "room-full", removedPeerIds: removed(next) };
    next = withLinksOf({ ...next, peers: next.peers.filter((peer) => peer.peerId !== away.peerId) });
  }
  // The newcomer came last, so it answers on every link and those who were here first offer.
  const gen = next.gen + 1;
  const peer: PeerRecord = {
    peerId: input.newPeerId,
    resumeHash: input.newResumeHash,
    seq: gen,
    joinedAt: input.now,
    lastSeen: input.now,
  };
  const links = { ...next.links };
  const admitted = next.peers.map((other): AdmittedLink => {
    links[linkKey(peer.peerId, other.peerId)] = gen;
    return { peerId: other.peerId, gen, polite: true, kept: false };
  });
  next = { ...next, peers: [...next.peers, peer], gen, links };
  return {
    ok: true,
    state: next,
    peerId: peer.peerId,
    resumed: false,
    peerCount: next.peers.length,
    expiresAt: next.expiresAt,
    links: admitted,
    removedPeerIds: removed(next),
  };
}

/** The socket of this peer has just closed. From this moment its seat counts as away. */
export function seenPeer(state: RoomState, peerId: string, now: number): RoomState {
  return { ...state, peers: state.peers.map((peer) => (peer.peerId === peerId ? { ...peer, lastSeen: now } : peer)) };
}

/**
 * Whether a newer state differs from the saved one enough to be written. Seats, links and the join counter
 * always are. Times that only crept forward are not: a write holds back every message the room sends until it
 * is durable, and a call sets up through dozens of small signals.
 */
export function worthSaving(saved: RoomState | null, next: RoomState, ttlMs: number): boolean {
  if (!saved) return true;
  if (saved.gen !== next.gen || saved.joinCount !== next.joinCount || saved.joinWindowStart !== next.joinWindowStart) return true;
  if (saved.peers.length !== next.peers.length) return true;
  for (let index = 0; index < next.peers.length; index += 1) {
    const before = saved.peers[index]!;
    const after = next.peers[index]!;
    if (before.peerId !== after.peerId || before.resumeHash !== after.resumeHash) return true;
    if (after.lastSeen - before.lastSeen >= SEEN_SAVE_STEP_MS) return true;
  }
  const keys = Object.keys(next.links);
  if (keys.length !== Object.keys(saved.links).length || keys.some((key) => saved.links[key] !== next.links[key])) return true;
  return next.expiresAt - saved.expiresAt >= Math.min(3_600_000, ttlMs / 10);
}

export function relaySignal(
  state: RoomState,
  input: { now: number; ttlMs: number; fromPeerId: string; toPeerId: string; gen: number; livePeerIds: readonly string[] },
): { ok: true; state: RoomState; deliver: boolean } | { ok: false; state: RoomState; code: "unknown-peer" | "expired" } {
  if (input.now >= state.expiresAt) return { ok: false, state, code: "expired" };
  const swept = sweepStale(state, input.now, input.livePeerIds);
  const sender = swept.peers.find((peer) => peer.peerId === input.fromPeerId);
  if (!sender) return { ok: false, state: swept, code: "unknown-peer" };
  const peers = swept.peers.map((peer) => (peer.peerId === sender.peerId ? { ...peer, lastSeen: input.now } : peer));
  // Nothing is stored for later. A peer that was away asks for a fresh offer when it returns.
  const next = extendExpiry({ ...swept, peers }, input.now, input.ttlMs);
  // A signal for a peer that has left, or of another generation, belongs to a connection that no longer exists.
  return { ok: true, state: next, deliver: linkGen(next, input.fromPeerId, input.toPeerId) === input.gen };
}

/**
 * Starts a new generation for one pair when a peer reports that restarts did not bring the media back.
 * Two peers that ask at the same moment name the same generation, so the pair rebuilds once.
 */
export function rebuildLink(state: RoomState, a: string, b: string, gen: number): { state: RoomState; bumped: boolean; gen: number } {
  const current = linkGen(state, a, b);
  if (current === undefined || current !== gen) return { state, bumped: false, gen: current ?? gen };
  const next = state.gen + 1;
  return { state: { ...state, gen: next, links: { ...state.links, [linkKey(a, b)]: next } }, bumped: true, gen: next };
}

export function leavePeer(state: RoomState, peerId: string): { state: RoomState; removed: boolean; peerCount: number } {
  const existed = state.peers.some((peer) => peer.peerId === peerId);
  const peers = state.peers.filter((peer) => peer.peerId !== peerId);
  return { state: withLinksOf({ ...state, peers }), removed: existed, peerCount: peers.length };
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
    return { state: { ...state, peers: [], links: {} }, removedPeerIds, known: false };
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

/** The seat without a socket that has been empty longest, if it has been empty long enough to give away. */
function longestAway(state: RoomState, now: number, livePeerIds: readonly string[]): PeerRecord | null {
  let found: PeerRecord | null = null;
  for (const peer of state.peers) {
    if (livePeerIds.includes(peer.peerId) || now - peer.lastSeen < EVICT_AWAY_MS) continue;
    if (!found || peer.lastSeen < found.lastSeen) found = peer;
  }
  return found;
}

function sweepStale(state: RoomState, now: number, livePeerIds: readonly string[]): RoomState {
  const peers = state.peers.filter((peer) => now - peer.lastSeen <= STALE_PEER_MS || livePeerIds.includes(peer.peerId));
  return peers.length === state.peers.length ? state : withLinksOf({ ...state, peers });
}

/** Keeps only the links whose two peers are both still in the room. */
function withLinksOf(state: RoomState): RoomState {
  const links: Record<string, number> = {};
  for (let i = 0; i < state.peers.length; i += 1) {
    for (let j = i + 1; j < state.peers.length; j += 1) {
      const key = linkKey(state.peers[i]!.peerId, state.peers[j]!.peerId);
      const gen = state.links[key];
      if (gen !== undefined) links[key] = gen;
    }
  }
  return { ...state, links };
}

function extendExpiry(state: RoomState, now: number, ttlMs: number): RoomState {
  return { ...state, expiresAt: Math.max(state.expiresAt, now + ttlMs) };
}
