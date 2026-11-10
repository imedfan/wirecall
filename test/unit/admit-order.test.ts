import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("room admission critical section", () => {
  it("finishes resume hashing before reading the room and does not await before the write", () => {
    const source = readFileSync(new URL("../../src/worker/room-do.ts", import.meta.url), "utf8");
    const admit = source.slice(source.indexOf("private async admit"), source.indexOf("private send("));
    const readAt = admit.indexOf("this.readRoom()");
    const lastHash = admit.lastIndexOf("await sha256Hex");
    const writeAt = admit.indexOf("this.writeRoom(");
    expect(lastHash).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(lastHash);
    expect(writeAt).toBeGreaterThan(readAt);
    expect(admit.slice(readAt, writeAt)).not.toContain("await ");
  });
});
