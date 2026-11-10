import { describe, expect, it } from "vitest";
import { createIndexedRoom, emptyIndex, lookupRoom } from "../../src/shared/room-index-state";
import { admitPeer, capacityOf, GROUP_CAPACITY, leavePeer, linkGen, newRoom, parseCapacity, rebuildLink, relaySignal, touchPeer, type RoomState } from "../../src/shared/room-state";
import { createRoomId } from "../../src/shared/ids";

const ttl = 60_000;
const limits = { perIpLimit: 2, perIpWindowMs: 60_000, dailyLimit: 3, ttlMs: ttl };

function admit(state: RoomState, id: string, hash: string, now = 1_000, live: string[] = [], capacity?: number) {
  return admitPeer(state, { now, ttlMs: ttl, resumeHash: null, newPeerId: id, newResumeHash: hash, livePeerIds: live, capacity });
}

/** A room with these peers already in it, admitted in order. */
function roomOf(ids: string[], capacity?: number): RoomState {
  let state = newRoom(0, ttl);
  for (const id of ids) {
    const admitted = admit(state, id, `hash-${id}`, 1_000, ids, capacity);
    if (!admitted.ok) throw new Error("admit");
    state = admitted.state;
  }
  return state;
}

function signal(state: RoomState, from: string, to: string, gen: number) {
  return relaySignal(state, { now: 2_000, ttlMs: ttl, fromPeerId: from, toPeerId: to, gen, livePeerIds: state.peers.map((peer) => peer.peerId) });
}

