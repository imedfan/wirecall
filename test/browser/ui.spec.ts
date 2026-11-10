import { expect, test, chromium, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

const phone: BrowserContextOptions = { viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true };

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

async function createRoom(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Создать ссылку" }).click();
  const path = await page.getByRole("link", { name: "Открыть звонок" }).getAttribute("href");
  expect(path).toMatch(/^\/r\//u);
  return path!;
}

async function join(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Войти/u }).click();
}

/** A live call between two pages. The left one gets the options under test, the right one is a plain peer. */
async function openLive(browser: Browser, options: BrowserContextOptions = {}, prepare?: (page: Page) => Promise<void>): Promise<{ left: Page; right: Page; path: string }> {
  const left = await (await browser.newContext(options)).newPage();
  const right = await (await browser.newContext()).newPage();
  if (prepare) await prepare(left);
  const path = await createRoom(right);
  await left.goto(path);
  await right.goto(path);
  await join(left);
  await expect(left.locator(".call")).toHaveAttribute("data-phase", "waiting");
  await join(right);
  await expect(left.locator(".call")).toHaveAttribute("data-phase", "live", { timeout: 25_000 });
  await expect(right.locator(".call")).toHaveAttribute("data-phase", "live", { timeout: 25_000 });
  return { left, right, path };
}

const ui = (page: Page) => page.locator(".call");

/** A point on the other person's picture, clear of the badge, the «me» window and the panel. */
function pictureOf(page: Page): { x: number; y: number } {
  const size = page.viewportSize()!;
  return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
}

