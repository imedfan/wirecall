import { describe, expect, it } from "vitest";
import { IceBuffer } from "../../src/shared/ice-buffer";
import { parseTurnCredentialResponse, sanitizeIceServers } from "../../src/shared/ice-servers";
import { shouldCreateOffer, shouldIgnoreOffer } from "../../src/shared/negotiation";
import { authorizeCreate, originAllowed } from "../../src/shared/origin";
import { encodeIcePayload, parseClientMessage } from "../../src/shared/protocol";
import { preferredAudioCodecs, preferredVideoCodecs } from "../../src/shared/codecs";
import { redactLogFields } from "../../src/shared/redact";
import { RetryBudget } from "../../src/shared/backoff";
import { bumpRate } from "../../src/shared/rate";
import { summarizeStats } from "../../src/shared/stats";
import { isRoomId } from "../../src/shared/ids";

describe("signaling validation", () => {
  it("accepts a bounded hello and signal and drops cross-room fields", () => {
    const hello = parseClientMessage(JSON.stringify({ type: "hello", protocol: 1, roomId: "other-room", resume: "short" }));
    expect(hello.ok).toBe(false);
    const token = "A".repeat(43);
    const ok = parseClientMessage(JSON.stringify({ type: "hello", protocol: 1, roomId: "other-room", resume: token }));
    expect(ok).toEqual({ ok: true, message: { type: "hello", protocol: 1, resume: token } });
    const offer = parseClientMessage(JSON.stringify({ type: "signal", kind: "offer", payload: "v=0\r\noffer", targetRoom: "nope" }));
    expect(offer.ok).toBe(true);
    if (offer.ok) expect(offer.message).toEqual({ type: "signal", kind: "offer", payload: "v=0\r\noffer" });
    expect(parseClientMessage(JSON.stringify({ type: "signal", kind: "offer", payload: "not-sdp" })).ok).toBe(false);
    expect(parseClientMessage(`{"type":"signal","kind":"offer","payload":"${"v=".padEnd(40_000, "a")}"}`).ok).toBe(false);
  });

  it("checks origin, create gate, and log redaction", () => {
    expect(originAllowed("https://wire.example/api/rooms", "https://wire.example", "")).toBe(true);
    expect(originAllowed("https://wire.example/api/rooms", "https://evil.example", "")).toBe(false);
    expect(originAllowed("https://wire.example/api/rooms", null, "")).toBe(false);
    expect(originAllowed("https://wire.example/", "https://preview.example", "https://preview.example")).toBe(true);
    expect(authorizeCreate(null, "")).toBe(true);
    expect(authorizeCreate("secret", "secret")).toBe(true);
    expect(authorizeCreate("nope", "secret")).toBe(false);
    expect(redactLogFields({ event: "signal", payload: "v=0", resumeToken: "abc", bytes: 12 })).toEqual({ event: "signal", bytes: 12 });
  });

  it("queues ICE until the remote description exists and ignores impolite glare", () => {
    const buffer = new IceBuffer();
    expect(buffer.push("one")).toEqual([]);
    expect(buffer.markReady()).toEqual(["one"]);
    expect(buffer.push("two")).toEqual(["two"]);
    buffer.reset();
    expect(buffer.push("three")).toEqual([]);
    expect(shouldCreateOffer({ polite: true })).toBe(false);
    expect(shouldCreateOffer({ polite: false })).toBe(true);
    expect(shouldIgnoreOffer({ polite: false, makingOffer: true, signalingState: "have-local-offer", descriptionType: "offer" })).toBe(true);
    expect(shouldIgnoreOffer({ polite: true, makingOffer: true, signalingState: "have-local-offer", descriptionType: "offer" })).toBe(false);
    expect(shouldIgnoreOffer({ polite: false, makingOffer: false, signalingState: "stable", descriptionType: "answer" })).toBe(false);
  });

  it("prefers H264 then VP8, puts Opus first, and filters TURN credentials", () => {
    const video = preferredVideoCodecs([
      { mimeType: "video/VP9" },
      { mimeType: "video/VP8" },
      { mimeType: "video/AV1" },
      { mimeType: "video/H264", sdpFmtpLine: "packetization-mode=0" },
      { mimeType: "video/H264", sdpFmtpLine: "packetization-mode=1" },
    ]);
    expect(video.map((codec) => codec.sdpFmtpLine ?? codec.mimeType)).toEqual([
      "packetization-mode=1",
      "packetization-mode=0",
      "video/VP8",
    ]);
    expect(preferredAudioCodecs([{ mimeType: "audio/PCMU" }, { mimeType: "audio/opus" }])[0]?.mimeType).toBe("audio/opus");
    const servers = parseTurnCredentialResponse({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp", "turn:turn.cloudflare.com:53?transport=udp"], username: "user", credential: "secret" },
        { urls: ["javascript:alert(1)"] },
      ],
    });
    expect(servers?.some((server) => server.urls.some((url) => url.includes(":53")))).toBe(false);
    expect(sanitizeIceServers(servers)[1]?.username).toBe("user");
    expect(isRoomId("short")).toBe(false);
  });

  it("bounds retries and reports honest unknowns from partial stats", () => {
    const budget = new RetryBudget(2, 1000, 15000);
    expect(budget.next()).toBe(1000);
    expect(budget.next()).toBe(2000);
    expect(budget.next()).toBeNull();
    budget.reset();
    expect(budget.next()).toBe(1000);
    const rate = bumpRate([0, 10], 20, 100, 2);
    expect(rate.ok).toBe(false);
    const summary = summarizeStats(
      [
        { id: "pair", type: "candidate-pair", nominated: true, localCandidateId: "local", currentRoundTripTime: 0.04 },
        { id: "local", type: "local-candidate", candidateType: "host" },
        { id: "out", type: "outbound-rtp", kind: "video", bytesSent: 1000, packetsSent: 10, framesPerSecond: 30, frameWidth: 1280, frameHeight: 720 },
      ],
      { atMs: 0, bytesSent: 0, packetsSent: 0 },
      1000,
    );
    expect(summary.route).toBe("direct");
    expect(summary.rttMs).toBe(40);
    expect(summary.lossRatio).toBeUndefined();
    expect(summary.bitrate).toBe(8000);
    const ice = encodeIcePayload({ candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 });
    const parsed = parseClientMessage(JSON.stringify({ type: "signal", kind: "ice", payload: ice }));
    expect(parsed.ok).toBe(true);
  });
});
