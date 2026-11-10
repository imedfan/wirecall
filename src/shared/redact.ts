const SENSITIVE_KEY = /sdp|payload|token|credential|authorization|resume|ice|secret|gate|password/iu;

export function redactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === "string") {
      safe[key] = value.length > 200 ? `len:${value.length}` : value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      safe[key] = value;
    }
  }
  return safe;
}
