import { describe, expect, it } from "vitest";
import { applyMediaIntent, applyVideoTier, describeTierChange, freshMediaIntent, toggleMediaIntent, type VideoSenderControl, type VideoTrackControl } from "../../src/client/media-intent";

class Track implements VideoTrackControl {
  enabled = true;
  constraints: { height?: number } | null = null;
  constructor(readonly kind: "audio" | "video") {}
  applyConstraints(constraints: { height?: number }): Promise<void> {
    this.constraints = constraints;
    return Promise.resolve();
  }
  getSettings(): { height?: number } {
    return { height: 720 };
  }
}

function sender(options: {
  track: Track | null;
  setParameters: (params: { encodings: Array<{ active?: boolean }> }) => void;
  replaceTrack?: (track: VideoTrackControl | null) => void;
}): VideoSenderControl & { encodings: Array<{ active?: boolean }> } {
  const state = {
    track: options.track as VideoTrackControl | null,
    encodings: [{ active: true, maxBitrate: 1_000_000 }] as Array<{ active?: boolean; maxBitrate?: number }>,
  };
  return {
    get track() {
      return state.track;
    },
    encodings: state.encodings,
    getParameters: () => ({ encodings: state.encodings.map((item) => ({ ...item })) }),
    setParameters: async (params) => {
      options.setParameters(params);
      state.encodings.splice(0, state.encodings.length, ...params.encodings.map((item) => ({ ...item })));
    },
    replaceTrack: async (track) => {
      options.replaceTrack?.(track);
      state.track = track;
    },
  };
}

describe("media intent and verified video pause", () => {
  it("keeps a muted microphone and camera disabled on a replacement track", () => {
    const intent = freshMediaIntent();
    expect(toggleMediaIntent(intent, "audio")).toBe(false);
    expect(toggleMediaIntent(intent, "video")).toBe(false);
    const audio = new Track("audio");
    const video = new Track("video");
    applyMediaIntent(audio, intent);
    applyMediaIntent(video, intent);
    expect(audio.enabled).toBe(false);
    expect(video.enabled).toBe(false);
  });

  it("does not announce audio-only when neither pause method works", async () => {
    const held = new Track("video");
    held.enabled = false;
    const outgoing = sender({
      track: held,
      setParameters: () => {
        throw new Error("setParameters rejected");
      },
      replaceTrack: () => {
        throw new Error("replaceTrack rejected");
      },
    });
    const result = await applyVideoTier(outgoing, "audio-only", { micEnabled: false, cameraEnabled: false }, held);
    expect(result.videoPaused).toBe(false);
    expect(held.enabled).toBe(false);
    expect(outgoing.track).toBe(held);
    const status = describeTierChange({ tier: "audio-only", previousPaused: false, failureAnnounced: false, result });
    expect(status.status).toBe("Связь слабая. Видео не удалось остановить.");
    expect(status.videoPaused).toBe(false);
    const again = describeTierChange({ tier: "audio-only", previousPaused: false, failureAnnounced: true, result });
    expect(again.status).toBeNull();
  });

  it("pauses by detaching the sender and still restores the user's mute", async () => {
    const held = new Track("video");
    held.enabled = false;
    const outgoing = sender({
      track: held,
      setParameters: () => {
        throw new Error("setParameters rejected");
      },
    });
    const paused = await applyVideoTier(outgoing, "audio-only", { micEnabled: true, cameraEnabled: false }, held);
    expect(paused.videoPaused).toBe(true);
    expect(outgoing.track).toBeNull();
    expect(held.enabled).toBe(false);
    const announced = describeTierChange({ tier: "audio-only", previousPaused: false, failureAnnounced: false, result: paused });
    expect(announced.status).toBe("Связь слабая. Оставили звук.");

    const restored = await applyVideoTier(outgoing, "low", { micEnabled: true, cameraEnabled: false }, held);
    expect(restored.videoPaused).toBe(false);
    expect(outgoing.track).toBe(held);
    expect(held.enabled).toBe(false);
  });

  it("uses resolution constraints when setParameters fails and does not enable a muted camera", async () => {
    const held = new Track("video");
    held.enabled = false;
    const outgoing = sender({
      track: held,
      setParameters: () => {
        throw new Error("setParameters rejected");
      },
    });
    const result = await applyVideoTier(outgoing, "low", { micEnabled: false, cameraEnabled: false }, held);
    expect(result.applied).toBe(true);
    expect(result.videoPaused).toBe(false);
    expect(held.constraints?.height).toBe(360);
    expect(held.enabled).toBe(false);
  });

  it("trusts setParameters only when the sender reports the encoding inactive", async () => {
    const held = new Track("video");
    const outgoing = sender({ track: held, setParameters: () => undefined });
    const result = await applyVideoTier(outgoing, "audio-only", { micEnabled: true, cameraEnabled: true }, held);
    expect(result.videoPaused).toBe(true);
    expect(outgoing.track).toBe(held);
    expect(held.enabled).toBe(true);
    expect(outgoing.encodings[0]?.active).toBe(false);
  });
});
