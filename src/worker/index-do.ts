import { DurableObject } from "cloudflare:workers";
import { createRoomId } from "../shared/ids";
import {
  createIndexedRoom,
  emptyIndex,
  lookupRoom,
  nextIndexAlarm,
  touchRoom,
  type IndexState,
} from "../shared/room-index-state";

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

  async createRoom(ipHash: string, now: number, ttlMs: number): Promise<{ ok: true; roomId: string; expiresAt: number } | { ok: false; code: string }> {
    let created: { ok: true; roomId: string; expiresAt: number } | { ok: false; code: string } | null = null;
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      const current = this.read();
      const result = createIndexedRoom(current, {
        roomId: createRoomId(),
        ipHash,
        now,
        ttlMs,
        perIpLimit: PER_IP_LIMIT,
        perIpWindowMs: PER_IP_WINDOW_MS,
        dailyLimit: DAILY_LIMIT,
      });
      if (!result.ok) return { ok: false, code: result.code };
      this.write(result.state);
      created = { ok: true, roomId: result.roomId, expiresAt: result.expiresAt };
    }
    await this.schedule(created ? this.read() : emptyIndex());
    if (!created) return { ok: false, code: "rate" };
    return created;
  }

  async lookup(roomId: string, now: number): Promise<{ expiresAt: number } | null> {
    const result = lookupRoom(this.read(), roomId, now);
    this.write(result.state);
    await this.schedule(result.state);
    return result.room ? { expiresAt: result.room.expiresAt } : null;
  }

  async touch(roomId: string, expiresAt: number, now: number): Promise<void> {
    const next = touchRoom(this.read(), roomId, expiresAt, now);
    this.write(next);
    await this.schedule(next);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const result = lookupRoom(this.read(), "", now);
    this.write(result.state);
    await this.schedule(result.state);
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        body TEXT NOT NULL
      )
    `);
  }

  private read(): IndexState {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM index_state WHERE id = 1")
      .toArray()[0];
    if (!row) return emptyIndex();
    return JSON.parse(row.body) as IndexState;
  }

  private write(state: IndexState): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO index_state (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      JSON.stringify(state),
    );
  }

  private async schedule(state: IndexState): Promise<void> {
    const when = nextIndexAlarm(state);
    if (when === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(when);
  }
}