async function boxOf(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** The window has finished sliding when several readings in a row, a moment apart, agree. */
async function settledBox(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = await boxOf(page, selector);
  let calm = 0;
  for (let attempt = 0; attempt < 40 && calm < 3; attempt += 1) {
    await page.waitForTimeout(120);
    const next = await boxOf(page, selector);
    calm = Math.abs(next.x - last.x) < 0.5 && Math.abs(next.y - last.y) < 0.5 ? calm + 1 : 0;
    last = next;
  }
  expect(calm).toBe(3);
  return last;
}

test("the lobby shows the camera when it is already allowed, with one main button and a microphone level", async () => {
  const browser = await launch();
  const context = await browser.newContext({ ...phone, permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  await page.goto(await createRoom(page));
  await expect(ui(page)).toHaveAttribute("data-preview", "on", { timeout: 15_000 });
  await expect(page.locator(".status")).toHaveText("Всё готово");
  await expect(page.locator(".call .btn-primary:visible")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Войти в звонок" })).toBeVisible();
  // The own picture fills the screen behind the button.
  const view = page.viewportSize()!;
  const self = await boxOf(page, ".self");
  expect(self.width).toBe(view.width);
  expect(self.height).toBe(view.height);
  await expect.poll(async () => page.locator("video.local").evaluate((node) => (node as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  // The fake microphone beeps. The bar moves, so a person can see they are heard.
  await expect(page.getByRole("img", { name: "Уровень микрофона" })).toBeVisible();
  await expect.poll(async () => page.locator(".meter i").evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a), { timeout: 10_000 }).toBeGreaterThan(0.02);
  // The round switches act on the same microphone and camera the call will use.
  await page.getByRole("button", { name: "Микрофон", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Микрофон выключен", exact: true })).toHaveAttribute("aria-pressed", "true");
  const before = await page.evaluate(() => {
    const stream = (document.querySelector("video.local") as HTMLVideoElement).srcObject as MediaStream;
    return { id: stream.id, mic: stream.getAudioTracks()[0]?.enabled };
  });
  expect(before.mic).toBe(false);
  // Joining keeps the stream of the preview: the camera is not opened a second time.
  await join(page);
  await expect(ui(page)).toHaveAttribute("data-phase", "waiting");
  await expect(page.locator(".status")).toHaveText("Ждём второго человека");
  const after = await page.evaluate(() => ((document.querySelector("video.local") as HTMLVideoElement).srcObject as MediaStream).id);
  expect(after).toBe(before.id);
  // While waiting there are two things to do: send the link or leave.
  await expect(page.getByRole("button", { name: /ссылку/u })).toBeVisible();
  await expect(page.locator(".controls .ctl:visible")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
  await browser.close();
});

test("a tap on the picture hides the controls and brings them back, and they hide by themselves after four seconds", async () => {
  const browser = await launch();
  const { left } = await openLive(browser, phone);
  const at = pictureOf(left);
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  await expect(left.locator(".controls")).toHaveCSS("opacity", "1");

  await left.touchscreen.tap(at.x, at.y);
  await expect(ui(left)).toHaveAttribute("data-ui", "hidden");
  // Only the two pictures stay: the panel and the badge fade out and stop taking touches.
  await expect(left.locator(".controls")).toHaveCSS("opacity", "0");
  await expect(left.locator(".quality")).toHaveCSS("opacity", "0");
  await expect(left.locator(".controls")).toHaveCSS("pointer-events", "none");
  await expect(left.locator("video.remote")).toBeVisible();
  await expect(left.locator(".self")).toBeVisible();

  const shownAt = Date.now();
  await left.touchscreen.tap(at.x, at.y);
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  await expect(left.locator(".controls")).toHaveCSS("opacity", "1");
  // Left alone, the controls go away after four seconds, not sooner.
  await left.waitForTimeout(3_000);
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  await expect(ui(left)).toHaveAttribute("data-ui", "hidden", { timeout: 3_000 });
  expect(Date.now() - shownAt).toBeGreaterThanOrEqual(3_900);

  // Any touch returns them, and a button works straight away.
  await left.touchscreen.tap(at.x, at.y);
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  await left.getByRole("button", { name: "Микрофон", exact: true }).tap();
  await expect(left.getByRole("button", { name: "Микрофон выключен", exact: true })).toHaveAttribute("aria-pressed", "true");

  // An open sheet keeps the controls on screen for as long as it is open.
  await left.getByRole("button", { name: "Настройки" }).tap();
  await expect(left.getByRole("dialog")).toBeVisible();
  await left.waitForTimeout(5_500);
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  // «Показывать целиком» lives here now. A tap on the picture no longer changes the fit.
  const whole = left.getByRole("switch", { name: "Показывать целиком" });
  await expect(whole).toHaveAttribute("aria-checked", "false");
  await expect(left.locator("video.remote")).not.toHaveClass(/contain/u);
  await whole.tap();
  await expect(whole).toHaveAttribute("aria-checked", "true");
  await expect(left.locator("video.remote")).toHaveClass(/contain/u);
  // The diagnostics sit behind the settings: a short list on top, the rest folded under «Ещё».
  await left.getByRole("button", { name: "Диагностика" }).tap();
  const sheet = left.getByRole("dialog");
  await expect(sheet.getByRole("heading")).toHaveText("Диагностика");
  await expect(sheet.locator(".diag").first().locator("span")).toHaveText(["Качество", "Задержка", "Потери", "Кадры", "Размер"]);
  await expect(sheet.locator(".diag-more")).not.toHaveAttribute("open", "");
  const text = await sheet.evaluate((node) => node.textContent ?? "");
  expect(text).not.toMatch(/v=0|candidate:|a=fingerprint|ice-ufrag/u);
  expect(text).not.toContain(new URL(left.url()).pathname.split("/")[2]!);
  await sheet.getByRole("button", { name: "Закрыть" }).tap();
  // With the sheet closed the four seconds start again.
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  await expect(ui(left)).toHaveAttribute("data-ui", "hidden", { timeout: 6_000 });
  await browser.close();
});

test("on a desktop the cursor shows the controls and three idle seconds hide them", async () => {
  const browser = await launch();
  const { left } = await openLive(browser);
  const at = pictureOf(left);
  await left.mouse.move(at.x, at.y);
  await left.mouse.move(at.x + 40, at.y + 10);
  const movedAt = Date.now();
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  await expect(ui(left)).toHaveAttribute("data-ui", "hidden", { timeout: 5_000 });
  const idle = Date.now() - movedAt;
  expect(idle).toBeGreaterThanOrEqual(2_900);
  expect(idle).toBeLessThan(4_000);
  await left.mouse.move(at.x, at.y);
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  // A click on the picture hides them at once.
  await left.mouse.click(at.x, at.y);
  await expect(ui(left)).toHaveAttribute("data-ui", "hidden");
  await browser.close();
});

test("the controls are reachable from the keyboard and stay while a button has focus", async () => {
  const browser = await launch();
  const { left } = await openLive(browser);
  await expect(ui(left)).toHaveAttribute("data-ui", "hidden", { timeout: 7_000 });
  const focused = () => left.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  // Focus alone shows the panel, and the buttons come in their visual order.
  await left.keyboard.press("Tab");
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  expect(await focused()).toBe("Микрофон");
  await left.waitForTimeout(5_500);
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  await left.keyboard.press("Enter");
  await expect(left.getByRole("button", { name: "Микрофон выключен", exact: true })).toHaveAttribute("aria-pressed", "true");
  await left.keyboard.press("Tab");
  expect(await focused()).toBe("Камера");
  await left.keyboard.press("Tab");
  expect(await focused()).toBe("Настройки");
  await left.keyboard.press("Tab");
  expect(await focused()).toBe("Завершить");
  // Every button of the panel has a name.
  const names = await left.locator(".controls button:visible").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  expect(names).toEqual(["Микрофон выключен", "Камера", "Настройки", "Завершить"]);
  await expect(left.getByRole("toolbar", { name: "Управление звонком" })).toBeVisible();
  // M and V still work from the keyboard.
  await left.keyboard.press("m");
  await expect(left.getByRole("button", { name: "Микрофон", exact: true })).toHaveAttribute("aria-pressed", "false");
  await left.keyboard.press("v");
  await expect(left.getByRole("button", { name: "Камера выключена", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Once focus leaves the panel the controls may hide again.
  await left.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(ui(left)).toHaveAttribute("data-ui", "hidden", { timeout: 7_000 });
  await browser.close();
});

test("a weak link lowers the frame rate, keeps the frame size and keeps the controls on screen", async () => {
  test.setTimeout(120_000);
  const browser = await launch();
  const { left } = await openLive(browser, {}, async (page) => {
    await page.addInitScript(() => {
      // Reports a two-second round trip once the test asks for it. Everything else in getStats stays real.
      const real = RTCPeerConnection.prototype.getStats;
      RTCPeerConnection.prototype.getStats = async function (this: RTCPeerConnection, ...args: []) {
        const report = await real.apply(this, args);
        if (!(window as unknown as { __slow?: boolean }).__slow) return report;
        const out = new Map<string, unknown>();
        report.forEach((value: Record<string, unknown>, key: string) => {
          out.set(key, value.type === "candidate-pair" ? { ...value, currentRoundTripTime: 2 } : value);
        });
        return out as unknown as RTCStatsReport;
      } as typeof real;
      const Original = RTCPeerConnection;
      const pcs: RTCPeerConnection[] = [];
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
      const Wrapped = function (config?: RTCConfiguration) {
        const pc = new Original(config);
        pcs.push(pc);
        return pc;
      } as unknown as typeof RTCPeerConnection;
      Wrapped.prototype = Original.prototype;
      Object.setPrototypeOf(Wrapped, Original);
      window.RTCPeerConnection = Wrapped;
    });
  });
  const encoding = () => left.evaluate(() => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const sender = pcs[pcs.length - 1]!.getSenders().find((item) => item.track?.kind === "video")!;
    const params = sender.getParameters();
    const { maxFramerate, maxBitrate, scaleResolutionDownBy } = params.encodings[0]!;
    return { maxFramerate, maxBitrate, scaleResolutionDownBy, preference: params.degradationPreference, hint: sender.track?.contentHint };
  });
  await expect.poll(encoding).toEqual({ maxFramerate: 30, maxBitrate: 1_200_000, scaleResolutionDownBy: 1, preference: "maintain-resolution", hint: "detail" });

  await left.evaluate(() => {
    (window as unknown as { __slow?: boolean }).__slow = true;
  });
  const badge = left.locator(".quality");
  // One step down: fewer frames, the same frame size.
  await expect(badge).toHaveAttribute("data-tier", "ok", { timeout: 30_000 });
  await expect(badge.locator(".quality-text")).toHaveText("Связь нормальная · кадры реже");
  await expect.poll(encoding).toMatchObject({ maxFramerate: 20, maxBitrate: 800_000, scaleResolutionDownBy: 1 });
  await expect(badge).toHaveAttribute("data-tier", "weak", { timeout: 30_000 });
  await expect(badge.locator(".quality-text")).toHaveText("Связь слабая · кадры реже");
  await expect(badge).toHaveAttribute("data-bars", "2");
  await expect.poll(encoding).toMatchObject({ maxFramerate: 15, maxBitrate: 500_000, scaleResolutionDownBy: 1 });
  expect(await left.locator(".call").innerText()).not.toContain("качество видео снижено");
  // The diagnostics show what the encoder really sends next to the ceiling, not just that a call succeeded.
  await left.evaluate(() => (document.querySelector(".quality") as HTMLElement).click());
  await expect(left.getByRole("dialog").locator(".diag").first()).toContainText(/Кадры\d+ из 15/u, { timeout: 15_000 });
  await expect(left.getByRole("dialog").locator(".diag").first()).toContainText(/Размер\d+×\d+/u);
  await left.keyboard.press("Escape");

  // On a weak link the controls do not hide by themselves: the warning stays in view.
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  await left.waitForTimeout(5_500);
  await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  await expect(badge).toBeVisible();
  // A tap may still hide them, and then the bars alone stay, faint.
  const at = pictureOf(left);
  await left.mouse.click(at.x, at.y);
  await expect(ui(left)).toHaveAttribute("data-ui", "hidden");
  await expect(left.locator(".controls")).toHaveCSS("opacity", "0");
  await expect(badge).toHaveCSS("opacity", "0.6");
  await browser.close();
});

test("the own picture can be dragged, snaps to a corner clear of the panel, and remembers the corner", async () => {
  const browser = await launch();
  // A phone-sized window driven by a mouse: the panel spans the width, so the bottom corners have to make room.
  const { left, path } = await openLive(browser, { viewport: { width: 393, height: 852 } });
  const view = left.viewportSize()!;
  // Keeps the controls on screen while the window is measured against them.
  const awake = async (): Promise<void> => {
    await left.keyboard.press("Shift");
    await expect(ui(left)).toHaveAttribute("data-ui", "shown");
  };
  await awake();
  const start = await settledBox(left, ".self");
  // Top right by default on a phone.
  expect(start.x + start.width).toBeGreaterThan(view.width - 30);
  expect(start.y).toBeLessThan(view.height / 3);
  expect(start.width).toBeLessThan(view.width / 2);

  const drag = async (from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number }): Promise<void> => {
    await left.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await left.mouse.down();
    await left.mouse.move(to.x, to.y, { steps: 12 });
  };
  // While held, the window follows the pointer and cannot leave the screen.
  await drag(start, { x: view.width + 200, y: view.height + 200 });
  const held = await boxOf(left, ".self");
  expect(held.x + held.width).toBeLessThanOrEqual(view.width);
  expect(held.y + held.height).toBeLessThanOrEqual(view.height);
  expect(held.y).toBeGreaterThan(view.height / 2);
  await left.mouse.up();

  await awake();
  const panel = await boxOf(left, ".controls");
  const docked = await settledBox(left, ".self");
  // Bottom right, above the buttons with a gap, inside the screen.
  expect(docked.x + docked.width).toBeGreaterThan(view.width - 30);
  expect(docked.x + docked.width).toBeLessThanOrEqual(view.width - 12);
  expect(docked.y + docked.height).toBeLessThanOrEqual(panel.y - 11);
  expect(docked.y).toBeGreaterThan(view.height / 2);
  expect(await left.evaluate(() => localStorage.getItem("wirecall-self-corner"))).toBe("bottom-right");
  // Nothing but the corner name is stored: no room, no person.
  expect(await left.evaluate(() => Object.keys(localStorage))).toEqual(["wirecall-self-corner"]);

  // With the controls hidden the window moves closer to the edge, and comes back when they return.
  const at = pictureOf(left);
  await left.mouse.click(at.x, at.y);
  await expect(ui(left)).toHaveAttribute("data-ui", "hidden");
  const lowered = await settledBox(left, ".self");
  expect(lowered.y).toBeGreaterThan(docked.y + 40);
  expect(lowered.y + lowered.height).toBeLessThanOrEqual(view.height - 12);
  await awake();
  const raised = await settledBox(left, ".self");
  expect(Math.abs(raised.y - docked.y)).toBeLessThan(2);

  // A short drag towards the left edge lands in the bottom left corner.
  await drag(raised, { x: 60, y: raised.y + raised.height / 2 });
  await left.mouse.up();
  await awake();
  const moved = await settledBox(left, ".self");
  expect(moved.x).toBeLessThan(30);
  expect(moved.x).toBeGreaterThanOrEqual(12);
  expect(moved.y + moved.height).toBeLessThanOrEqual(panel.y - 11);
  expect(await left.evaluate(() => localStorage.getItem("wirecall-self-corner"))).toBe("bottom-left");
  // The front camera stays mirrored inside the window that was moved.
  expect(await left.locator("video.local").evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a)).toBe(-1);

  // After a reload the window starts where it was left.
  await left.reload();
  await left.goto(path);
  await join(left);
  await expect(ui(left)).toHaveAttribute("data-phase", "live", { timeout: 25_000 });
  await awake();
  const again = await settledBox(left, ".self");
  expect(again.x).toBeLessThan(30);
  expect(again.y).toBeGreaterThan(view.height / 2);

  // Turning the screen sideways keeps the window inside it and above the panel.
  await left.setViewportSize({ width: 852, height: 393 });
  await awake();
  const sideways = await settledBox(left, ".self");
  const sidePanel = await boxOf(left, ".controls");
  expect(sideways.x).toBeGreaterThanOrEqual(12);
  expect(sideways.y).toBeGreaterThanOrEqual(12);
  expect(sideways.y + sideways.height).toBeLessThanOrEqual(393 - 12);
  const overlaps = sideways.x < sidePanel.x + sidePanel.width && sideways.x + sideways.width > sidePanel.x && sideways.y < sidePanel.y + sidePanel.height && sideways.y + sideways.height > sidePanel.y;
  expect(overlaps).toBe(false);
  await browser.close();
});

test("the screens after a call are one heading, one phrase and one button", async () => {
  const browser = await launch();
  const { left, right, path } = await openLive(browser);
  const third = await (await browser.newContext()).newPage();
  await third.goto(path);
  await join(third);
  await expect(third.locator(".status")).toHaveText("В комнате уже двое");
  await expect(third.locator(".status-note")).toHaveText("Создайте новую ссылку.");
  await expect(third.locator(".call .btn-primary:visible")).toHaveCount(1);
  await expect(third.locator(".call .aurora")).toBeVisible();

  await left.keyboard.press("Shift");
  await left.getByRole("button", { name: "Завершить" }).click();
  await expect(left.locator(".status")).toHaveText("Звонок завершён");
  await expect(left.locator(".call .btn-primary:visible")).toHaveCount(1);
  await expect(left.getByRole("button", { name: "Войти снова" })).toBeVisible();
  await expect(left.locator(".controls")).toBeHidden();
  await expect(left.locator(".call .aurora")).toBeVisible();
  // The one who stays sees a short line, not a paragraph.
  await expect(right.locator(".status")).toHaveText("Собеседник вышел. Ждём возвращения.");

  const lost = await (await browser.newContext()).newPage();
  await lost.goto("/r/not-a-room");
  await expect(lost.getByRole("heading", { level: 1 })).toHaveText("Комната не найдена");
  await expect(lost.locator(".screen .btn-primary")).toHaveCount(1);
  await expect(lost.locator(".screen .aurora")).toBeVisible();
  await browser.close();
});
