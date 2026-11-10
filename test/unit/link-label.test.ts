import { describe, expect, it } from "vitest";
import { expiryLabel, shortLink } from "../../src/shared/link-label";

describe("link label", () => {
  it("shows the host and only the start of the room key", () => {
    const label = shortLink("https://wirecall.example/r/AbCdEfGhIjKlMnOpQrStUv");
    expect(label).toBe("wirecall.example/r/AbCd…");
    expect(label).not.toContain("EfGh");
    expect(shortLink("not a url")).toBe("…");
  });

  it("counts days and hours in Russian", () => {
    const day = 86_400_000;
    expect(expiryLabel(14 * day, 0)).toBe("Действует 14 дней");
    expect(expiryLabel(day, 0)).toBe("Действует 1 день");
    expect(expiryLabel(3 * day, 0)).toBe("Действует 3 дня");
    expect(expiryLabel(21 * day, 0)).toBe("Действует 21 день");
    expect(expiryLabel(5 * 3_600_000, 0)).toBe("Действует 5 часов");
    expect(expiryLabel(60_000, 0)).toBe("Действует меньше часа");
    expect(expiryLabel(0, 10)).toBe("Срок истёк");
  });
});
