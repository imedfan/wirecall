import { authorizeCreate, originAllowed } from "../shared/origin";
import { isRoomId, shortHash } from "../shared/ids";
import { logEvent } from "./log";
import { RoomDurableObject } from "./room-do";
import { RoomIndexDurableObject } from "./index-do";
import { turnConfigured } from "./turn";

export { RoomDurableObject, RoomIndexDurableObject };

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      const turn = turnConfigured(env);
      return json({ ok: true, turn: turn ? "on" : "off", createGate: Boolean(env.CREATE_GATE), p2pOnly: !turn });
    }
    if (!originAllowed(request.url, request.headers.get("origin"), env.ALLOWED_ORIGINS)) {
      return json({ error: "origin" }, 403);
    }
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      return createRoom(request, env);
    }
    const match = /^\/api\/rooms\/([A-Za-z0-9_-]{22})\/socket$/u.exec(url.pathname);
    if (request.method === "GET" && match?.[1]) {
      return openSocket(request, env, match[1]);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not-found" }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env): Promise<Response> {
  if (!authorizeCreate(request.headers.get("x-wirecall-gate"), env.CREATE_GATE)) {
    return json({ error: "gate" }, 401);
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 1000) return json({ error: "bad-message" }, 413);
  const now = Date.now();
  const ttlMs = ttlFromEnv(env);
  const ipHash = await hashIp(request.headers.get("cf-connecting-ip") ?? "unknown", env.LIMIT_HASH_SALT ?? "wirecall-limit-v1");
  const created = await env.ROOM_INDEX.getByName("index").createRoom(ipHash, now, ttlMs);
  if (!created.ok) {
    logEvent("room-create-rejected", { code: created.code });
    return json({ error: created.code }, created.code === "rate" || created.code === "daily" ? 429 : 400);
  }
  logEvent("room-created", { room: await shortHash(created.roomId) });
  return json(
    {
      roomId: created.roomId,
      path: `/r/${created.roomId}`,
      expiresAt: created.expiresAt,
      turn: turnConfigured(env) ? "on" : "off",
    },
    201,
  );
}

async function openSocket(request: Request, env: Env, roomId: string): Promise<Response> {
  if (!isRoomId(roomId)) return json({ error: "bad-room" }, 404);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected-websocket" }, 426);
  const looked = await env.ROOM_INDEX.getByName("index").lookup(roomId, Date.now());
  if (!looked) return json({ error: "not-found" }, 404);
  const headers = new Headers(request.headers);
  headers.delete("x-wirecall-expires");
  headers.delete("x-wirecall-room");
  headers.set("x-wirecall-expires", String(looked.expiresAt));
  headers.set("x-wirecall-room", roomId);
  const forwarded = new Request(request.url, { method: request.method, headers });
  logEvent("room-join", { room: await shortHash(roomId) });
  return env.ROOM.getByName(roomId).fetch(forwarded);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function ttlFromEnv(env: Env): number {
  const parsed = Number(env.ROOM_TTL_SECONDS);
  const seconds = Number.isFinite(parsed) ? parsed : 1_209_600;
  return Math.min(Math.max(seconds, 3600), 30 * 24 * 3600) * 1000;
}

async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
