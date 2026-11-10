import { isResumeToken } from "./ids";

// Version 2 adds the connection generation. A page from before it cannot mix its signals into a newer call.
export const PROTOCOL_VERSION = 2;
export const MAX_GENERATION = 1_000_000_000;
export const MAX_CLIENT_MESSAGE_CHARS = 40_000;
export const MAX_SDP_CHARS = 32_000;
export const MAX_ICE_CANDIDATE_CHARS = 2_000;

export type SignalKind = "offer" | "answer" | "ice";

export interface IcePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type ClientMessage =
  | { type: "hello"; protocol: number; resume?: string; gen?: number }
  | { type: "signal"; kind: SignalKind; payload: string; gen: number }
  | { type: "restart"; gen: number; ack: boolean }
  | { type: "rebuild"; gen: number }
  | { type: "hangup" }
  | { type: "ping" };

export function parseClientMessage(raw: string): { ok: true; message: ClientMessage } | { ok: false; code: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CLIENT_MESSAGE_CHARS) {
    return { ok: false, code: "bad-message" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "bad-message" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "bad-message" };
  const record = value as Record<string, unknown>;
  if (record.type === "hello") {
    if (record.protocol !== PROTOCOL_VERSION) return { ok: false, code: "bad-protocol" };
    const message: ClientMessage = { type: "hello", protocol: PROTOCOL_VERSION };
    if (record.resume !== undefined) {
      if (typeof record.resume !== "string" || !isResumeToken(record.resume)) return { ok: false, code: "bad-message" };
      message.resume = record.resume;
    }
    if (record.gen !== undefined) {
      if (!isGeneration(record.gen)) return { ok: false, code: "bad-message" };
      message.gen = record.gen;
    }
    return { ok: true, message };
  }
  if (record.type === "hangup") return { ok: true, message: { type: "hangup" } };
  if (record.type === "ping") return { ok: true, message: { type: "ping" } };
  if (record.type === "signal") {
    if (record.kind !== "offer" && record.kind !== "answer" && record.kind !== "ice") {
      return { ok: false, code: "bad-message" };
    }
    if (typeof record.payload !== "string") return { ok: false, code: "bad-message" };
    if (!validSignalPayload(record.kind, record.payload)) return { ok: false, code: "bad-message" };
    if (!isGeneration(record.gen)) return { ok: false, code: "bad-message" };
    return { ok: true, message: { type: "signal", kind: record.kind, payload: record.payload, gen: record.gen } };
  }
  if (record.type === "restart") {
    if (!isGeneration(record.gen) || typeof record.ack !== "boolean") return { ok: false, code: "bad-message" };
    return { ok: true, message: { type: "restart", gen: record.gen, ack: record.ack } };
  }
  if (record.type === "rebuild") {
    if (!isGeneration(record.gen)) return { ok: false, code: "bad-message" };
    return { ok: true, message: { type: "rebuild", gen: record.gen } };
  }
  return { ok: false, code: "bad-message" };
}

export function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_GENERATION;
}

export function validSignalPayload(kind: SignalKind, payload: string): boolean {
  if (kind === "ice") return parseIcePayload(payload) !== null;
  if (payload.length < 8 || payload.length > MAX_SDP_CHARS) return false;
  return payload.startsWith("v=");
}

export function parseIcePayload(payload: string): IcePayload | null {
  if (payload.length > MAX_ICE_CANDIDATE_CHARS + 200) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.candidate !== "string") return null;
  if (record.candidate.length === 0 || record.candidate.length > MAX_ICE_CANDIDATE_CHARS) return null;
  if (!record.candidate.startsWith("candidate:")) return null;
  let sdpMid: string | null = null;
  if (record.sdpMid !== null && record.sdpMid !== undefined) {
    if (typeof record.sdpMid !== "string" || record.sdpMid.length > 32) return null;
    sdpMid = record.sdpMid;
  }
  let sdpMLineIndex: number | null = null;
  if (record.sdpMLineIndex !== null && record.sdpMLineIndex !== undefined) {
    if (typeof record.sdpMLineIndex !== "number" || !Number.isInteger(record.sdpMLineIndex)) return null;
    if (record.sdpMLineIndex < 0 || record.sdpMLineIndex > 64) return null;
    sdpMLineIndex = record.sdpMLineIndex;
  }
  return { candidate: record.candidate, sdpMid, sdpMLineIndex };
}

export function encodeIcePayload(payload: IcePayload): string {
  return JSON.stringify({
    candidate: payload.candidate,
    sdpMid: payload.sdpMid,
    sdpMLineIndex: payload.sdpMLineIndex,
  });
}
