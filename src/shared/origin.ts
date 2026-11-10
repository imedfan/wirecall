export function originAllowed(requestUrl: string, originHeader: string | null, allowedList: string | undefined): boolean {
  if (!originHeader) return false;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return false;
  const list = (allowedList ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (list.length === 0) {
    const request = new URL(requestUrl);
    return origin.host === request.host;
  }
  return list.some((entry) => {
    try {
      return new URL(entry).origin === origin.origin;
    } catch {
      return false;
    }
  });
}

export function authorizeCreate(provided: string | null, gate: string | undefined): boolean {
  const expected = gate?.trim() ?? "";
  if (expected.length === 0) return true;
  if (!provided) return false;
  const left = new TextEncoder().encode(provided);
  const right = new TextEncoder().encode(expected);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
