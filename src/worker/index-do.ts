import { DurableObject } from "cloudflare:workers";
import { createRoomId } from "../shared/ids";
import { createIndexedRoom, emptyIndex, legacyRooms, type IndexState } from "../shared/room-index-state";
import type { RoomKind } from "../shared/room-state";

const PER_IP_LIMIT = 30;
const PER_IP_WINDOW_MS = 60 * 60 * 1000;
const DAILY_LIMIT = 200;

export class RoomIndexDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  async createRoom(ipHash: string, now: number, ttlMs: number, kind: RoomKind = "pair"): Promise<{ ok: true; roomId: string; expiresAt: number } | { ok: false; code: string }> {
    const result = createIndexedRoom(this.readLimits(), {
      roomId: createRoomId(),
      ipHash,
      now,
      ttlMs,
      kind,
      perIpLimit: PER_IP_LIMIT,
      perIpWindowMs: PER_IP_WINDOW_MS,
      dailyLimit: DAILY_LIMIT,
    });
    this.writeLimits(result.state);
    if (!result.ok) return { ok: false, code: result.code };
    const room = result.room;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO rooms (room_id, created_at, expires_at, kind) VALUES (?, ?, ?, ?)",
      room.roomId,
      room.createdAt,
      room.expiresAt,
      room.kind ?? "pair",
    );
    await this.schedule(false);
    return { ok: true, roomId: room.roomId, expiresAt: room.expiresAt };
  }

  /** One row read and nothing written: every join and every reconnect of every call comes through here. */
  async lookup(roomId: string, now: number): Promise<{ expiresAt: number; kind: RoomKind } | null> {
    const row = this.ctx.storage.sql
      .exec<{ expires_at: number; kind: string }>("SELECT expires_at, kind FROM rooms WHERE room_id = ? AND expires_at > ?", roomId, now)
      .toArray()[0];
    return row ? { expiresAt: row.expires_at, kind: row.kind === "group" ? "group" : "pair" } : null;
  }

  async touch(roomId: string, expiresAt: number, now: number): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE rooms SET expires_at = MAX(expires_at, ?) WHERE room_id = ? AND expires_at > ?", expiresAt, roomId, now);
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE expires_at <= ?", Date.now());
    await this.schedule(true);
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms (expires_at);
    `);
    this.moveLegacyRooms();
  }

  /** The index used to be one JSON value with every room in it. Its rooms become rows, once. */
  private moveLegacyRooms(): void {
    const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM index_state WHERE id = 1").toArray()[0];
    if (!row) return;
    let saved: unknown;
    try {
      saved = JSON.parse(row.body);
    } catch {
      return;
    }
    if (!saved || typeof saved !== "object" || !("rooms" in saved)) return;
    for (const room of legacyRooms(saved)) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO rooms (room_id, created_at, expires_at, kind) VALUES (?, ?, ?, ?)",
        room.roomId,
        room.createdAt,
        room.expiresAt,
        room.kind ?? "pair",
      );
    }
    const limits = saved as Partial<IndexState>;
    this.writeLimits({
      creates: Array.isArray(limits.creates) ? limits.creates : [],
      dayStamp: typeof limits.dayStamp === "string" ? limits.dayStamp : "",
      dayCount: typeof limits.dayCount === "number" ? limits.dayCount : 0,
    });
  }

  private readLimits(): IndexState {
    const row = this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM index_state WHERE id = 1")
      .toArray()[0];
    if (!row) return emptyIndex();
    return JSON.parse(row.body) as IndexState;
  }

  private writeLimits(state: IndexState): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO index_state (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      JSON.stringify(state),
    );
  }

  /**
   * The alarm only clears expired rows, so it need not be exact. A room that was touched since simply
   * outlives one firing. An alarm that is already set is left alone unless it has just fired.
   */
  private async schedule(fired: boolean): Promise<void> {
    if (!fired && (await this.ctx.storage.getAlarm()) !== null) return;
    const row = this.ctx.storage.sql.exec<{ soonest: number | null }>("SELECT MIN(expires_at) AS soonest FROM rooms").toArray()[0];
    if (row?.soonest === null || row?.soonest === undefined) return;
    await this.ctx.storage.setAlarm(row.soonest);
  }
}
