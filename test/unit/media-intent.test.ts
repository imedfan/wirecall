import { describe, expect, it } from "vitest";
import { TIER_ORDER, TIER_PROFILES } from "../../src/shared/adaptive";
import {
  applyMediaIntent,
  applyVideoTier,
  AUDIO_MAX_BITRATE,
  captureSize,
  freshMediaIntent,
  toggleMediaIntent,
  tuneAudioSender,
  type SenderParameters,
  type VideoSenderControl,
  type VideoTrackControl,
} from "../../src/client/media-intent";

class Track implements VideoTrackControl {
  enabled = true;
  stopped = false;
  constraints: { width?: number; height?: number; frameRate?: number } | null = null;
  constructor(
    readonly kind: "audio" | "video",
    private readonly size: { width?: number; height?: number } = { width: 1280, height: 720 },
  ) {}
  applyConstraints(constraints: { width?: number; height?: number; frameRate?: number }): Promise<void> {
    this.constraints = constraints;
    return Promise.resolve();
  }
  getSettings(): { width?: number; height?: number } {
    return this.size;
  }
  stop(): void {
    this.stopped = true;
  }
}

/** A sender that keeps what it is given and counts every attempt to take the video away. */
function sender(track: Track | null, reject: (params: SenderParameters) => boolean = () => false) {
  const state = {
    encodings: [{ active: true }] as SenderParameters["encodings"],
    degradationPreference: undefined as string | undefined,
    replaced: 0,
    calls: [] as SenderParameters[],
  };
  const control: VideoSenderControl & { replaceTrack: (next: unknown) => Promise<void> } = {
    get track() {
      return track;
    },
    getParameters: () => ({ encodings: state.encodings.map((item) => ({ ...item })), degradationPreference: state.degradationPreference }),
    setParameters: async (params) => {
      state.calls.push({ encodings: params.encodings.map((item) => ({ ...item })), degradationPreference: params.degradationPreference });
      if (reject(params)) throw new Error("rejected");
      state.encodings = params.encodings.map((item) => ({ ...item }));
      state.degradationPreference = params.degradationPreference;
    },
    replaceTrack: async () => {
      state.replaced += 1;
    },
  };
  return { control, state };
}

describe("media intent", () => {
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
});

