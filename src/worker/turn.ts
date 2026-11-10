import { parseTurnCredentialResponse, sanitizeIceServers, stunOnlyIceServers, type IceServer } from "../shared/ice-servers";
import { TURN_CREDENTIAL_TTL_SECONDS, turnCredentialTarget } from "../shared/turn-target";

export function turnRequested(env: Env): boolean {
  return String(env.TURN_ENABLED) === "true";
}

export function turnConfigured(env: Env): boolean {
  return turnRequested(env) && Boolean(env.TURN_KEY_ID) && Boolean(env.TURN_API_TOKEN);
}

export async function fetchTurnIceServers(env: Env): Promise<{ mode: "on" | "error" | "off"; iceServers: IceServer[] }> {
  if (!turnRequested(env)) return { mode: "off", iceServers: stunOnlyIceServers() };
  const target = env.TURN_KEY_ID ? turnCredentialTarget(env.TURN_KEY_ID) : null;
  if (!turnConfigured(env) || !env.TURN_API_TOKEN || !target) {
    return { mode: "error", iceServers: stunOnlyIceServers() };
  }
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TURN_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { mode: "error", iceServers: stunOnlyIceServers() };
    const parsed = parseTurnCredentialResponse(await response.json());
    if (!parsed) return { mode: "error", iceServers: stunOnlyIceServers() };
    return { mode: "on", iceServers: sanitizeIceServers(parsed) };
  } catch {
    return { mode: "error", iceServers: stunOnlyIceServers() };
  }
}
