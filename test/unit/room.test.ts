import { describe, expect, it } from "vitest";
import { createIndexedRoom, emptyIndex, lookupRoom } from "../../src/shared/room-index-state";
import { admitPeer, leavePeer, newRoom, relaySignal, touchPeer } from "../../src/shared/room-state";
import { createRoomId } from "../../src/shared/ids";

const ttl = 60_000;
const limits = { perIpLimit: 2, perIpWindowMs: 60_000, dailyLimit: 3, ttlMs: ttl };

function admit(state: ReturnType<typeof newRoom>, id: string, hash: string, now = 1_000, live: string[] = []) {
  return admitPeer(state, { now, ttlMs: ttl, resumeHash: null, newPeerId: id, newResumeHash: hash, livePeerIds: live });
}

describe("room isolation and two-peer bound", () => {
  it("keeps signals inside one room and rejects a third peer", () => {
    const roomA = newRoom(0, ttl);
    const roomB = newRoom(0, ttl);
    const first = admit(roomA, "a", "hash-a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = admit(first.state, "b", "hash-b");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.peers.map((peer) => peer.polite)).toEqual([false, true]);
    const third = admit(second.state, "c", "hash-c");
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.code).toBe("room-full");
    expect(third.state.peers).toHaveLength(2);

    const relay = relaySignal(second.state, {
      now: 2_000,
      ttlMs: ttl,
      fromPeerId: "a",
      kind: "offer",
      payload: "v=0\r\n",
      livePeerIds: ["a", "b"],
    });
    expect(relay.ok).toBe(true);
    if (!relay.ok) return;
    expect(relay.toPeerIds).toEqual(["b"]);
    expect(roomB.queued).toEqual([]);
    expect(roomB.peers).toEqual([]);
  });

  it("replaces a resumed peer without handing the slot to a wrong token", () => {
    const first = admit(newRoom(0, ttl), "a", "hash-a");
    if (!first.ok) throw new Error("admit");
    const second = admit(first.state, "b", "hash-b");
    if (!second.ok) throw new Error("admit");
    const stolen = admitPeer(second.state, {
      now: 3_000,
      ttlMs: ttl,
      resumeHash: "nope",
      newPeerId: "c",
      newResumeHash: "hash-c",
      livePeerIds: ["a", "b"],
    });
    expect(stolen.ok).toBe(false);
    const resumed = admitPeer(second.state, {
      now: 3_000,
      ttlMs: ttl,
      resumeHash: "hash-a",
      newPeerId: "ignored",
      newResumeHash: "hash-a2",
      livePeerIds: ["a", "b"],
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.peerId).toBe("a");
    expect(resumed.resumed).toBe(true);
    expect(resumed.notify).toBe("reset");
    expect(resumed.state.peers).toHaveLength(2);
    expect(resumed.state.peers.find((peer) => peer.peerId === "a")?.resumeHash).toBe("hash-a2");
  });

  it("drops a stale peer that is gone and delivers a queued offer to the next joiner", () => {
    const longTtl = 600_000;
    const first = admitPeer(newRoom(0, longTtl), {
      now: 1_000,
      ttlMs: longTtl,
      resumeHash: null,
      newPeerId: "a",
      newResumeHash: "hash-a",
      livePeerIds: [],
    });
    if (!first.ok) throw new Error("admit");
    const sent = relaySignal(first.state, {
      now: 1_000,
      ttlMs: longTtl,
      fromPeerId: "a",
      kind: "offer",
      payload: "v=0\r\noffer",
      livePeerIds: ["a"],
    });
    if (!sent.ok) throw new Error("relay");
    expect(sent.toPeerIds).toEqual([]);
    const joined = admitPeer(sent.state, {
      now: 2_000,
      ttlMs: longTtl,
      resumeHash: null,
      newPeerId: "b",
      newResumeHash: "hash-b",
      livePeerIds: ["a"],
    });
    if (!joined.ok) throw new Error("join");
    expect(joined.flush.map((signal) => signal.payload)).toEqual(["v=0\r\noffer"]);
    const touched = touchPeer(joined.state, "b", 200_000, longTtl, ["b"]);
    expect(touched.removedPeerIds).toEqual(["a"]);
    expect(touched.state.peers.map((peer) => peer.peerId)).toEqual(["b"]);
    const left = leavePeer(touched.state, "b");
    expect(left.peerCount).toBe(0);
  });

  it("does not let one address create rooms without bound and hides unknown rooms", () => {
    let state = emptyIndex();
    const ip = "hashed-ip";
    for (let index = 0; index < 2; index += 1) {
      const created = createIndexedRoom(state, { roomId: createRoomId(), ipHash: ip, now: 1_000, ...limits });
      expect(created.ok).toBe(true);
      if (created.ok) state = created.state;
    }
    const blocked = createIndexedRoom(state, { roomId: createRoomId(), ipHash: ip, now: 1_500, ...limits });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("rate");
    const other = createIndexedRoom(blocked.state, { roomId: createRoomId(), ipHash: "other", now: 1_500, ...limits });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const known = other.state.rooms[0]?.roomId ?? "";
    const found = lookupRoom(other.state, known, 1_000);
    expect(found.room?.roomId).toBe(known);
    const missing = lookupRoom(other.state, createRoomId(), 1_000);
    expect(missing.room).toBeNull();
    const expired = lookupRoom(other.state, known, 1_000 + ttl + 1);
    expect(expired.room).toBeNull();
    expect(expired.state.rooms.some((room) => room.roomId === known)).toBe(false);
  });

  it("refuses admission and signaling once the room TTL has passed", () => {
    const room = newRoom(0, 1_000);
    const admitted = admit(room, "a", "hash-a", 500);
    if (!admitted.ok) throw new Error("admit");
    const late = admitPeer(admitted.state, {
      now: admitted.state.expiresAt,
      ttlMs: ttl,
      resumeHash: "hash-a",
      newPeerId: "c",
      newResumeHash: "hash-c",
      livePeerIds: ["a"],
    });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.code).toBe("expired");
    expect(late.state.peers.map((peer) => peer.peerId)).toEqual(["a"]);
    expect(late.state.expiresAt).toBe(admitted.state.expiresAt);
    const signal = relaySignal(late.state, {
      now: late.state.expiresAt,
      ttlMs: ttl,
      fromPeerId: "a",
      kind: "offer",
      payload: "v=0\r\noffer",
      livePeerIds: ["a"],
    });
    expect(signal.ok).toBe(false);
    if (signal.ok) return;
    expect(signal.code).toBe("expired");
    expect(signal.state.queued).toEqual([]);
  });
});
