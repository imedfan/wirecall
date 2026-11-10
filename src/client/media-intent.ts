import { scaleForHeight, TIER_PROFILES, type QualityTier } from "../shared/adaptive";

export interface MediaIntent {
  micEnabled: boolean;
  cameraEnabled: boolean;
}

export function freshMediaIntent(): MediaIntent {
  return { micEnabled: true, cameraEnabled: true };
}

export function toggleMediaIntent(intent: MediaIntent, kind: "audio" | "video"): boolean {
  if (kind === "audio") {
    intent.micEnabled = !intent.micEnabled;
    return intent.micEnabled;
  }
  intent.cameraEnabled = !intent.cameraEnabled;
  return intent.cameraEnabled;
}

export function applyMediaIntent(track: { kind: string; enabled: boolean }, intent: MediaIntent): void {
  if (track.kind === "audio") track.enabled = intent.micEnabled;
  else if (track.kind === "video") track.enabled = intent.cameraEnabled;
}

export interface VideoTrackControl {
  kind: string;
  enabled: boolean;
  applyConstraints(constraints: { width?: number; height?: number; frameRate?: number }): Promise<void>;
  getSettings(): { height?: number };
}

export interface VideoEncoding {
  active?: boolean;
  maxBitrate?: number;
  maxFramerate?: number;
  scaleResolutionDownBy?: number;
}

export interface VideoSenderControl {
  track: VideoTrackControl | null;
  getParameters(): { encodings: VideoEncoding[]; degradationPreference?: "balanced" | "maintain-framerate" | "maintain-resolution" };
  setParameters(params: { encodings: VideoEncoding[]; degradationPreference?: "balanced" | "maintain-framerate" | "maintain-resolution" }): Promise<void>;
  replaceTrack(track: VideoTrackControl | null): Promise<void>;
}

export interface VideoTierResult {
  videoPaused: boolean;
  applied: boolean;
}

export async function applyVideoTier(
  sender: VideoSenderControl,
  tier: QualityTier,
  intent: MediaIntent,
  heldVideo: VideoTrackControl | null,
): Promise<VideoTierResult> {
  if (heldVideo) applyMediaIntent(heldVideo, intent);
  if (sender.track && sender.track !== heldVideo) applyMediaIntent(sender.track, intent);

  if (tier === "audio-only") return pauseVideo(sender, intent, heldVideo);

  if (sender.track === null && heldVideo) {
    try {
      await sender.replaceTrack(heldVideo);
    } catch {
      applyMediaIntent(heldVideo, intent);
      return { videoPaused: true, applied: false };
    }
    applyMediaIntent(heldVideo, intent);
    if (sender.track === null) return { videoPaused: true, applied: false };
  }
  const profile = TIER_PROFILES[tier];
  const height = (sender.track ?? heldVideo)?.getSettings().height;
  try {
    // setParameters only accepts the object getParameters returned (transactionId, codecs), with fields changed in place.
    const params = sender.getParameters();
    params.encodings[0] = {
      ...(params.encodings[0] ?? {}),
      active: true,
      maxBitrate: profile.maxBitrate,
      maxFramerate: profile.maxFramerate,
      scaleResolutionDownBy: scaleForHeight(height, tier),
    };
    params.degradationPreference = "balanced";
    await sender.setParameters(params);
    const active = sender.getParameters().encodings[0]?.active;
    if (active !== false) {
      const track = sender.track ?? heldVideo;
      if (track) applyMediaIntent(track, intent);
      return { videoPaused: false, applied: true };
    }
  } catch {
    // Some Safari versions reject encoding fields. Resolution constraints are the fallback.
  }
  const track = sender.track ?? heldVideo;
  if (!track) return { videoPaused: false, applied: false };
  try {
    await track.applyConstraints({
      width: profile.targetHeight * (16 / 9),
      height: profile.targetHeight,
      frameRate: profile.maxFramerate,
    });
    applyMediaIntent(track, intent);
    return { videoPaused: false, applied: true };
  } catch {
    applyMediaIntent(track, intent);
    return { videoPaused: false, applied: false };
  }
}

async function pauseVideo(
  sender: VideoSenderControl,
  intent: MediaIntent,
  heldVideo: VideoTrackControl | null,
): Promise<VideoTierResult> {
  try {
    const params = sender.getParameters();
    params.encodings[0] = { ...(params.encodings[0] ?? {}), active: false };
    await sender.setParameters(params);
    if (sender.getParameters().encodings[0]?.active === false) {
      if (heldVideo) applyMediaIntent(heldVideo, intent);
      return { videoPaused: true, applied: true };
    }
  } catch {
    // Verified inactivity is required before the UI may say video stopped.
  }
  try {
    await sender.replaceTrack(null);
    if (sender.track === null) {
      if (heldVideo) applyMediaIntent(heldVideo, intent);
      return { videoPaused: true, applied: true };
    }
  } catch {
    // Leave the outgoing track untouched.
  }
  if (heldVideo) applyMediaIntent(heldVideo, intent);
  return { videoPaused: false, applied: false };
}

export function describeTierChange(input: {
  tier: QualityTier;
  previousPaused: boolean;
  failureAnnounced: boolean;
  result: VideoTierResult;
}): { videoPaused: boolean; status: string | null; failureAnnounced: boolean } {
  if (input.tier !== "audio-only") {
    return { videoPaused: input.result.videoPaused, status: null, failureAnnounced: false };
  }
  if (input.result.videoPaused) {
    return {
      videoPaused: true,
      status: input.previousPaused ? null : "Связь слабая. Оставили звук.",
      failureAnnounced: false,
    };
  }
  return {
    videoPaused: false,
    status: input.failureAnnounced ? null : "Связь слабая. Видео не удалось остановить.",
    failureAnnounced: true,
  };
}
