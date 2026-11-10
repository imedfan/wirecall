import { describe, expect, it } from "vitest";
import { AdaptiveController, scaleForHeight } from "../../src/shared/adaptive";

const good = { lossRatio: 0.001, rttMs: 40, availableOutgoingBitrate: 4_000_000 };
const bad = { lossRatio: 0.08, rttMs: 80, availableOutgoingBitrate: 2_000_000 };

describe("adaptive controller", () => {
  it("starts at a sensible 720p-class ceiling and ignores a burst inside the sample gap", () => {
    const controller = new AdaptiveController();
    expect(controller.current()).toBe("medium");
    expect(controller.observe({ atMs: 0, ...bad }).changed).toBe(false);
    expect(controller.observe({ atMs: 500, ...bad }).reason).toBe("gap");
    expect(controller.current()).toBe("medium");
  });

  it("steps down after sustained loss and does not flap on alternating samples", () => {
    const controller = new AdaptiveController();
    controller.observe({ atMs: 0, ...bad });
    const down = controller.observe({ atMs: 2_000, ...bad });
    expect(down.changed).toBe(true);
    expect(down.tier).toBe("low");
    controller.observe({ atMs: 10_000, ...good });
    controller.observe({ atMs: 12_000, ...bad });
    controller.observe({ atMs: 20_000, ...good });
    controller.observe({ atMs: 22_000, ...bad });
    expect(controller.current()).toBe("low");
  });

  it("holds the tier when getStats fields are missing", () => {
    const controller = new AdaptiveController();
    const decision = controller.observe({ atMs: 0 });
    expect(decision.changed).toBe(false);
    expect(decision.reason).toBe("unknown");
    expect(controller.current()).toBe("medium");
  });

  it("uses a severe sample as an immediate step toward audio and then recovers one tier at a time", () => {
    const controller = new AdaptiveController();
    const severe = controller.observe({ atMs: 0, lossRatio: 0.2, rttMs: 900 });
    expect(severe.tier).toBe("low");
    const audio = controller.observe({ atMs: 8_000, lossRatio: 0.2 });
    expect(audio.tier).toBe("audio-only");
    for (let index = 0; index < 4; index += 1) {
      controller.observe({ atMs: 30_000 + index * 2_000, lossRatio: 0.001, rttMs: 50, availableOutgoingBitrate: 4_000_000 });
    }
    const recovered = controller.observe({ atMs: 50_000, lossRatio: 0.001, rttMs: 50, availableOutgoingBitrate: 4_000_000 });
    expect(recovered.tier).toBe("low");
    expect(recovered.tier).not.toBe("high");
  });

  it("refuses high quality until bitrate is known and sufficient", () => {
    const controller = new AdaptiveController();
    for (let index = 0; index < 5; index += 1) {
      controller.observe({ atMs: index * 2_000, lossRatio: 0, rttMs: 30 });
    }
    expect(controller.current()).toBe("medium");
    const manual = controller.requestUpgrade(20_000);
    expect(manual.tier).toBe("high");
    expect(scaleForHeight(1080, "low")).toBeCloseTo(3);
    expect(scaleForHeight(undefined, "medium")).toBe(1);
  });

  it("respects cooldown so a bad streak cannot oscillate the ceiling", () => {
    const controller = new AdaptiveController();
    controller.observe({ atMs: 0, ...bad });
    controller.observe({ atMs: 2_000, ...bad });
    const cooled = controller.observe({ atMs: 4_000, lossRatio: 0.2 });
    expect(cooled.changed).toBe(false);
    expect(cooled.reason).toBe("cooldown");
  });
});
