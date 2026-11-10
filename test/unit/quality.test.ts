import { describe, expect, it } from "vitest";
import { TIER_ORDER } from "../../src/shared/adaptive";
import { encodeQualityMessage, parseQualityMessage, qualityBadge, qualityBars, qualityLabel } from "../../src/shared/quality-label";
import { summarizeStats, type StatReport } from "../../src/shared/stats";

describe("quality badge", () => {
  it("names every tier in Russian and says when the video was lowered", () => {
    expect(qualityLabel("good")).toBe("Связь хорошая");
    expect(qualityLabel("ok")).toBe("Связь нормальная");
    expect(qualityLabel("weak")).toBe("Связь слабая, качество видео снижено");
    expect(qualityLabel("very-weak")).toBe("Связь очень слабая, качество видео снижено");
  });

  it("carries the meaning in text and bar count, not in colour alone", () => {
    expect(TIER_ORDER.map(qualityBars)).toEqual([1, 2, 3, 4]);
    for (const tier of TIER_ORDER) {
      const badge = qualityBadge(tier, null);
      expect(badge.text.length).toBeGreaterThan(0);
      expect(badge.spoken).toBe(`${badge.text}.`);
      expect(badge.peerText).toBeNull();
      expect(badge.bars).toBeGreaterThanOrEqual(1);
    }
    // No tier claims the video is off: the lowest one still has a lit bar.
    expect(qualityBadge("very-weak", null).bars).toBe(1);
  });

  it("mentions the other person only when their tier is really known", () => {
    expect(qualityBadge("good", null).spoken).not.toContain("собеседник");
    const both = qualityBadge("good", "weak");
    expect(both.peerText).toBe("У собеседника связь слабая");
    expect(both.spoken).toBe("Связь хорошая. У собеседника связь слабая.");
  });
});

describe("quality channel message", () => {
  it("carries only the tier and rejects anything else", () => {
    expect(encodeQualityMessage("weak")).toBe('{"v":1,"tier":"weak"}');
    for (const tier of TIER_ORDER) expect(parseQualityMessage(encodeQualityMessage(tier))).toBe(tier);
    expect(parseQualityMessage('{"v":1,"tier":"audio-only"}')).toBeNull();
    expect(parseQualityMessage('{"v":2,"tier":"good"}')).toBeNull();
    expect(parseQualityMessage("not json")).toBeNull();
    expect(parseQualityMessage("null")).toBeNull();
    expect(parseQualityMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseQualityMessage(JSON.stringify({ v: 1, tier: "good", pad: "x".repeat(100) }))).toBeNull();
  });
});

describe("getStats summary", () => {
  const chrome = (step: number): StatReport[] => [
    { id: "T", type: "transport", selectedCandidatePairId: "pair" },
    { id: "pair", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "local", currentRoundTripTime: 0.12, availableOutgoingBitrate: 900_000 },
    { id: "local", type: "local-candidate", candidateType: "relay" },
    { id: "ov", type: "outbound-rtp", kind: "video", bytesSent: 100_000 * step, packetsSent: 100 * step, framesPerSecond: 24, frameWidth: 640, frameHeight: 480, qualityLimitationReason: "bandwidth" },
    { id: "oa", type: "outbound-rtp", kind: "audio", packetsSent: 100 * step },
    { id: "rv", type: "remote-inbound-rtp", kind: "video", packetsLost: 5 * step, jitter: 0.02 },
    { id: "ra", type: "remote-inbound-rtp", kind: "audio", packetsLost: 10 * step, jitter: 0.045 },
    { id: "iv", type: "inbound-rtp", kind: "video", packetsReceived: 95 * step, packetsLost: 5 * step, framesDecoded: 45 * step, framesDropped: 5 * step, jitter: 0.03 },
    { id: "ia", type: "inbound-rtp", kind: "audio", packetsReceived: 95 * step, packetsLost: 5 * step, concealedSamples: 960 * step, totalSamplesReceived: 9_600 * step, jitter: 0.01 },
  ];

  it("reads loss, jitter, encoder limit, dropped frames and concealment from a full report", () => {
    const first = summarizeStats(chrome(1), undefined, 0);
    // Counters need two samples. One alone gives no interval.
    expect(first.lossRatio).toBeUndefined();
    expect(first.bitrate).toBeUndefined();
    const second = summarizeStats(chrome(2), first.counters, 2_000);
    expect(second.route).toBe("relay");
    expect(second.rttMs).toBe(120);
    expect(second.bitrate).toBe(400_000);
    // Audio lost 10 of 110, video 5 of 105. The worse leg is reported.
    expect(second.lossRatio).toBeCloseTo(10 / 110);
    expect(second.inboundLossRatio).toBeCloseTo(10 / 200);
    expect(second.jitterMs).toBe(45);
    expect(second.inboundJitterMs).toBe(30);
    expect(second.encoderLimit).toBe("bandwidth");
    expect(second.framesDroppedRatio).toBeCloseTo(0.1);
    expect(second.concealmentRatio).toBeCloseTo(0.1);
    expect(second.availableOutgoingBitrate).toBe(900_000);
    expect(second.width).toBe(640);
  });

  it("reports unknown, never zero, for what a Safari-like report leaves out", () => {
    const safari = (step: number): StatReport[] => [
      { id: "ov", type: "outbound-rtp", mediaType: "video", bytesSent: 50_000 * step, packetsSent: 100 * step },
      { id: "iv", type: "inbound-rtp", mediaType: "video", packetsReceived: 90 * step, packetsLost: 10 * step },
    ];
    const first = summarizeStats(safari(1), undefined, 0);
    const second = summarizeStats(safari(2), first.counters, 2_000);
    expect(second.route).toBe("unknown");
    expect(second.rttMs).toBeUndefined();
    expect(second.lossRatio).toBeUndefined();
    expect(second.jitterMs).toBeUndefined();
    expect(second.availableOutgoingBitrate).toBeUndefined();
    expect(second.encoderLimit).toBeUndefined();
    expect(second.framesDroppedRatio).toBeUndefined();
    expect(second.concealmentRatio).toBeUndefined();
    expect(second.inboundLossRatio).toBeCloseTo(0.1);
    expect(second.bitrate).toBe(200_000);
    expect(summarizeStats([], second.counters, 4_000).inboundLossRatio).toBeUndefined();
  });

  it("does not compare counters of two different connections", () => {
    const old = summarizeStats(chrome(50), undefined, 0);
    // A rebuilt connection starts its counters from zero.
    const fresh = summarizeStats(chrome(1), old.counters, 2_000);
    expect(fresh.bitrate).toBeUndefined();
    expect(fresh.lossRatio).toBeUndefined();
    expect(fresh.framesDroppedRatio).toBeUndefined();
  });
});
