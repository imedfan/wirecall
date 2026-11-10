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
  getSettings(): { width?: number; height?: number };
}

export interface VideoEncoding {
  active?: boolean;
  maxBitrate?: number;
  maxFramerate?: number;
  scaleResolutionDownBy?: number;
  priority?: string;
  networkPriority?: string;
}

export interface SenderParameters {
  encodings: VideoEncoding[];
  degradationPreference?: string;
}

export interface VideoSenderControl {
  track: VideoTrackControl | null;
  getParameters(): SenderParameters;
  setParameters(params: SenderParameters): Promise<void>;
}

export interface AudioSenderControl {
  getParameters(): SenderParameters;
  setParameters(params: SenderParameters): Promise<void>;
}

export interface VideoTierResult {
  /** The limits are in force, by sender parameters or by capture constraints. */
  applied: boolean;
  via: "parameters" | "constraints" | "none";
}

/** Speech stays clear at this rate, and it leaves the rest of a thin link to the picture. */
export const AUDIO_MAX_BITRATE = 40_000;

/**
 * Puts a tier's limits on outgoing video: bitrate, frame rate and frame size. It only ever makes the
 * video cheaper. It never deactivates the encoding, detaches the track or disables it: the picture
 * stays on every tier, and only the person's own camera button turns it off.
 */
export async function applyVideoTier(sender: VideoSenderControl, tier: QualityTier, intent: MediaIntent): Promise<VideoTierResult> {
  const track = sender.track;
  if (track) applyMediaIntent(track, intent);
  const profile = TIER_PROFILES[tier];
  const settings = track?.getSettings() ?? {};
  const shortSide = shorter(settings.width, settings.height);
  try {
    // setParameters only accepts the object getParameters returned (transactionId, codecs), with fields changed in place.
    const params = sender.getParameters();
    params.encodings[0] = {
      ...(params.encodings[0] ?? {}),
      active: true,
      maxBitrate: profile.maxBitrate,
      maxFramerate: profile.maxFramerate,
      scaleResolutionDownBy: scaleForHeight(shortSide, tier),
    };
    try {
      params.degradationPreference = "balanced";
      await sender.setParameters(params);
    } catch {
      // Some browsers reject the preference. The limits matter more, so they are sent again without it.
      const plain = sender.getParameters();
      plain.encodings[0] = { ...(plain.encodings[0] ?? {}), ...params.encodings[0] };
      await sender.setParameters(plain);
    }
    if (track) applyMediaIntent(track, intent);
    return { applied: true, via: "parameters" };
  } catch {
    // Some Safari versions reject encoding fields. Capture constraints are the fallback.
  }
  if (!track) return { applied: false, via: "none" };
  try {
    await track.applyConstraints(captureSize(settings, profile.targetHeight, profile.maxFramerate));
    applyMediaIntent(track, intent);
    return { applied: true, via: "constraints" };
  } catch {
    applyMediaIntent(track, intent);
    return { applied: false, via: "none" };
  }
}

/**
 * Keeps the proportions the camera really delivers. An iPhone held upright is 720 by 1280,
 * and forcing 16:9 on it would crop or fail.
 */
export function captureSize(
  settings: { width?: number; height?: number },
  targetShortSide: number,
  frameRate: number,
): { width?: number; height?: number; frameRate: number } {
  const { width, height } = settings;
  if (!width || !height) return { height: targetShortSide, frameRate };
  const scale = Math.min(1, targetShortSide / Math.min(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale), frameRate };
}

/**
 * Voice goes first on a thin link. The cap keeps Opus modest so the adaptation never has to touch it,
 * and the priority asks the browser to send audio packets ahead of video.
 */
export async function tuneAudioSender(sender: AudioSenderControl): Promise<"priority" | "bitrate" | "none"> {
  try {
    const params = sender.getParameters();
    if (!params.encodings[0]) return "none";
    params.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
    params.encodings[0].priority = "high";
    params.encodings[0].networkPriority = "high";
    await sender.setParameters(params);
    return "priority";
  } catch {
    // The priority fields are not accepted everywhere. The cap alone is still worth having.
  }
  try {
    const params = sender.getParameters();
    if (!params.encodings[0]) return "none";
    delete params.encodings[0].priority;
    delete params.encodings[0].networkPriority;
    params.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
    await sender.setParameters(params);
    return "bitrate";
  } catch {
    return "none";
  }
}

function shorter(width: number | undefined, height: number | undefined): number | undefined {
  if (width && height) return Math.min(width, height);
  return height || width || undefined;
}
