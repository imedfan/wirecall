// Takes screenshots of every screen at a desktop and a phone size, for comparing with the design by eye.
// Local use only: start the app (`npm run build && npm run dev`), then `node scripts/screenshots.mjs`.
// Pictures go to test-results/screens, which git ignores. File names carry no room address.
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const base = process.env.WIRECALL_URL ?? "http://127.0.0.1:8787";
const out = process.env.WIRECALL_SCREENS ?? "test-results/screens";
const sizes = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
};

await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const denied = await chromium.launch({ args: ["--deny-permission-prompts"] });

async function createRoom(page) {
  await page.goto(`${base}/`);
  await page.getByRole("button", { name: "Создать ссылку" }).click();
  return page.getByRole("link", { name: "Открыть звонок" }).getAttribute("href");
}

const phase = (page, name) => page.locator(`.call[data-phase="${name}"]`).waitFor({ timeout: 30_000 });

for (const [name, options] of Object.entries(sizes)) {
  const shot = (page, screen) => page.screenshot({ path: `${out}/${screen}-${name}.png` });

  // Home, the created link, the «Подробнее» sheet.
  const plain = await browser.newContext(options);
  const home = await plain.newPage();
  await home.goto(`${base}/`);
  await home.waitForTimeout(400);
  await shot(home, "home");
  await home.getByRole("button", { name: "Подробнее" }).click();
  await home.waitForTimeout(400);
  await shot(home, "home-about");
  await home.keyboard.press("Escape");
  const path = await createRoom(home);
  await shot(home, "home-created");
  await home.goto(`${base}/r/broken`);
  await shot(home, "missing");

  // Lobby before any permission: the drifting background and one button.
  await home.goto(`${base}${path}`);
  await home.waitForTimeout(400);
  await shot(home, "lobby-plain");
  await plain.close();

  // Lobby with the camera already allowed, then waiting, then a live call.
  const allowed = await browser.newContext({ ...options, permissions: ["camera", "microphone"] });
  const left = await allowed.newPage();
  const right = await allowed.newPage();
  await left.goto(`${base}${path}`);
  await left.locator('.call[data-preview="on"]').waitFor({ timeout: 15_000 });
  await left.waitForTimeout(600);
  await shot(left, "lobby-preview");
  await left.getByRole("button", { name: "Войти в звонок" }).click();
  await phase(left, "waiting");
  await left.waitForTimeout(600);
  await shot(left, "waiting");
  await right.goto(`${base}${path}`);
  await right.getByRole("button", { name: "Войти в звонок" }).click();
  await phase(left, "live");
  await left.bringToFront();
  await left.waitForTimeout(1_500);
  await left.locator(".controls").hover();
  await shot(left, "live");
  await left.getByRole("button", { name: "Настройки" }).click();
  await left.waitForTimeout(400);
  await shot(left, "live-settings");
  await left.getByRole("button", { name: "Диагностика" }).click();
  await left.waitForTimeout(400);
  await shot(left, "live-diagnostics");
  await left.keyboard.press("Escape");
  // One tap on the picture leaves only the two videos.
  const box = left.viewportSize();
  if (options.hasTouch) await left.touchscreen.tap(box.width / 2, box.height / 2);
  else await left.mouse.click(box.width / 2, box.height / 2);
  await left.locator('.call[data-ui="hidden"]').waitFor();
  await left.waitForTimeout(500);
  await shot(left, "live-immersive");
  await right.close();
  await left.getByRole("button", { name: "Завершить" }).click({ force: true });
  await phase(left, "ended");
  await left.waitForTimeout(400);
  await shot(left, "ended");
  await allowed.close();

  // Camera and microphone refused.
  const refused = await denied.newContext(options);
  const blocked = await refused.newPage();
  await blocked.goto(`${base}${path}`);
  await blocked.getByRole("button", { name: "Войти в звонок" }).click();
  await blocked.locator(".media-issue").waitFor();
  await shot(blocked, "permission");
  await refused.close();
}

await browser.close();
await denied.close();
console.log(`Screenshots are in ${out}`);
