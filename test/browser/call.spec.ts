import { expect, test, chromium, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

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
  await left.addInitScript(() => {
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
  // The quality badge is on screen during the call: words and bars, announced politely to a screen reader.
  for (const page of [left, right]) {
    const badge = page.locator(".quality");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("aria-live", "polite");
    await expect(badge.locator(".quality-text")).toHaveText("Связь хорошая");
    await expect(badge).toHaveAttribute("data-bars", "4");
    await expect(badge.locator(".quality-bars i")).toHaveCount(4);
    // The other person's tier arrives over the data channel, not from a guess.
    await expect(badge.locator(".quality-peer")).toHaveText("У собеседника связь хорошая", { timeout: 20_000 });
  }
  // Voice is capped and prioritised, video is limited but on.
  const senders = await left.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const pc = pcs[pcs.length - 1]!;
    const pick = (kind: string) => pc.getSenders().find((sender) => sender.track?.kind === kind);
    return {
      audioMax: pick("audio")?.getParameters().encodings[0]?.maxBitrate,
      videoActive: pick("video")?.getParameters().encodings[0]?.active,
      videoMax: pick("video")?.getParameters().encodings[0]?.maxBitrate,
      audioHint: pick("audio")?.track?.contentHint,
      videoHint: pick("video")?.track?.contentHint,
    };
  });
  expect(senders).toEqual({ audioMax: 40_000, videoActive: true, videoMax: 1_200_000, audioHint: "speech", videoHint: "motion" });
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
  // A tab that vanishes without a goodbye looks like a lost network at first. The seat is freed by the stale sweep.
  await expect(left.locator(".status")).toContainText(/вышел|пропала связь/u, { timeout: 30_000 });
  expect(leaks).toEqual([]);
  await browser.close();
});

