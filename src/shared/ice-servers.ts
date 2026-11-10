export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

const ALLOWED_SCHEME = /^(stun|turn|turns):/iu;
const MAX_URLS = 16;
const MAX_URL_LENGTH = 200;
const MAX_SECRET_LENGTH = 512;

export function sanitizeIceServers(input: unknown): IceServer[] {
  if (!Array.isArray(input)) return [];
  const servers: IceServer[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const rawUrls = Array.isArray(record.urls) ? record.urls : [record.urls];
    const urls: string[] = [];
    for (const url of rawUrls) {
      if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH) continue;
      if (!ALLOWED_SCHEME.test(url)) continue;
      if (urlIncludesPort(url, 53)) continue;
      urls.push(url);
      if (urls.length >= MAX_URLS) break;
    }
    if (urls.length === 0) continue;
    const server: IceServer = { urls };
    if (typeof record.username === "string" && record.username.length <= MAX_SECRET_LENGTH) {
      server.username = record.username;
    }
    if (typeof record.credential === "string" && record.credential.length <= MAX_SECRET_LENGTH) {
      server.credential = record.credential;
    }
    servers.push(server);
    if (servers.length >= 8) break;
  }
  return servers;
}

export function stunOnlyIceServers(): IceServer[] {
  return [{ urls: ["stun:stun.cloudflare.com:3478"] }];
}

export function parseTurnCredentialResponse(body: unknown): IceServer[] | null {
  if (!body || typeof body !== "object") return null;
  const servers = sanitizeIceServers((body as { iceServers?: unknown }).iceServers);
  const hasTurn = servers.some((server) => server.urls.some((url) => url.toLowerCase().startsWith("turn")));
  if (!hasTurn) return null;
  return servers;
}

function urlIncludesPort(url: string, port: number): boolean {
  return new RegExp(`:${port}(?:\\?|$)`, "u").test(url);
}
