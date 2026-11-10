export interface CodecCap {
  mimeType: string;
  sdpFmtpLine?: string;
}

export function preferredVideoCodecs(available: readonly CodecCap[]): CodecCap[] {
  const ranked = available
    .map((codec) => ({ codec, rank: videoRank(codec) }))
    .filter((entry) => entry.rank < 99)
    .sort((left, right) => left.rank - right.rank);
  if (ranked.length === 0) return [];
  // Without rtx/red/ulpfec the browser loses retransmission and bandwidth probing on lossy links.
  const repair = available.filter((codec) => REPAIR_MIMES.has(codec.mimeType.toLowerCase()));
  return [...ranked.map((entry) => entry.codec), ...repair];
}

const REPAIR_MIMES = new Set(["video/rtx", "video/red", "video/ulpfec", "video/flexfec-03"]);

export function preferredAudioCodecs(available: readonly CodecCap[]): CodecCap[] {
  const opusIndex = available.findIndex((codec) => codec.mimeType.toLowerCase() === "audio/opus");
  if (opusIndex <= 0) return [...available];
  const next = [...available];
  const [opus] = next.splice(opusIndex, 1);
  if (!opus) return [...available];
  next.unshift(opus);
  return next;
}

function videoRank(codec: CodecCap): number {
  const mime = codec.mimeType.toLowerCase();
  if (mime === "video/h264" && codec.sdpFmtpLine?.includes("packetization-mode=1")) return 0;
  if (mime === "video/h264") return 1;
  if (mime === "video/vp8") return 2;
  return 99;
}
