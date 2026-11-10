import { parseTurnCredentialResponse, sanitizeIceServers, stunOnlyIceServers, type IceServer } from "../shared/ice-servers";

const KEY_ID_RE = /^[A-Za-z0-9]{8,128}$/;

export function turnRequested(env: Env): boolean {
  return String(env.TURN_ENABLED) === "true";
}

export function turnConfigured(env: Env): boolean {
  return turnRequested(env) && Boolean(env.TURN_KEY_ID) && Boolean(env.TURN_API_TOKEN);
}

export async function fetchTurnIceServers(env: Env): Promise<{ mode: "on" | "error" | "off"; iceServers: IceServer[] }> {
  if (!turnRequested(env)) return { mode: "off", iceServers: stunOnlyIceServers() };
  if (!turnConfigured(env) || !env.TURN_KEY_ID || !env.TURN_API_TOKEN || !KEY_ID_RE.test(env.TURN_KEY_ID)) {
    return { mode: "error", iceServers: stunOnlyIceServers() };
  }
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.TURN_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: 3600 }),
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return { mode: "error", iceServers: stunOnlyIceServers() };
    const parsed = parseTurnCredentialResponse(await response.json());
    if (!parsed) return { mode: "error", iceServers: stunOnlyIceServers() };
    return { mode: "on", iceServers: sanitizeIceServers(parsed) };
  } catch {
    return { mode: "error", iceServers: stunOnlyIceServers() };
  }
}
