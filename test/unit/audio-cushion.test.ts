import { describe, expect, it } from "vitest";
import { AudioCushion } from "../../src/shared/audio-cushion";

function feed(cushion: AudioCushion, ratio: number | undefined, count: number) {
  let last = cushion.observe(ratio);
  for (let index = 1; index < count; index += 1) last = cushion.observe(ratio);
  return last;
}

describe("buffer for incoming voice", () => {
  it("leaves a clean link on the browser's own buffer", () => {
    const cushion = new AudioCushion();
    expect(feed(cushion, 0, 60)).toEqual({ targetMs: null, changed: false });
    expect(feed(cushion, undefined, 10)).toEqual({ targetMs: null, changed: false });
  });

  it("deepens after two rough readings in a row, one step at a time, and not on a single spike", () => {
    const cushion = new AudioCushion();
    expect(cushion.observe(0.2)).toEqual({ targetMs: null, changed: false });
    expect(cushion.observe(0)).toEqual({ targetMs: null, changed: false });
    expect(cushion.observe(0.05).changed).toBe(false);
    expect(cushion.observe(0.05)).toEqual({ targetMs: 100, changed: true });
    expect(cushion.observe(0.05)).toEqual({ targetMs: 100, changed: false });
    expect(cushion.observe(0.05)).toEqual({ targetMs: 200, changed: true });
    // There is no step above the deepest one.
    expect(feed(cushion, 0.3, 10)).toEqual({ targetMs: 200, changed: false });
  });

  it("gives the delay back only after a long clean stretch", () => {
    const cushion = new AudioCushion();
    feed(cushion, 0.05, 2);
    expect(feed(cushion, 0.001, 14)).toEqual({ targetMs: 100, changed: false });
    expect(cushion.observe(0.001)).toEqual({ targetMs: null, changed: true });
    // A reading between rough and clean, or none at all, restarts neither count in its favour.
    feed(cushion, 0.05, 2);
    feed(cushion, 0.001, 10);
    cushion.observe(0.01);
    expect(feed(cushion, 0.001, 14).targetMs).toBe(100);
    expect(cushion.observe(0.001).targetMs).toBeNull();
  });
});