describe("room for two", () => {
  it("keeps signals inside one room and rejects a third peer", () => {
    const other = newRoom(0, ttl);
    const first = admit(newRoom(0, ttl), "a", "hash-a");
    if (!first.ok) throw new Error("admit");
    expect(first.links).toEqual([]);
    const second = admit(first.state, "b", "hash-b");
    if (!second.ok) throw new Error("admit");
    // The one who was here first offers, the newcomer answers.
    expect(second.links).toEqual([{ peerId: "a", gen: second.state.gen, polite: true, kept: false }]);
    const third = admit(second.state, "c", "hash-c");
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.code).toBe("room-full");
    expect(third.state.peers).toHaveLength(2);

    const relay = signal(second.state, "a", "b", second.state.gen);
    expect(relay.ok && relay.deliver).toBe(true);
    expect(other.peers).toEqual([]);
    expect(other.links).toEqual({});
  });

  it("replaces a resumed peer without handing the slot to a wrong token", () => {
    const state = roomOf(["a", "b"]);
    const stolen = admitPeer(state, { now: 3_000, ttlMs: ttl, resumeHash: "nope", newPeerId: "c", newResumeHash: "hash-c", livePeerIds: ["a", "b"] });
    expect(stolen.ok).toBe(false);
    const resumed = admitPeer(state, { now: 3_000, ttlMs: ttl, resumeHash: "hash-a", newPeerId: "ignored", newResumeHash: "hash-a2", livePeerIds: ["a", "b"] });
    if (!resumed.ok) throw new Error("resume");
    expect(resumed.peerId).toBe("a");
    expect(resumed.resumed).toBe(true);
    // No connection named: this peer lost it, so the two must start a new one. It still offers, as before.
    expect(resumed.links).toEqual([{ peerId: "b", gen: state.gen + 1, polite: false, kept: false }]);
    expect(resumed.state.peers).toHaveLength(2);
    expect(resumed.state.peers.find((peer) => peer.peerId === "a")?.resumeHash).toBe("hash-a2");
  });

  it("keeps the generation for a peer that still holds its connection and starts a new one otherwise", () => {
    const state = roomOf(["a", "b"]);
    const gen = linkGen(state, "a", "b")!;
    const resume = (from: RoomState, hash: string, next: string, keepGen: number) =>
      admitPeer(from, { now: 3_000, ttlMs: ttl, resumeHash: hash, newPeerId: "x", newResumeHash: next, livePeerIds: ["b"], keep: [{ peerId: "b", gen: keepGen }] });
    // Only the socket dropped: same generation, nobody rebuilds.
    const kept = resume(state, "hash-a", "hash-a2", gen);
    if (!kept.ok) throw new Error("resume");
    expect(kept.links).toEqual([{ peerId: "b", gen, polite: false, kept: true }]);
    // The peer names a generation the pair has already left behind.
    const moved = rebuildLink(kept.state, "a", "b", gen);
    expect(moved.bumped).toBe(true);
    const late = resume(moved.state, "hash-a2", "hash-a3", gen);
    if (!late.ok) throw new Error("resume");
    expect(late.links[0]?.kept).toBe(false);
    expect(late.links[0]?.gen).toBe(moved.gen + 1);
  });

  it("rebuilds once when both peers ask at the same moment and drops signals of an old generation", () => {
    const state = roomOf(["a", "b"]);
    const gen = linkGen(state, "a", "b")!;
    const one = rebuildLink(state, "a", "b", gen);
    const two = rebuildLink(one.state, "b", "a", gen);
    expect(one.bumped).toBe(true);
    expect(two.bumped).toBe(false);
    expect(linkGen(two.state, "a", "b")).toBe(gen + 1);
    const stale = signal(two.state, "a", "b", gen);
    expect(stale.ok && stale.deliver).toBe(false);
    const fresh = signal(two.state, "a", "b", gen + 1);
    expect(fresh.ok && fresh.deliver).toBe(true);
  });

  it("always leaves exactly one side of a pair to offer, whoever leaves and returns", () => {
    const state = roomOf(["a", "b"]);
    // The first peer hangs up and comes back on a new seat. The one who stayed is now the earlier of the two and offers.
    const back = admit(leavePeer(state, "a").state, "c", "hash-c", 2_000, ["b"]);
    if (!back.ok) throw new Error("admit");
    expect(back.links).toEqual([{ peerId: "b", gen: back.state.gen, polite: true, kept: false }]);
    // The second one leaves instead: the newcomer answers again.
    const again = admit(leavePeer(state, "b").state, "d", "hash-d", 2_000, ["a"]);
    if (!again.ok) throw new Error("admit");
    expect(again.links[0]?.polite).toBe(true);
    // And a resume sees the same roles from the other side.
    const resumed = admitPeer(back.state, { now: 3_000, ttlMs: ttl, resumeHash: "hash-b", newPeerId: "x", newResumeHash: "hash-b2", livePeerIds: ["c"] });
    if (!resumed.ok) throw new Error("resume");
    expect(resumed.links[0]?.polite).toBe(false);
  });

  it("drops a stale peer that is gone, with its links", () => {
    const longTtl = 600_000;
    const first = admitPeer(newRoom(0, longTtl), { now: 1_000, ttlMs: longTtl, resumeHash: null, newPeerId: "a", newResumeHash: "hash-a", livePeerIds: [] });
    if (!first.ok) throw new Error("admit");
    // Nobody to hear it: a signal to a peer that is not there goes nowhere and is not kept.
    const sent = relaySignal(first.state, { now: 1_000, ttlMs: longTtl, fromPeerId: "a", toPeerId: "b", gen: 1, livePeerIds: ["a"] });
    expect(sent.ok && sent.deliver).toBe(false);
    const joined = admitPeer(first.state, { now: 2_000, ttlMs: longTtl, resumeHash: null, newPeerId: "b", newResumeHash: "hash-b", livePeerIds: ["a"] });
    if (!joined.ok) throw new Error("join");
    const touched = touchPeer(joined.state, "b", 200_000, longTtl, ["b"]);
    expect(touched.removedPeerIds).toEqual(["a"]);
    expect(touched.state.peers.map((peer) => peer.peerId)).toEqual(["b"]);
    expect(touched.state.links).toEqual({});
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
    const admitted = admit(newRoom(0, 1_000), "a", "hash-a", 500);
    if (!admitted.ok) throw new Error("admit");
    const late = admitPeer(admitted.state, { now: admitted.state.expiresAt, ttlMs: ttl, resumeHash: "hash-a", newPeerId: "c", newResumeHash: "hash-c", livePeerIds: ["a"] });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.code).toBe("expired");
    expect(late.state.peers.map((peer) => peer.peerId)).toEqual(["a"]);
    expect(late.state.expiresAt).toBe(admitted.state.expiresAt);
    const sent = relaySignal(late.state, { now: late.state.expiresAt, ttlMs: ttl, fromPeerId: "a", toPeerId: "b", gen: 1, livePeerIds: ["a"] });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.code).toBe("expired");
  });
});

