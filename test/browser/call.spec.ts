import { expect, test, chromium, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const artifacts = "/opt/cursor/artifacts";

async function launch(): Promise<Browser> {
  return chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  });
}

test("two peers connect with fake media and a third is refused", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await launch();
  const leaks: string[] = [];
  const watch = (page: Page) => {
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("v=0") || text.includes("resumeToken") || text.includes("candidate:")) leaks.push(text);
    });
  };
  const left = await browser.newPage();
  const right = await browser.newPage();
  watch(left);
  watch(right);
  await left.goto("/");
  await left.screenshot({ path: `${artifacts}/wirecall-home.png` });
  await left.getByRole("button", { name: "Создать ссылку" }).click();
  await expect(left.locator(".link-box")).toContainText("/r/");
  const href = await left.locator(".link-box").innerText();
  const path = new URL(href).pathname;
  await left.goto(path);
  await right.goto(path);
  await left.screenshot({ path: `${artifacts}/wirecall-lobby.png` });
  await left.getByRole("button", { name: "Войти в звонок" }).click();
  await right.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(left.locator(".status")).toHaveText("На связи", { timeout: 20_000 });
  await expect(right.locator(".status")).toHaveText("На связи", { timeout: 20_000 });
  await expect.poll(async () => left.locator("video.remote").evaluate((node) => (node as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  await left.screenshot({ path: `${artifacts}/wirecall-call.png` });
  const third = await browser.newPage();
  await third.goto(path);
  await third.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(third.locator(".status")).toContainText("уже двое");
  await right.close();
  await expect(left.locator(".status")).toContainText("вышел");
  expect(leaks).toEqual([]);
  await browser.close();
});

test("permission failure shows recovery guidance", async () => {
  const browser = await chromium.launch({ args: ["--deny-permission-prompts"] });
  const page = await browser.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Создать ссылку" }).click();
  const href = await page.locator(".link-box").innerText();
  await page.goto(new URL(href).pathname);
  await page.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(page.locator(".media-issue")).toContainText("не показало камеру или микрофон");
  await page.screenshot({ path: `${artifacts}/wirecall-permission.png` });
  await browser.close();
});

test("signaling socket rejects an unknown room and a cross-site origin", async ({ request }) => {
  const missing = await request.get("/api/rooms/aaaaaaaaaaaaaaaaaaaaaa/socket", { headers: { upgrade: "websocket", origin: "http://127.0.0.1:8787" } });
  expect(missing.status()).toBe(404);
  const created = await request.post("/api/rooms", { headers: { origin: "http://127.0.0.1:8787" } });
  expect(created.status()).toBe(201);
  const foreign = await request.post("/api/rooms", { headers: { origin: "https://evil.example" } });
  expect(foreign.status()).toBe(403);
});
