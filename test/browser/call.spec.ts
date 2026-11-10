import { expect, test, chromium, type Browser, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const artifacts = process.env.WIRECALL_ARTIFACTS ?? "test-results/artifacts";

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
  await left.getByRole("button", { name: "Микрофон", exact: true }).click();
  await expect(left.getByRole("button", { name: "Микрофон выключен", exact: true })).toHaveAttribute("aria-pressed", "true");
  await left.getByRole("button", { name: "Камера", exact: true }).click();
  await expect(left.getByRole("button", { name: "Камера выключена", exact: true })).toHaveAttribute("aria-pressed", "true");
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

test("the same participant reconnects without a new seat", async () => {
  const browser = await launch();
  const left = await browser.newPage();
  const right = await browser.newPage();
  await armSockets(left);
  await armSockets(right);
  await left.goto("/");
  await left.getByRole("button", { name: "Создать ссылку" }).click();
  await expect(left.locator(".link-box")).toContainText("/r/");
  const href = await left.locator(".link-box").innerText();
  const path = new URL(href).pathname;
  await left.goto(path);
  await right.goto(path);
  await left.evaluate(() => {
    (window as unknown as { __stay?: number }).__stay = 1;
  });
  await right.evaluate(() => {
    (window as unknown as { __stay?: number }).__stay = 1;
  });
  await left.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(left.locator(".status")).toContainText("Ждём");
  await right.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(left.locator(".status")).toHaveText("На связи", { timeout: 20_000 });
  await expect(right.locator(".status")).toHaveText("На связи", { timeout: 20_000 });
  await left.getByRole("button", { name: "Микрофон", exact: true }).click();
  const rounds: { dropped: string; ms: number; trace: { t: number; left: string; right: string; leftWidth: number; rightWidth: number }[] }[] = [];
  for (const dropped of ["polite", "impolite", "polite"] as const) {
    const page = dropped === "polite" ? right : left;
    const started = Date.now();
    await dropSocket(page);
    const trace = await expectBothRestored(left, right);
    rounds.push({ dropped, ms: Date.now() - started, trace });
    await expect(left.getByRole("button", { name: "Микрофон выключен", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await left.evaluate(() => (window as unknown as { __stay?: number }).__stay)).toBe(1);
    expect(await right.evaluate(() => (window as unknown as { __stay?: number }).__stay)).toBe(1);
  }
  const third = await browser.newPage();
  await third.goto(path);
  await third.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(third.locator(".status")).toContainText("уже двое");
  await mkdir(artifacts, { recursive: true });
  await writeFile(`${artifacts}/reconnect-rounds.json`, JSON.stringify(rounds));
  await browser.close();
});

test("hanging up and joining again reconnects from either role, and so does a reload", async () => {
  const browser = await launch();
  const left = await browser.newPage();
  const right = await browser.newPage();
  await left.goto("/");
  await left.getByRole("button", { name: "Создать ссылку" }).click();
  const href = await left.locator(".link-box").innerText();
  const path = new URL(href).pathname;
  await left.goto(path);
  await right.goto(path);
  await left.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(left.locator(".status")).toContainText("Ждём");
  await right.getByRole("button", { name: "Войти в звонок" }).click();
  const live = async () => {
    await expect(left.locator(".status")).toHaveText("На связи", { timeout: 25_000 });
    await expect(right.locator(".status")).toHaveText("На связи", { timeout: 25_000 });
    for (const page of [left, right]) {
      await expect.poll(async () => page.locator("video.remote").evaluate((node) => (node as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    }
  };
  await live();
  // The first to join is the only one allowed to offer. When that person leaves and returns, someone must still offer.
  for (const [page, other] of [[left, right], [right, left]] as const) {
    await page.getByRole("button", { name: "Завершить" }).click();
    await expect(page.locator(".status")).toHaveText("Звонок завершён");
    await expect(other.locator(".status")).toContainText("вышел");
    await page.getByRole("button", { name: "Войти снова" }).click();
    await live();
  }
  await left.reload();
  await expect(right.locator(".status")).toContainText("вышел");
  await left.getByRole("button", { name: "Войти в звонок" }).click();
  await live();
  await browser.close();
});

async function armSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    const Original = WebSocket;
    const Wrapped = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socket = new Original(url, protocols);
      sockets.push(socket);
      return socket;
    } as unknown as typeof WebSocket;
    Wrapped.prototype = Original.prototype;
    Object.setPrototypeOf(Wrapped, Original);
    window.WebSocket = Wrapped;
    (window as unknown as { __wcSockets?: WebSocket[] }).__wcSockets = sockets;
  });
}

async function dropSocket(page: Page): Promise<void> {
  const closed = await page.evaluate(() => {
    const sockets = (window as unknown as { __wcSockets?: WebSocket[] }).__wcSockets ?? [];
    const open = sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
    const socket = open[open.length - 1];
    if (!socket) return false;
    socket.close(4001, "drop");
    return true;
  });
  expect(closed).toBe(true);
}

function sawBreak(status: string): boolean {
  return status.includes("вышел") || status.includes("Соединяем") || status.includes("прервалась");
}

async function expectBothRestored(left: Page, right: Page): Promise<{ t: number; left: string; right: string; leftWidth: number; rightWidth: number }[]> {
  const started = Date.now();
  let leftBreak = false;
  let rightBreak = false;
  let leftStatus = "";
  let rightStatus = "";
  let leftWidth = 0;
  let rightWidth = 0;
  let previous = "";
  const trace: { t: number; left: string; right: string; leftWidth: number; rightWidth: number }[] = [];
  while (Date.now() - started < 20_000) {
    leftStatus = await left.locator(".status").innerText();
    rightStatus = await right.locator(".status").innerText();
    leftWidth = await left.locator("video.remote").evaluate((node) => (node as HTMLVideoElement).videoWidth);
    rightWidth = await right.locator("video.remote").evaluate((node) => (node as HTMLVideoElement).videoWidth);
    const key = `${leftStatus}|${rightStatus}|${leftWidth}|${rightWidth}`;
    if (key !== previous) {
      previous = key;
      trace.push({ t: Date.now() - started, left: leftStatus, right: rightStatus, leftWidth, rightWidth });
    }
    if (sawBreak(leftStatus)) leftBreak = true;
    if (sawBreak(rightStatus)) rightBreak = true;
    if (leftBreak && rightBreak && leftStatus === "На связи" && rightStatus === "На связи" && leftWidth > 0 && rightWidth > 0) return trace;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = async (page: Page) => page.evaluate(() => {
    const video = document.querySelector("video.remote") as HTMLVideoElement | null;
    const stream = video?.srcObject instanceof MediaStream ? video.srcObject : null;
    return {
      paused: video?.paused ?? null,
      tracks: stream?.getTracks().map((track) => ({ kind: track.kind, state: track.readyState, muted: track.muted })) ?? [],
    };
  });
  const leftDetail = await detail(left);
  const rightDetail = await detail(right);
  throw new Error(`reconnect did not restore media (left ${leftStatus}/${leftWidth}/${leftBreak} ${JSON.stringify(leftDetail)}, right ${rightStatus}/${rightWidth}/${rightBreak} ${JSON.stringify(rightDetail)})`);
}

test("permission failure shows recovery guidance", async () => {
  const browser = await chromium.launch({ args: ["--deny-permission-prompts"] });
  const page = await browser.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Создать ссылку" }).click();
  const href = await page.locator(".link-box").innerText();
  await page.goto(new URL(href).pathname);
  await page.getByRole("button", { name: "Войти в звонок" }).click();
  // Headless Chromium reports no devices on Linux and "not supported" on macOS. Both must end in visible guidance.
  await expect(page.locator(".media-issue")).toContainText(/камер/u);
  await expect(page.getByRole("button", { name: "Войти в звонок" })).toBeVisible();
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
