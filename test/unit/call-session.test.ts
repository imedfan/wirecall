import { afterEach, describe, expect, it } from "vitest";
import { CallSession } from "../../src/client/call-session";

class FakeTrack {
  enabled = true;
  readyState: "live" | "ended" = "live";
  constructor(readonly kind: "audio" | "video") {}
  stop(): void {
    this.readyState = "ended";
  }
  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }
  getSettings(): { height: number } {
    return { height: 720 };
  }
}

class FakeStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }
  addTrack(track: FakeTrack): void {
    this.tracks.push(track);
  }
  removeTrack(track: FakeTrack): void {
    this.tracks = this.tracks.filter((item) => item !== track);
  }
}

const listeners = new Map<string, Set<(event?: { code?: number; reason?: string; data?: string }) => void>>();

function addListener(type: string, fn: (event?: { code?: number; reason?: string; data?: string }) => void): void {
  const set = listeners.get(type) ?? new Set();
  set.add(fn);
  listeners.set(type, set);
}

function removeListener(type: string, fn: (event?: { code?: number; reason?: string; data?: string }) => void): void {
  listeners.get(type)?.delete(fn);
}

let mediaCalls = 0;
let wakeRequests = 0;
let wakeReleases = 0;
let mediaGate: Promise<void> | null = null;
const statuses: string[] = [];
const sockets: FakeSocket[] = [];

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  constructor(readonly url: string) {
    sockets.push(this);
  }
  addEventListener(): void {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}

function install(): void {
  listeners.clear();
  mediaCalls = 0;
  wakeRequests = 0;
  wakeReleases = 0;
  mediaGate = null;
  statuses.length = 0;
  sockets.length = 0;
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  (globalThis as { addEventListener?: typeof addListener; removeEventListener?: typeof removeListener }).addEventListener = addListener;
  (globalThis as { removeEventListener?: typeof removeListener }).removeEventListener = removeListener;
  define("window", globalThis);
  define("document", {
    visibilityState: "visible",
    addEventListener: addListener,
    removeEventListener: removeListener,
  });
  define("location", { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787" });
  const store = new Map<string, string>();
  define("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  });
  define("WebSocket", FakeSocket);
  define("MediaStream", FakeStream);
  define("navigator", {
    mediaDevices: {
      getSupportedConstraints: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, facingMode: true }),
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        mediaCalls += 1;
        if (mediaGate) await mediaGate;
        const tracks: FakeTrack[] = [];
        if (constraints.audio) tracks.push(new FakeTrack("audio"));
        if (constraints.video) tracks.push(new FakeTrack("video"));
        return new FakeStream(tracks);
      },
    },
    wakeLock: {
      request: async () => {
        wakeRequests += 1;
        return { release: async () => { wakeReleases += 1; } };
      },
    },
    connection: { addEventListener: addListener, removeEventListener: removeListener },
  });
}

function video(): HTMLVideoElement {
  return {
    autoplay: false,
    playsInline: false,
    muted: false,
    srcObject: null,
    dataset: {},
    play: () => Promise.resolve(),
  } as unknown as HTMLVideoElement;
}

function session(): CallSession {
  return new CallSession("room", video(), {
    onStatus: (text) => statuses.push(text),
    onDiagnostics: () => undefined,
    onAudioBlocked: () => undefined,
    onMediaIssue: () => undefined,
    onEnded: () => undefined,
    onWaiting: () => undefined,
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("call session mute and hangup", () => {
  afterEach(() => {
    listeners.clear();
  });

  it("does not re-enable a muted mic or camera after a camera switch or foreground reacquire", async () => {
    install();
    const local = video();
    const call = new CallSession("room", local, {
      onStatus: (text) => statuses.push(text),
      onDiagnostics: () => undefined,
      onAudioBlocked: () => undefined,
      onMediaIssue: () => undefined,
      onEnded: () => undefined,
      onWaiting: () => undefined,
    });
    await call.start();
    expect(call.toggleAudio()).toBe(false);
    expect(call.toggleVideo()).toBe(false);
    await call.switchCamera();
    const switched = local.srcObject as unknown as FakeStream;
    expect(switched.getAudioTracks()[0]?.enabled).toBe(false);
    expect(switched.getVideoTracks()[0]?.enabled).toBe(false);
    for (const track of switched.getTracks()) track.readyState = "ended";
    (globalThis as { document: { visibilityState: string } }).document.visibilityState = "hidden";
    listeners.get("visibilitychange")?.forEach((fn) => fn());
    (globalThis as { document: { visibilityState: string } }).document.visibilityState = "visible";
    listeners.get("visibilitychange")?.forEach((fn) => fn());
    await flush();
    expect(switched.getAudioTracks()[0]?.enabled).toBe(false);
    expect(switched.getVideoTracks()[0]?.enabled).toBe(false);
    expect(statuses.at(-1)).toBe("Камера и микрофон снова работают");
    call.hangup();
    expect(listeners.get("visibilitychange")?.size ?? 0).toBe(0);
  });

  it("drops media from a start that loses the race with hangup and does not wake after hangup", async () => {
    install();
    let release: () => void = () => undefined;
    mediaGate = new Promise((resolve) => {
      release = resolve;
    });
    const call = session();
    const starting = call.start();
    await flush();
    expect(mediaCalls).toBe(1);
    call.hangup();
    release();
    await starting;
    expect(wakeRequests).toBe(0);
    expect(sockets).toHaveLength(0);
    const wakesAfterHangup = wakeRequests;
    const callsAfterHangup = mediaCalls;
    (globalThis as { document: { visibilityState: string } }).document.visibilityState = "visible";
    listeners.get("visibilitychange")?.forEach((fn) => fn());
    listeners.get("online")?.forEach((fn) => fn());
    listeners.get("change")?.forEach((fn) => fn());
    await flush();
    expect(wakeRequests).toBe(wakesAfterHangup);
    expect(mediaCalls).toBe(callsAfterHangup);
    expect(listeners.get("visibilitychange")?.size ?? 0).toBe(0);
    await call.start();
    expect(mediaCalls).toBe(callsAfterHangup + 1);
    expect(wakeRequests).toBe(1);
    call.hangup();
    expect(wakeReleases).toBeGreaterThan(0);
  });
});
