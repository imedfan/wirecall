export function bumpRate(
  stamps: readonly number[],
  now: number,
  windowMs: number,
  max: number,
): { ok: boolean; stamps: number[] } {
  const fresh = stamps.filter((stamp) => now - stamp < windowMs);
  if (fresh.length >= max) return { ok: false, stamps: fresh };
  fresh.push(now);
  return { ok: true, stamps: fresh };
}
