export type FacingMode = "user" | "environment";

export interface MediaDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  supported: Record<string, boolean> | null;
  facingMode: FacingMode;
}

export type MediaFailure = "denied" | "missing" | "busy" | "failed";

export type OpenedMedia =
  | { ok: true; stream: MediaStream; audio: boolean; video: boolean }
  | { ok: false; reason: MediaFailure };

const AUDIO_KEYS = ["echoCancellation", "noiseSuppression", "autoGainControl"] as const;

export function audioConstraints(supported: Record<string, boolean> | null): MediaTrackConstraints | boolean {
  const keys =
    !supported || Object.keys(supported).length === 0
      ? [...AUDIO_KEYS]
      : AUDIO_KEYS.filter((key) => supported[key]);
  const audio: MediaTrackConstraints & { voiceIsolation?: boolean } = {};
  for (const key of keys) audio[key] = true;
  if (supported?.voiceIsolation) audio.voiceIsolation = true;
  return audio;
}

export function videoConstraints(supported: Record<string, boolean> | null, facingMode: FacingMode): MediaTrackConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 30, max: 30 },
  };
  if (!supported || supported.facingMode !== false) video.facingMode = facingMode;
  return video;
}

export async function openCallMedia(deps: MediaDeps): Promise<OpenedMedia> {
  const audio = audioConstraints(deps.supported);
  const video = videoConstraints(deps.supported, deps.facingMode);
  const both = await ask(deps, { audio, video });
  if (both.ok) return { ok: true, stream: both.stream, audio: true, video: true };
  if (both.reason === "denied" || both.reason === "missing" || both.reason === "failed" || both.reason === "busy") {
    const mic = await ask(deps, { audio, video: false });
    if (mic.ok) return { ok: true, stream: mic.stream, audio: true, video: false };
    const camera = await ask(deps, { audio: false, video });
    if (camera.ok) return { ok: true, stream: camera.stream, audio: false, video: true };
    return { ok: false, reason: both.reason };
  }
  return { ok: false, reason: "failed" };
}

async function ask(
  deps: MediaDeps,
  constraints: MediaStreamConstraints,
): Promise<{ ok: true; stream: MediaStream } | { ok: false; reason: MediaFailure }> {
  try {
    const stream = await deps.getUserMedia(constraints);
    return { ok: true, stream };
  } catch (error) {
    const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
      return { ok: false, reason: "denied" };
    }
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
      return { ok: false, reason: "missing" };
    }
    if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
      return { ok: false, reason: "busy" };
    }
    return { ok: false, reason: "failed" };
  }
}
