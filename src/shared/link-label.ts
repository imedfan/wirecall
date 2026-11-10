/**
 * The room link as people see it on the home page: the host and the first characters of the room key.
 * The whole key is never printed large; the buttons carry the full address.
 */
export function shortLink(url: string): string {
  try {
    const parsed = new URL(url);
    const id = parsed.pathname.split("/")[2] ?? "";
    return `${parsed.host}/r/${id.slice(0, 4)}…`;
  } catch {
    return "…";
  }
}

/** «Действует 14 дней». Under a day it counts hours, so a link about to lapse does not claim a day. */
export function expiryLabel(expiresAt: number, nowMs: number): string {
  const left = expiresAt - nowMs;
  if (!Number.isFinite(left) || left <= 0) return "Срок истёк";
  const hours = left / 3_600_000;
  if (hours < 1) return "Действует меньше часа";
  if (hours < 24) {
    const whole = Math.floor(hours);
    return `Действует ${whole} ${plural(whole, "час", "часа", "часов")}`;
  }
  const days = Math.round(hours / 24);
  return `Действует ${days} ${plural(days, "день", "дня", "дней")}`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}
