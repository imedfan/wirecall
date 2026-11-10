export const TURN_CREDENTIAL_TTL_SECONDS = 3600;

const KEY_ID_RE = /^[A-Za-z0-9]{8,128}$/;

export function turnCredentialTarget(keyId: string): string | null {
  if (!KEY_ID_RE.test(keyId)) return null;
  return `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;
}
