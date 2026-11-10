import { describe, expect, it } from "vitest";
import { audioConstraints, openCallMedia, videoConstraints } from "../../src/client/open-media";

function failure(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("camera permission fallback", () => {
  it("falls back to audio when the camera is denied and reports a total denial", async () => {
    const calls: MediaStreamConstraints[] = [];
    const audioOnly = await openCallMedia({
      facingMode: "user",
      supported: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, facingMode: true },
      getUserMedia: async (constraints) => {
        calls.push(constraints);
        if (constraints.video) throw failure("NotAllowedError");
        return { getTracks: () => [] } as unknown as MediaStream;
      },
    });
    expect(audioOnly.ok).toBe(true);
    if (audioOnly.ok) expect(audioOnly.video).toBe(false);
    expect(calls).toHaveLength(2);

    const denied = await openCallMedia({
      facingMode: "user",
      supported: {},
      getUserMedia: async () => {
        throw failure("NotAllowedError");
      },
    });
    expect(denied).toEqual({ ok: false, reason: "denied" });
  });

  it("requests 720p with standard processing only when the browser lists support", () => {
    const video = videoConstraints({ facingMode: true }, "environment");
    expect(video.facingMode).toBe("environment");
    expect(video.height).toMatchObject({ ideal: 720 });
    const audio = audioConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: false, voiceIsolation: true });
    expect(audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, voiceIsolation: true });
    expect(audio).not.toHaveProperty("autoGainControl");
    expect(audio).toMatchObject({ channelCount: { ideal: 1 } });
    expect(audio).not.toHaveProperty("sampleRate");
  });
});