describe("video tier limits", () => {
  it("only limits the video on every tier and never takes it away", async () => {
    for (const tier of TIER_ORDER) {
      const track = new Track("video");
      const { control, state } = sender(track);
      const result = await applyVideoTier(control, tier, freshMediaIntent());
      expect(result).toEqual({ applied: true, via: "parameters" });
      const encoding = state.encodings[0]!;
      expect(encoding.active).toBe(true);
      expect(encoding.maxBitrate).toBe(TIER_PROFILES[tier].maxBitrate);
      expect(encoding.maxFramerate).toBe(TIER_PROFILES[tier].maxFramerate);
      expect(encoding.scaleResolutionDownBy).toBeGreaterThanOrEqual(1);
      expect(state.degradationPreference).toBe("balanced");
      expect(state.replaced).toBe(0);
      expect(control.track).toBe(track);
      expect(track.enabled).toBe(true);
      expect(track.stopped).toBe(false);
      expect(state.calls.every((call) => call.encodings.every((item) => item.active !== false))).toBe(true);
    }
  });

  it("keeps the lowest tier sending a small picture", async () => {
    const track = new Track("video");
    const { control, state } = sender(track);
    await applyVideoTier(control, "very-weak", freshMediaIntent());
    expect(state.encodings[0]).toMatchObject({ active: true, maxBitrate: 150_000, maxFramerate: 15, scaleResolutionDownBy: 3 });
    expect(state.replaced).toBe(0);
    expect(track.enabled).toBe(true);
  });

  it("turns an encoding back on if something left it inactive", async () => {
    const track = new Track("video");
    const { control, state } = sender(track);
    state.encodings = [{ active: false }];
    await applyVideoTier(control, "weak", freshMediaIntent());
    expect(state.encodings[0]?.active).toBe(true);
  });

  it("leaves the camera off when the person turned it off, on every tier", async () => {
    for (const tier of TIER_ORDER) {
      const track = new Track("video");
      track.enabled = false;
      const { control, state } = sender(track);
      await applyVideoTier(control, tier, { micEnabled: true, cameraEnabled: false });
      expect(track.enabled).toBe(false);
      expect(state.replaced).toBe(0);
    }
    // And a track that came back enabled, as after a camera switch, is put back to the person's choice.
    const fresh = new Track("video");
    const { control } = sender(fresh);
    await applyVideoTier(control, "good", { micEnabled: true, cameraEnabled: false });
    expect(fresh.enabled).toBe(false);
  });

  it("scales by the shorter side, so an upright iPhone frame is treated as 720p", async () => {
    const upright = new Track("video", { width: 720, height: 1280 });
    const { control, state } = sender(upright);
    await applyVideoTier(control, "good", freshMediaIntent());
    expect(state.encodings[0]?.scaleResolutionDownBy).toBe(1);
    await applyVideoTier(control, "weak", freshMediaIntent());
    expect(state.encodings[0]?.scaleResolutionDownBy).toBe(2);
  });

  it("sends the limits again without the degradation preference when a browser rejects it", async () => {
    const track = new Track("video");
    const { control, state } = sender(track, (params) => params.degradationPreference !== undefined);
    const result = await applyVideoTier(control, "ok", freshMediaIntent());
    expect(result.via).toBe("parameters");
    expect(state.encodings[0]?.maxBitrate).toBe(600_000);
  });

  it("falls back to capture constraints in the camera's own proportions when setParameters fails", async () => {
    const upright = new Track("video", { width: 720, height: 1280 });
    upright.enabled = false;
    const { control, state } = sender(upright, () => true);
    const result = await applyVideoTier(control, "weak", { micEnabled: false, cameraEnabled: false });
    expect(result).toEqual({ applied: true, via: "constraints" });
    expect(upright.constraints).toEqual({ width: 360, height: 640, frameRate: 20 });
    expect(upright.enabled).toBe(false);
    expect(state.replaced).toBe(0);

    const wide = new Track("video", { width: 1280, height: 720 });
    await applyVideoTier(sender(wide, () => true).control, "weak", freshMediaIntent());
    expect(wide.constraints).toEqual({ width: 640, height: 360, frameRate: 20 });
  });

  it("never asks the camera for a larger frame than it gives", () => {
    expect(captureSize({ width: 640, height: 360 }, 720, 30)).toEqual({ width: 640, height: 360, frameRate: 30 });
    expect(captureSize({}, 360, 20)).toEqual({ height: 360, frameRate: 20 });
  });
});

describe("audio sender", () => {
  function audio(reject: (params: SenderParameters) => boolean = () => false, encodings: SenderParameters["encodings"] = [{}]) {
    const state = { encodings, calls: 0 };
    return {
      state,
      control: {
        getParameters: () => ({ encodings: state.encodings.map((item) => ({ ...item })) }),
        setParameters: async (params: SenderParameters) => {
          state.calls += 1;
          if (reject(params)) throw new Error("rejected");
          state.encodings = params.encodings.map((item) => ({ ...item }));
        },
      },
    };
  }

  it("caps the bitrate and asks for high priority", async () => {
    const { control, state } = audio();
    expect(await tuneAudioSender(control)).toBe("priority");
    expect(state.encodings[0]).toEqual({ maxBitrate: AUDIO_MAX_BITRATE, priority: "high", networkPriority: "high" });
    expect(AUDIO_MAX_BITRATE).toBe(40_000);
  });

  it("falls back to the cap alone when the priority fields are rejected", async () => {
    const { control, state } = audio((params) => params.encodings[0]?.networkPriority !== undefined);
    expect(await tuneAudioSender(control)).toBe("bitrate");
    expect(state.encodings[0]).toEqual({ maxBitrate: AUDIO_MAX_BITRATE });
  });

  it("leaves the sender alone when nothing is accepted or there is no encoding yet", async () => {
    const refused = audio(() => true);
    expect(await tuneAudioSender(refused.control)).toBe("none");
    expect(refused.state.encodings[0]).toEqual({});
    const empty = audio(() => false, []);
    expect(await tuneAudioSender(empty.control)).toBe("none");
    expect(empty.state.calls).toBe(0);
  });
});
