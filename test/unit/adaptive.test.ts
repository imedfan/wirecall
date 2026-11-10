import { describe, expect, it } from "vitest";
import { AdaptiveController, scaleForHeight, scoreSample, START_TIER, TIER_ORDER, TIER_PROFILES, tierForScore, type NetworkSample, type QualityTier } from "../../src/shared/adaptive";

const good = { lossRatio: 0.001, rttMs: 40, availableOutgoingBitrate: 4_000_000 };
const bad = { lossRatio: 0.08, rttMs: 80, availableOutgoingBitrate: 4_000_000 };
const collapse = { lossRatio: 0.3, rttMs: 900 };

/** Feeds the same reading every two seconds and returns the tier after each one. */
function feed(controller: AdaptiveController, sample: Omit<NetworkSample, "atMs">, count: number, startMs: number): QualityTier[] {
  const tiers: QualityTier[] = [];
  for (let index = 0; index < count; index += 1) tiers.push(controller.observe({ atMs: startMs + index * 2_000, ...sample }).tier);
  return tiers;
}

describe("quality ladder", () => {
  it("has four tiers and every one of them sends video", () => {
    expect(TIER_ORDER).toEqual(["very-weak", "weak", "ok", "good"]);
    for (const tier of TIER_ORDER) {
      expect(TIER_PROFILES[tier].maxBitrate).toBeGreaterThan(0);
      expect(TIER_PROFILES[tier].maxFramerate).toBeGreaterThanOrEqual(12);
      expect(TIER_PROFILES[tier].targetHeight).toBeGreaterThanOrEqual(180);
    }
    // Smooth steps: each tier is cheaper than the one above, and none is more than three times cheaper.
    for (let index = 1; index < TIER_ORDER.length; index += 1) {
      const lower = TIER_PROFILES[TIER_ORDER[index - 1]!];
      const upper = TIER_PROFILES[TIER_ORDER[index]!];
      expect(lower.maxBitrate).toBeLessThan(upper.maxBitrate);
      expect(upper.maxBitrate / lower.maxBitrate).toBeLessThanOrEqual(3);
    }
    expect(TIER_PROFILES.good.targetHeight).toBe(720);
  });

  it("starts on a sensible video tier and ignores a burst inside the sample gap", () => {
    const controller = new AdaptiveController();
    expect(START_TIER).toBe("good");
    expect(controller.current()).toBe("good");
    expect(controller.observe({ atMs: 0, ...bad }).changed).toBe(false);
    expect(controller.observe({ atMs: 500, ...bad }).reason).toBe("gap");
    expect(controller.current()).toBe("good");
  });

  it("walks down one tier at a time under a sustained bad link and stops at the lowest video tier", () => {
    const controller = new AdaptiveController();
    const tiers = feed(controller, { lossRatio: 0.2, rttMs: 600 }, 40, 0);
    const visited = tiers.filter((tier, index) => tier !== tiers[index - 1]);
    expect(visited).toEqual(["ok", "weak", "very-weak"]);
    expect(controller.current()).toBe("very-weak");
    const more = controller.observe({ atMs: 200_000, lossRatio: 0.5, rttMs: 2_000 });
    expect(more.tier).toBe("very-weak");
    expect(more.changed).toBe(false);
    expect(more.reason).toBe("floor");
  });

  it("settles on the tier the link deserves instead of always falling to the bottom", () => {
    const controller = new AdaptiveController();
    // About 4% loss is an «ok» link: not clean, not broken.
    feed(controller, { lossRatio: 0.04, rttMs: 100 }, 20, 0);
    expect(controller.current()).toBe("ok");
  });

  it("takes one step on a collapse, not two, and never turns the video off", () => {
    const controller = new AdaptiveController();
    const first = controller.observe({ atMs: 0, ...collapse });
    expect(first.changed).toBe(true);
    expect(first.reason).toBe("severe");
    expect(first.tier).toBe("ok");
    // The cooldown holds the next step even though the link is still collapsing.
    expect(controller.observe({ atMs: 2_000, ...collapse }).reason).toBe("cooldown");
    expect(controller.observe({ atMs: 4_000, ...collapse }).tier).toBe("ok");
    expect(controller.observe({ atMs: 6_000, ...collapse }).tier).toBe("weak");
    expect(TIER_ORDER).toContain(controller.current());
  });

  it("does not move on a single spike or on alternating good and bad samples", () => {
    const controller = new AdaptiveController();
    feed(controller, good, 3, 0);
    controller.observe({ atMs: 6_000, lossRatio: 0.1, rttMs: 60, availableOutgoingBitrate: 4_000_000 });
    feed(controller, good, 3, 8_000);
    expect(controller.current()).toBe("good");
    for (let index = 0; index < 12; index += 1) {
      controller.observe({ atMs: 20_000 + index * 2_000, ...(index % 2 === 0 ? { ...good, lossRatio: 0.07 } : good) });
    }
    expect(controller.current()).toBe("good");
  });

  it("goes down faster than it comes back up", () => {
    const controller = new AdaptiveController();
    const down = feed(controller, bad, 10, 0);
    const downAfter = down.indexOf("ok") + 1;
    expect(downAfter).toBeGreaterThan(0);
    expect(downAfter).toBeLessThanOrEqual(3);
    const start = 60_000;
    const up = feed(controller, good, 20, start);
    const upAfter = up.indexOf("good") + 1;
    expect(upAfter).toBeGreaterThanOrEqual(5);
    expect(upAfter).toBeGreaterThan(downAfter);
  });

  it("holds a fresh tier for the cooldown in both directions", () => {
    const controller = new AdaptiveController();
    controller.observe({ atMs: 0, ...bad });
    expect(controller.observe({ atMs: 2_000, ...bad }).tier).toBe("ok");
    const cooled = controller.observe({ atMs: 4_000, lossRatio: 0.2 });
    expect(cooled.changed).toBe(false);
    // Good samples right after a change count toward the streak but may not act before 12 seconds have passed.
    const fresh = new AdaptiveController();
    fresh.observe({ atMs: 0, ...collapse });
    const tiers = feed(fresh, good, 6, 2_000);
    expect(tiers.slice(0, 5)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  it("climbs only on a long clean streak and one tier at a time", () => {
    const controller = new AdaptiveController();
    feed(controller, { lossRatio: 0.2, rttMs: 600 }, 40, 0);
    expect(controller.current()).toBe("very-weak");
    const tiers = feed(controller, good, 40, 200_000);
    const visited = tiers.filter((tier, index) => tier !== tiers[index - 1]);
    expect(visited).toEqual(["very-weak", "weak", "ok", "good"]);
    // At least five clean samples sit between any two steps.
    const steps = tiers.map((tier, index) => (tier !== tiers[index - 1] && index > 0 ? index : -1)).filter((index) => index > 0);
    for (let index = 1; index < steps.length; index += 1) expect(steps[index]! - steps[index - 1]!).toBeGreaterThanOrEqual(5);
  });

  it("does not climb when the bitrate estimate cannot carry the next tier", () => {
    const controller = new AdaptiveController();
    controller.observe({ atMs: 0, ...collapse });
    const tight = { lossRatio: 0.001, rttMs: 40, availableOutgoingBitrate: 900_000 };
    feed(controller, tight, 20, 20_000);
    expect(controller.current()).toBe("ok");
    feed(controller, good, 10, 100_000);
    expect(controller.current()).toBe("good");
  });

  it("steps down when the bitrate estimate cannot carry the current tier", () => {
    const controller = new AdaptiveController();
    const tiers = feed(controller, { lossRatio: 0, rttMs: 40, availableOutgoingBitrate: 500_000 }, 6, 0);
    expect(tiers[tiers.length - 1]).toBe("ok");
  });

  it("holds the tier and does not crash when getStats gives nothing", () => {
    const controller = new AdaptiveController();
    const decision = controller.observe({ atMs: 0 });
    expect(decision.changed).toBe(false);
    expect(decision.reason).toBe("unknown");
    expect(decision.score).toBeNull();
    feed(controller, {}, 10, 2_000);
    expect(controller.current()).toBe("good");
  });

  it("still lowers and raises the tier on Safari-like stats without bitrate or RTT", () => {
    const controller = new AdaptiveController();
    feed(controller, { lossRatio: 0.09 }, 6, 0);
    expect(controller.current()).not.toBe("good");
    const lowered = controller.current();
    feed(controller, { lossRatio: 0.002 }, 30, 100_000);
    expect(TIER_ORDER.indexOf(controller.current())).toBeGreaterThan(TIER_ORDER.indexOf(lowered));
  });

  it("uses dropped frames, incoming loss or the encoder's own limit when nothing else is reported", () => {
    const frames = new AdaptiveController();
    feed(frames, { framesDroppedRatio: 0.3 }, 6, 0);
    expect(frames.current()).not.toBe("good");

    const inbound = new AdaptiveController();
    feed(inbound, { inboundLossRatio: 0.1 }, 6, 0);
    expect(inbound.current()).not.toBe("good");

    const limited = new AdaptiveController();
    // One report of a limited encoder is not a trend.
    limited.observe({ atMs: 0, encoderLimit: "bandwidth" });
    expect(limited.current()).toBe("good");
    feed(limited, { encoderLimit: "bandwidth" }, 6, 2_000);
    expect(limited.current()).toBe("ok");
    // A limited encoder also blocks the way back up.
    feed(limited, { lossRatio: 0, encoderLimit: "bandwidth" }, 20, 100_000);
    expect(limited.current()).toBe("ok");
  });

  it("waits longer before each new climb that the link did not hold", () => {
    const controller = new AdaptiveController();
    controller.observe({ atMs: 0, ...collapse });
    const clean = { lossRatio: 0.001 };
    const dirty = { lossRatio: 0.09 };
    let now = 10_000;
    const climb = (): number => {
      const start = now;
      while (controller.current() !== "good") {
        controller.observe({ atMs: now, ...clean });
        now += 2_000;
        if (now - start > 600_000) throw new Error("never climbed");
      }
      return now - start;
    };
    const fall = (): void => {
      while (controller.current() === "good") {
        controller.observe({ atMs: now, ...dirty });
        now += 2_000;
      }
    };
    // The first climb also has to live down the collapse, so the comparison starts with the second.
    climb();
    fall();
    const second = climb();
    fall();
    const third = climb();
    fall();
    const fourth = climb();
    expect(third).toBeGreaterThan(second);
    expect(fourth).toBeGreaterThan(third);
  });

  it("starts a new call from the start tier, not from where the last one ended", () => {
    const controller = new AdaptiveController();
    feed(controller, { lossRatio: 0.2, rttMs: 600 }, 40, 0);
    expect(controller.current()).toBe("very-weak");
    controller.reset();
    expect(controller.current()).toBe(START_TIER);
    expect(controller.score()).toBeNull();
    // The old cooldowns and averages are gone too: a clean link keeps the top tier from the first sample.
    feed(controller, good, 3, 0);
    expect(controller.current()).toBe("good");
  });

  it("scales by the real frame size and never enlarges", () => {
    expect(scaleForHeight(720, "good")).toBe(1);
    expect(scaleForHeight(720, "ok")).toBeCloseTo(1.5);
    expect(scaleForHeight(720, "weak")).toBe(2);
    expect(scaleForHeight(720, "very-weak")).toBe(3);
    expect(scaleForHeight(1080, "weak")).toBe(3);
    expect(scaleForHeight(360, "good")).toBe(1);
    expect(scaleForHeight(undefined, "good")).toBe(1);
    expect(scaleForHeight(undefined, "weak")).toBe(2);
  });
});

describe("link score", () => {
  it("rates a clean link 100 and names the tier for each band", () => {
    expect(scoreSample({ lossRatio: 0.005, rttMs: 60, jitterMs: 10 })).toBe(100);
    expect(tierForScore(100)).toBe("good");
    expect(tierForScore(80)).toBe("good");
    expect(tierForScore(79)).toBe("ok");
    expect(tierForScore(55)).toBe("ok");
    expect(tierForScore(54)).toBe("weak");
    expect(tierForScore(30)).toBe("weak");
    expect(tierForScore(29)).toBe("very-weak");
    expect(tierForScore(0)).toBe("very-weak");
  });

  it("lets the weakest signal decide", () => {
    expect(tierForScore(scoreSample({ lossRatio: 0.02, rttMs: 150 })!)).toBe("good");
    expect(tierForScore(scoreSample({ lossRatio: 0.04, rttMs: 60 })!)).toBe("ok");
    expect(tierForScore(scoreSample({ lossRatio: 0.001, rttMs: 300 })!)).toBe("ok");
    expect(tierForScore(scoreSample({ lossRatio: 0.08, rttMs: 60 })!)).toBe("weak");
    expect(tierForScore(scoreSample({ lossRatio: 0.001, rttMs: 500 })!)).toBe("weak");
    expect(tierForScore(scoreSample({ lossRatio: 0.2, rttMs: 60 })!)).toBe("very-weak");
    expect(tierForScore(scoreSample({ lossRatio: 0.001, rttMs: 60, jitterMs: 150 })!)).toBe("very-weak");
    expect(tierForScore(scoreSample({ framesDroppedRatio: 0.15 })!)).toBe("ok");
  });

  it("treats a missing field as unknown, not as zero", () => {
    expect(scoreSample({})).toBeNull();
    expect(scoreSample({ availableOutgoingBitrate: 100_000 })).toBeNull();
    expect(scoreSample({ rttMs: Number.NaN })).toBeNull();
    expect(scoreSample({ rttMs: 60 })).toBe(100);
    // Incoming loss stands in only when outgoing loss is unknown.
    expect(scoreSample({ inboundLossRatio: 0.2 })).toBe(0);
    expect(scoreSample({ lossRatio: 0.001, inboundLossRatio: 0.2 })).toBe(100);
  });

  it("caps the score while the encoder limits itself", () => {
    expect(scoreSample({ lossRatio: 0, rttMs: 40, encoderLimit: "bandwidth" })).toBe(70);
    expect(scoreSample({ lossRatio: 0, rttMs: 40, encoderLimit: "cpu" })).toBe(70);
    expect(scoreSample({ lossRatio: 0, rttMs: 40, encoderLimit: "none" })).toBe(100);
    expect(scoreSample({ lossRatio: 0.2, encoderLimit: "bandwidth" })).toBe(0);
  });
});