describe("conference room", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];

  it("holds six people and refuses the seventh", () => {
    expect(capacityOf("group")).toBe(GROUP_CAPACITY);
    expect(capacityOf("pair")).toBe(2);
    const state = roomOf(ids, GROUP_CAPACITY);
    expect(state.peers).toHaveLength(6);
    // Every pair has its own connection: fifteen of them for six people.
    expect(Object.keys(state.links)).toHaveLength(15);
    const seventh = admit(state, "g", "hash-g", 1_000, ids, GROUP_CAPACITY);
    expect(seventh.ok).toBe(false);
    if (!seventh.ok) expect(seventh.code).toBe("room-full");
    // The size comes from the index. A header that is missing or made up means a room for two.
    expect(parseCapacity("6")).toBe(GROUP_CAPACITY);
    expect(parseCapacity(null)).toBe(2);
    expect(parseCapacity("600")).toBe(2);
    const pair = admit(roomOf(["a", "b"]), "c", "hash-c", 1_000, ["a", "b"]);
    expect(pair.ok).toBe(false);
  });

  it("links a newcomer to everyone without touching the connections that exist", () => {
    const three = roomOf(["a", "b", "c"], GROUP_CAPACITY);
    const before = { ...three.links };
    const fourth = admit(three, "d", "hash-d", 1_000, ["a", "b", "c"], GROUP_CAPACITY);
    if (!fourth.ok) throw new Error("admit");
    expect(fourth.links.map((link) => link.peerId)).toEqual(["a", "b", "c"]);
    // The newcomer answers on every link, so each pair still has exactly one side that offers.
    expect(fourth.links.every((link) => link.polite && !link.kept && link.gen === fourth.state.gen)).toBe(true);
    for (const [key, gen] of Object.entries(before)) expect(fourth.state.links[key]).toBe(gen);
  });

  it("sends a signal to the peer it names and to nobody else", () => {
    const state = roomOf(["a", "b", "c"], GROUP_CAPACITY);
    const toC = signal(state, "a", "c", linkGen(state, "a", "c")!);
    expect(toC.ok && toC.deliver).toBe(true);
    // The generation of another pair does not open this one.
    expect(linkGen(state, "a", "b")).not.toBe(linkGen(state, "a", "c"));
    const wrong = signal(state, "a", "c", linkGen(state, "a", "b")!);
    expect(wrong.ok && wrong.deliver).toBe(false);
    const stranger = signal(state, "z", "a", 1);
    expect(stranger.ok).toBe(false);
  });

  it("rebuilds one pair and leaves the others alone", () => {
    const state = roomOf(["a", "b", "c"], GROUP_CAPACITY);
    const ab = linkGen(state, "a", "b")!;
    const rebuilt = rebuildLink(state, "a", "b", ab);
    expect(rebuilt.bumped).toBe(true);
    expect(linkGen(rebuilt.state, "a", "b")).toBe(rebuilt.gen);
    expect(rebuilt.gen).toBeGreaterThan(state.gen);
    expect(linkGen(rebuilt.state, "a", "c")).toBe(linkGen(state, "a", "c"));
    expect(linkGen(rebuilt.state, "b", "c")).toBe(linkGen(state, "b", "c"));
    // A pair that is not in the room has nothing to rebuild.
    expect(rebuildLink(state, "a", "z", ab).bumped).toBe(false);
  });

  it("lets a returning peer keep the connections it names and rebuild only the ones it lost", () => {
    const state = roomOf(["a", "b", "c"], GROUP_CAPACITY);
    const resumed = admitPeer(state, {
      now: 3_000,
      ttlMs: ttl,
      resumeHash: "hash-b",
      newPeerId: "x",
      newResumeHash: "hash-b2",
      livePeerIds: ["a", "c"],
      capacity: GROUP_CAPACITY,
      keep: [{ peerId: "a", gen: linkGen(state, "a", "b")! }],
    });
    if (!resumed.ok) throw new Error("resume");
    const toA = resumed.links.find((link) => link.peerId === "a")!;
    const toC = resumed.links.find((link) => link.peerId === "c")!;
    expect(toA).toEqual({ peerId: "a", gen: linkGen(state, "a", "b"), polite: true, kept: true });
    expect(toC.kept).toBe(false);
    expect(toC.gen).toBeGreaterThan(state.gen);
    // b came before c, so b still offers on that link.
    expect(toC.polite).toBe(false);
    expect(linkGen(resumed.state, "a", "c")).toBe(linkGen(state, "a", "c"));
  });

  it("frees the seat and the links of someone who leaves", () => {
    const state = roomOf(ids, GROUP_CAPACITY);
    const left = leavePeer(state, "c");
    expect(left.peerCount).toBe(5);
    expect(Object.keys(left.state.links)).toHaveLength(10);
    const next = admit(left.state, "g", "hash-g", 2_000, ids, GROUP_CAPACITY);
    expect(next.ok).toBe(true);
  });

  it("remembers in the index which rooms are conferences", () => {
    const pair = createIndexedRoom(emptyIndex(), { roomId: createRoomId(), ipHash: "ip", now: 1_000, ...limits });
    if (!pair.ok) throw new Error("create");
    const group = createIndexedRoom(pair.state, { roomId: createRoomId(), ipHash: "ip", now: 1_000, kind: "group", ...limits });
    if (!group.ok) throw new Error("create");
    expect(lookupRoom(group.state, pair.roomId, 1_000).room?.kind).toBeUndefined();
    expect(lookupRoom(group.state, group.roomId, 1_000).room?.kind).toBe("group");
  });
});