test("a signaling drop alone keeps the same connection, tracks and picture", async () => {
  const browser = await launch();
  const { left, right, path } = await openCall(browser);
  await left.getByRole("button", { name: "Микрофон", exact: true }).click();
  for (const dropped of [right, left, right]) {
    const before = { left: await snapshot(left), right: await snapshot(right) };
    await markStatuses(left);
    await markStatuses(right);
    await dropSocket(dropped);
    // The dropped side joins again and is welcomed on a new socket.
    await expect.poll(async () => (await snapshot(dropped)).welcomes).toBe((dropped === left ? before.left : before.right).welcomes + 1);
    await framesAdvance(left);
    await framesAdvance(right);
    const after = { left: await snapshot(left), right: await snapshot(right) };
    for (const side of ["left", "right"] as const) {
      expect(after[side].pcs).toBe(before[side].pcs);
      expect(after[side].connection).toBe("connected");
      expect(after[side].remoteTracks).toEqual(before[side].remoteTracks);
      expect(after[side].offers).toBe(before[side].offers);
      expect(after[side].media).toBe(before[side].media);
    }
    // Neither person saw the call break.
    expect(await statusesSinceMark(left)).toEqual([]);
    expect(await statusesSinceMark(right)).toEqual([]);
    await expect(left.getByRole("button", { name: "Микрофон выключен", exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  const third = await browser.newPage();
  await third.goto(path);
  await third.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(third.locator(".status")).toContainText("уже двое");
  await browser.close();
});

test("a media failure seen by one side is repaired by an ICE restart, whichever role that side has", async () => {
  const browser = await launch();
  const { left, right } = await openCall(browser);
  // left joined first and is the only one that offers. right has to ask it.
  for (const broken of [right, left]) {
    const before = { left: await snapshot(left), right: await snapshot(right) };
    const started = Date.now();
    await forceIce(broken, "failed");
    await expect.poll(async () => (await snapshot(left)).offers, { timeout: 5_000 }).toBe(before.left.offers + 1);
    await expect(broken.locator(".status")).toHaveText("На связи", { timeout: 10_000 });
    // Far below the 40 seconds the non-offering side used to wait passively.
    expect(Date.now() - started).toBeLessThan(10_000);
    const after = { left: await snapshot(left), right: await snapshot(right) };
    expect(after.left.pcs).toBe(before.left.pcs);
    expect(after.right.pcs).toBe(before.right.pcs);
    expect(after.left.rebuilds).toBe(before.left.rebuilds);
    if (broken === right) {
      expect(after.right.restartRequests).toBe(before.right.restartRequests + 1);
      expect(after.right.restartAcks).toBe(before.right.restartAcks + 1);
    }
    await framesAdvance(left);
    await framesAdvance(right);
    // The next failure is a separate one, not the same failure noticed late by the other side.
    await left.waitForTimeout(3_000);
  }
  await browser.close();
});

test("both sides noticing the failure at once produce one offer and no rebuild", async () => {
  const browser = await launch();
  const { left, right } = await openCall(browser);
  const before = { left: await snapshot(left), right: await snapshot(right) };
  await Promise.all([forceIce(left, "failed"), forceIce(right, "failed")]);
  await expect(left.locator(".status")).toHaveText("На связи", { timeout: 10_000 });
  await expect(right.locator(".status")).toHaveText("На связи", { timeout: 10_000 });
  // Long enough for a second, conflicting procedure to show itself.
  await left.waitForTimeout(4_000);
  const after = { left: await snapshot(left), right: await snapshot(right) };
  expect(after.left.offers).toBe(before.left.offers + 1);
  expect(after.right.offers).toBe(0);
  expect(after.left.pcs).toBe(before.left.pcs);
  expect(after.right.pcs).toBe(before.right.pcs);
  expect(after.left.rebuilds + after.right.rebuilds).toBe(before.left.rebuilds + before.right.rebuilds);
  await expect(left.locator(".status")).toHaveText("На связи");
  await expect(right.locator(".status")).toHaveText("На связи");
  await framesAdvance(left);
  await framesAdvance(right);
  await browser.close();
});

test("a rebuild happens once, keeps mute, camera and quality limits, and ignores the old connection's signals", async () => {
  const browser = await launch();
  const { left, right } = await openCall(browser);
  await left.getByRole("button", { name: "Микрофон", exact: true }).click();
  await right.getByRole("button", { name: "Камера", exact: true }).click();
  const before = { left: await snapshot(left), right: await snapshot(right) };
  const oldGen = before.left.gen;
  const oldOffer = await left.evaluate(() => (window as unknown as Probe).__wc.lastOffer);
  // Both sides give up on restarts in the same moment and ask the room for a new connection.
  await Promise.all([sendRaw(left, { type: "rebuild", gen: oldGen }), sendRaw(right, { type: "rebuild", gen: oldGen })]);
  await expect.poll(async () => (await snapshot(left)).pcs).toBe(before.left.pcs + 1);
  await expect.poll(async () => (await snapshot(right)).pcs).toBe(before.right.pcs + 1);
  await expect(left.locator(".status")).toHaveText("На связи", { timeout: 25_000 });
  await expect(right.locator(".status")).toHaveText("На связи", { timeout: 25_000 });
  await framesAdvance(left);
  const rebuilt = { left: await snapshot(left), right: await snapshot(right) };
  expect(rebuilt.left.rebuilds).toBe(before.left.rebuilds + 1);
  expect(rebuilt.right.rebuilds).toBe(before.right.rebuilds + 1);
  expect(rebuilt.left.gen).toBe(oldGen + 1);
  expect(rebuilt.left.pcs).toBe(before.left.pcs + 1);
  // The camera and microphone were not asked for again, and the person's choices survived.
  expect(rebuilt.left.media).toBe(before.left.media);
  expect(rebuilt.right.media).toBe(before.right.media);
  expect(rebuilt.left.micEnabled).toBe(false);
  expect(rebuilt.right.cameraEnabled).toBe(false);
  await expect(left.getByRole("button", { name: "Микрофон выключен", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(right.getByRole("button", { name: "Камера выключена", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The new sender starts without limits. The current quality ceiling has to be put on it again.
  await expect.poll(async () => (await snapshot(left)).maxBitrate).toBe(1_200_000);
  await expect.poll(async () => (await snapshot(right)).maxBitrate).toBe(1_200_000);

  // The room does not pass on signals of the old generation.
  await sendRaw(left, { type: "signal", kind: "offer", payload: oldOffer, gen: oldGen });
  await right.waitForTimeout(1_000);
  expect((await snapshot(right)).staleSignals).toBe(0);
  // And a client drops one even if it arrives, as it can from a socket that was slow to close.
  await deliverRaw(right, { type: "signal", kind: "offer", payload: oldOffer, gen: oldGen });
  await right.waitForTimeout(1_500);
  const late = await snapshot(right);
  expect(late.answers).toBe(rebuilt.right.answers);
  expect(late.signaling).toBe("stable");
  expect(late.pcs).toBe(rebuilt.right.pcs);
  await expect(right.locator(".status")).toHaveText("На связи");
  await framesAdvance(right);
  await browser.close();
});

test("hanging up in the middle of a recovery ends the call for good", async () => {
  const browser = await launch();
  const { left, right } = await openCall(browser);
  await forceIce(left, "failed");
  await forceIce(right, "failed");
  await left.getByRole("button", { name: "Завершить" }).click();
  await expect(left.locator(".status")).toHaveText("Звонок завершён");
  const ended = await snapshot(left);
  // Longer than every recovery timer: ack wait, restart wait, connect watchdog.
  await left.waitForTimeout(14_000);
  const later = await snapshot(left);
  expect(later.sockets).toBe(ended.sockets);
  expect(later.openSockets).toBe(0);
  expect(later.pcs).toBe(ended.pcs);
  expect(later.sent).toBe(ended.sent);
  expect(later.media).toBe(ended.media);
  expect(later.liveLocalTracks).toBe(0);
  await expect(left.locator(".status")).toHaveText("Звонок завершён");
  await expect(right.locator(".status")).toContainText("вышел");
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

interface ProbeState {
  pcs: (RTCPeerConnection & { __force: (state: string | null) => void })[];
  sockets: WebSocket[];
  sent: { type: string; kind?: string; gen?: number; ack?: boolean }[];
  received: { type: string; kind?: string; gen?: number; ack?: boolean }[];
  lastOffer: string;
  gen: number;
  media: number;
  streams: MediaStream[];
  statuses: string[];
  mark: number;
}

interface Probe {
  __wc: ProbeState;
}

/** Records what the page does with sockets, connections and devices, and lets a test fake an ICE failure. */
async function arm(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: ProbeState = { pcs: [], sockets: [], sent: [], received: [], lastOffer: "", gen: -1, media: 0, streams: [], statuses: [], mark: 0 };
    (window as unknown as Probe).__wc = state;

    const OriginalSocket = WebSocket;
    const WrappedSocket = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socket = new OriginalSocket(url, protocols);
      state.sockets.push(socket);
      const send = socket.send.bind(socket);
      socket.send = (data: string) => {
        const message = JSON.parse(data) as { type: string; kind?: string; gen?: number; ack?: boolean; payload?: string };
        state.sent.push({ type: message.type, kind: message.kind, gen: message.gen, ack: message.ack });
        if (message.kind === "offer" && message.payload) state.lastOffer = message.payload;
        send(data);
      };
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; kind?: string; gen?: number; ack?: boolean };
        state.received.push({ type: message.type, kind: message.kind, gen: message.gen, ack: message.ack });
        if (typeof message.gen === "number" && message.type !== "signal" && message.type !== "restart") state.gen = message.gen;
      });
      return socket;
    } as unknown as typeof WebSocket;
    WrappedSocket.prototype = OriginalSocket.prototype;
    Object.setPrototypeOf(WrappedSocket, OriginalSocket);
    window.WebSocket = WrappedSocket;

    const OriginalPc = RTCPeerConnection;
    const realIce = Object.getOwnPropertyDescriptor(OriginalPc.prototype, "iceConnectionState")?.get;
    const WrappedPc = function (this: RTCPeerConnection, config?: RTCConfiguration) {
      const pc = new OriginalPc(config) as ProbeState["pcs"][number];
      let forced: string | null = null;
      Object.defineProperty(pc, "iceConnectionState", { get: () => forced ?? realIce?.call(pc) });
      pc.__force = (value) => {
        forced = value;
        pc.dispatchEvent(new Event("iceconnectionstatechange"));
      };
      // A new remote description is what an ICE restart delivers. From then on the real state shows again.
      const setRemote = pc.setRemoteDescription.bind(pc);
      pc.setRemoteDescription = async (description: RTCSessionDescriptionInit) => {
        await setRemote(description);
        if (forced === null) return;
        window.setTimeout(() => {
          forced = null;
          pc.dispatchEvent(new Event("iceconnectionstatechange"));
        }, 400);
      };
      state.pcs.push(pc);
      return pc;
    } as unknown as typeof RTCPeerConnection;
    WrappedPc.prototype = OriginalPc.prototype;
    Object.setPrototypeOf(WrappedPc, OriginalPc);
    window.RTCPeerConnection = WrappedPc;

    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      state.media += 1;
      const stream = await getUserMedia(constraints);
      state.streams.push(stream);
      return stream;
    };

    document.addEventListener("DOMContentLoaded", () => {
      new MutationObserver(() => {
        const text = document.querySelector(".status")?.textContent ?? "";
        if (state.statuses[state.statuses.length - 1] !== text) state.statuses.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  });
}

async function openCall(browser: Browser): Promise<{ left: Page; right: Page; path: string }> {
  const left = await browser.newPage();
  const right = await browser.newPage();
  await arm(left);
  await arm(right);
  await left.goto("/");
  await left.getByRole("button", { name: "Создать ссылку" }).click();
  await expect(left.locator(".link-box")).toContainText("/r/");
  const path = new URL(await left.locator(".link-box").innerText()).pathname;
  await left.goto(path);
  await right.goto(path);
  await left.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(left.locator(".status")).toContainText("Ждём");
  await right.getByRole("button", { name: "Войти в звонок" }).click();
  await expect(left.locator(".status")).toHaveText("На связи", { timeout: 25_000 });
  await expect(right.locator(".status")).toHaveText("На связи", { timeout: 25_000 });
  await framesAdvance(left);
  await framesAdvance(right);
  return { left, right, path };
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as Probe).__wc;
    const pc = state.pcs[state.pcs.length - 1];
    const video = document.querySelector("video.remote") as HTMLVideoElement;
    const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
    const senders = pc?.connectionState === "closed" ? [] : (pc?.getSenders() ?? []);
    const count = (list: ProbeState["sent"], type: string, kind?: string) => list.filter((item) => item.type === type && (kind === undefined || item.kind === kind)).length;
    return {
      pcs: state.pcs.length,
      connection: pc?.connectionState ?? "none",
      signaling: pc?.signalingState ?? "none",
      remoteTracks: stream?.getTracks().map((track) => `${track.kind}:${track.id}:${track.readyState}`).sort() ?? [],
      sockets: state.sockets.length,
      openSockets: state.sockets.filter((socket) => socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING).length,
      sent: state.sent.length,
      offers: count(state.sent, "signal", "offer"),
      answers: count(state.sent, "signal", "answer"),
      restartRequests: state.sent.filter((item) => item.type === "restart" && item.ack === false).length,
      restartAcks: state.received.filter((item) => item.type === "restart" && item.ack === true).length,
      welcomes: count(state.received, "welcome"),
      rebuilds: count(state.received, "rebuild"),
      staleSignals: state.received
        .slice(state.received.map((item) => item.type !== "signal" && item.type !== "restart" && item.gen === state.gen).lastIndexOf(true))
        .filter((item) => item.type === "signal" && item.gen !== state.gen).length,
      gen: state.gen,
      media: state.media,
      liveLocalTracks: state.streams.flatMap((item) => item.getTracks()).filter((track) => track.readyState === "live").length,
      micEnabled: senders.find((sender) => sender.track?.kind === "audio")?.track?.enabled ?? null,
      cameraEnabled: senders.find((sender) => sender.track?.kind === "video")?.track?.enabled ?? null,
      maxBitrate: senders.find((sender) => sender.track?.kind === "video")?.getParameters().encodings[0]?.maxBitrate ?? null,
    };
  });
}

async function dropSocket(page: Page): Promise<void> {
  const closed = await page.evaluate(() => {
    const open = (window as unknown as Probe).__wc.sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
    const socket = open[open.length - 1];
    if (!socket) return false;
    socket.close(4001, "drop");
    return true;
  });
  expect(closed).toBe(true);
}

/** Sends a message to the room as the page would. */
async function sendRaw(page: Page, message: object): Promise<void> {
  await page.evaluate((text) => {
    const open = (window as unknown as Probe).__wc.sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
    open[open.length - 1]?.send(text);
  }, JSON.stringify(message));
}

/** Hands the page a message as if the room had sent it. */
async function deliverRaw(page: Page, message: object): Promise<void> {
  await page.evaluate((text) => {
    const open = (window as unknown as Probe).__wc.sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
    open[open.length - 1]?.dispatchEvent(new MessageEvent("message", { data: text }));
  }, JSON.stringify(message));
}

async function forceIce(page: Page, state: string): Promise<void> {
  await page.evaluate((value) => {
    const pcs = (window as unknown as Probe).__wc.pcs;
    pcs[pcs.length - 1]?.__force(value);
  }, state);
}

async function markStatuses(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as Probe).__wc;
    state.mark = state.statuses.length;
  });
}

async function statusesSinceMark(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = (window as unknown as Probe).__wc;
    return state.statuses.slice(state.mark);
  });
}

/** The remote picture is live, not a frozen last frame. */
async function framesAdvance(page: Page): Promise<void> {
  const frames = () => page.locator("video.remote").evaluate((node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames);
  const start = await frames();
  await expect.poll(frames, { timeout: 10_000 }).toBeGreaterThan(start + 5);
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
