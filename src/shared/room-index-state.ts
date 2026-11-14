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

/** What limits the creation of rooms. The rooms themselves are rows of their own, one per room. */
export interface IndexState {
  creates: IndexCreateBucket[];
  dayStamp: string;
  dayCount: number;
}

export type CreateRoomResult =
  | { ok: true; state: IndexState; room: IndexRoom }
  | { ok: false; state: IndexState; code: "bad-room" | "rate" | "daily" };

export function emptyIndex(): IndexState {
  return { creates: [], dayStamp: "", dayCount: 0 };
}

/** Counts one more room against the address and the day, and describes the room to store if both allow it. */
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
  const limits: IndexState = { creates: state.creates, dayStamp: state.dayStamp, dayCount: state.dayCount };
  if (!isRoomId(input.roomId)) return { ok: false, state: limits, code: "bad-room" };
  const dayStamp = utcDay(input.now);
  const dayCount = limits.dayStamp === dayStamp ? limits.dayCount : 0;
  if (dayCount >= input.dailyLimit) {
    return { ok: false, state: { ...limits, dayStamp, dayCount }, code: "daily" };
  }
  const creates = limits.creates
    .filter((bucket) => input.now - bucket.windowStart < input.perIpWindowMs)
    .map((bucket) => ({ ...bucket }));
  const bucket = creates.find((entry) => entry.ipHash === input.ipHash);
  if (bucket && bucket.count >= input.perIpLimit) {
    return { ok: false, state: { creates, dayStamp, dayCount }, code: "rate" };
  }
  if (bucket) bucket.count += 1;
  else creates.push({ ipHash: input.ipHash, windowStart: input.now, count: 1 });
  const room: IndexRoom = { roomId: input.roomId, createdAt: input.now, expiresAt: input.now + input.ttlMs };
  if (input.kind === "group") room.kind = "group";
  return { ok: true, room, state: { creates, dayStamp, dayCount: dayCount + 1 } };
}

/** Rooms of an index saved before they became rows. Anything that is not a room is left out. */
export function legacyRooms(saved: unknown): IndexRoom[] {
  const rooms = (saved as { rooms?: unknown } | null)?.rooms;
  if (!Array.isArray(rooms)) return [];
  const found: IndexRoom[] = [];
  for (const item of rooms) {
    if (!item || typeof item !== "object") continue;
    const { roomId, createdAt, expiresAt, kind } = item as Record<string, unknown>;
    if (typeof roomId !== "string" || !isRoomId(roomId) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) continue;
    const room: IndexRoom = { roomId, createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0, expiresAt };
    if (kind === "group") room.kind = "group";
    found.push(room);
  }
  return found;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
