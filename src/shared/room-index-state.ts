import { isRoomId } from "./ids";
import type { RoomKind } from "./room-state";

export interface IndexRoom {
  roomId: string;
  createdAt: number;
  expiresAt: number;
  /** Absent on rooms made before conferences existed: those are for two. */
  kind?: RoomKind;
}

export interface IndexCreateBucket {
  ipHash: string;
  windowStart: number;
  count: number;
}

export interface IndexState {
  rooms: IndexRoom[];
  creates: IndexCreateBucket[];
  dayStamp: string;
  dayCount: number;
}

export type CreateRoomResult =
  | { ok: true; state: IndexState; roomId: string; expiresAt: number }
  | { ok: false; state: IndexState; code: "bad-room" | "rate" | "daily" };

export function emptyIndex(): IndexState {
  return { rooms: [], creates: [], dayStamp: "", dayCount: 0 };
}

export function createIndexedRoom(
  state: IndexState,
  input: {
    roomId: string;
    ipHash: string;
    now: number;
    ttlMs: number;
    kind?: RoomKind;
    perIpLimit: number;
    perIpWindowMs: number;
    dailyLimit: number;
  },
): CreateRoomResult {
  const purged = purgeExpired(state, input.now);
  if (!isRoomId(input.roomId)) return { ok: false, state: purged, code: "bad-room" };
  const dayStamp = utcDay(input.now);
  const dayCount = purged.dayStamp === dayStamp ? purged.dayCount : 0;
  if (dayCount >= input.dailyLimit) {
    return { ok: false, state: { ...purged, dayStamp, dayCount }, code: "daily" };
  }
  const creates = purged.creates
    .filter((bucket) => input.now - bucket.windowStart < input.perIpWindowMs)
    .map((bucket) => ({ ...bucket }));
  const bucket = creates.find((entry) => entry.ipHash === input.ipHash);
  if (bucket && bucket.count >= input.perIpLimit) {
    return { ok: false, state: { ...purged, creates, dayStamp, dayCount }, code: "rate" };
  }
  if (bucket) bucket.count += 1;
  else creates.push({ ipHash: input.ipHash, windowStart: input.now, count: 1 });
  const expiresAt = input.now + input.ttlMs;
  const rooms = purged.rooms.filter((room) => room.roomId !== input.roomId);
  const room: IndexRoom = { roomId: input.roomId, createdAt: input.now, expiresAt };
  if (input.kind === "group") room.kind = "group";
  rooms.push(room);
  return {
    ok: true,
    roomId: input.roomId,
    expiresAt,
    state: { rooms, creates, dayStamp, dayCount: dayCount + 1 },
  };
}

export function lookupRoom(state: IndexState, roomId: string, now: number): { state: IndexState; room: IndexRoom | null } {
  const purged = purgeExpired(state, now);
  const room = purged.rooms.find((entry) => entry.roomId === roomId) ?? null;
  return { state: purged, room };
}

export function touchRoom(state: IndexState, roomId: string, expiresAt: number, now: number): IndexState {
  const purged = purgeExpired(state, now);
  return {
    ...purged,
    rooms: purged.rooms.map((room) => (room.roomId === roomId ? { ...room, expiresAt: Math.max(room.expiresAt, expiresAt) } : room)),
  };
}

export function nextIndexAlarm(state: IndexState): number | null {
  let soonest: number | null = null;
  for (const room of state.rooms) {
    if (soonest === null || room.expiresAt < soonest) soonest = room.expiresAt;
  }
  return soonest;
}

function purgeExpired(state: IndexState, now: number): IndexState {
  return { ...state, rooms: state.rooms.filter((room) => room.expiresAt > now) };
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
