import { describe, expect, it } from "vitest";
import { sanitizeIceServers } from "../../src/shared/ice-servers";
import { TURN_CREDENTIAL_TTL_SECONDS, turnCredentialTarget } from "../../src/shared/turn-target";

describe("TURN credential request bounds", () => {
  it("builds one fixed Cloudflare URL and rejects a key that could change the path", () => {
    expect(TURN_CREDENTIAL_TTL_SECONDS).toBe(86_400);
    expect(turnCredentialTarget("abcd1234")).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/abcd1234/credentials/generate-ice-servers",
    );
    expect(turnCredentialTarget("abcd1234/../../v1")).toBeNull();
    expect(turnCredentialTarget("short")).toBeNull();
    expect(turnCredentialTarget("abcd 1234")).toBeNull();
  });

  it("drops non-stun urls and port 53 from a credential payload", () => {
    const ice = sanitizeIceServers([
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "turn:turn.example:53", username: "user", credential: "secret" },
      { urls: "javascript:alert(1)", username: "user", credential: "secret" },
      { urls: "turns:turn.example:443", username: "user", credential: "secret" },
    ]);
    const urls = ice.map((server) => (Array.isArray(server.urls) ? server.urls[0] : server.urls));
    expect(urls).toEqual(["stun:stun.cloudflare.com:3478", "turns:turn.example:443"]);
  });
});
