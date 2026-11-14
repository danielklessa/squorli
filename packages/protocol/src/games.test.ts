import { describe, expect, it } from "vitest";
import { AccountSettings, ClientEvent, DirectoryClientEvent, DirectoryServerEvent, Friend, GAME_AUDIENCE_MAX, GamePresence, Member, cleanGameAudienceSetting, gameAudienceOf, gameVisibleTo, sameGameAudience } from "./index";

const KEY = "a".repeat(64);
const UUID = "6f1c2a4e-1b2c-4d3e-8f90-000000000000";

describe("who may see my game", () => {
  const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
  it("turns the setting into what travels: nothing for everybody, the list of the mode otherwise", () => {
    expect(gameAudienceOf(null)).toBeNull();
    expect(gameAudienceOf({ mode: "all", only: [A], except: [B] })).toBeNull();
    expect(gameAudienceOf({ mode: "only", only: [A], except: [B] })).toEqual({ mode: "only", keys: [A] });
    expect(gameAudienceOf({ mode: "except", only: [A], except: [B] })).toEqual({ mode: "except", keys: [B] });
  });
  it("lets the listed see it or keeps them out, and an empty allow list shows it to nobody", () => {
    expect(gameVisibleTo(null, A)).toBe(true);
    expect(gameVisibleTo({ mode: "only", keys: [A] }, A)).toBe(true);
    expect(gameVisibleTo({ mode: "only", keys: [A] }, A.toUpperCase())).toBe(true);
    expect(gameVisibleTo({ mode: "only", keys: [A] }, B)).toBe(false);
    expect(gameVisibleTo({ mode: "only", keys: [] }, A)).toBe(false);
    expect(gameVisibleTo({ mode: "only", keys: [A] }, null)).toBe(false);
    expect(gameVisibleTo({ mode: "except", keys: [A] }, A)).toBe(false);
    expect(gameVisibleTo({ mode: "except", keys: [A] }, B)).toBe(true);
    expect(gameVisibleTo({ mode: "except", keys: [A] }, null)).toBe(true);
  });
  it("compares rules without the order of the keys", () => {
    expect(sameGameAudience(null, undefined)).toBe(true);
    expect(sameGameAudience({ mode: "only", keys: [A, B] }, { mode: "only", keys: [B, A] })).toBe(true);
    expect(sameGameAudience({ mode: "only", keys: [A] }, { mode: "except", keys: [A] })).toBe(false);
    expect(sameGameAudience({ mode: "only", keys: [A] }, { mode: "only", keys: [C] })).toBe(false);
    expect(sameGameAudience({ mode: "only", keys: [] }, null)).toBe(false);
  });
  it("cleans a stored setting: an unknown mode is everybody, odd keys go alone, the lists are capped", () => {
    expect(cleanGameAudienceSetting(null)).toEqual({ mode: "all", only: [], except: [] });
    expect(cleanGameAudienceSetting({ mode: "nobody", only: [A, "x", 3, A.toUpperCase()], except: "no" })).toEqual({ mode: "all", only: [A], except: [] });
    const many = Array.from({ length: GAME_AUDIENCE_MAX + 5 }, (_, i) => i.toString(16).padStart(64, "0"));
    expect(cleanGameAudienceSetting({ mode: "except", except: many }).except).toHaveLength(GAME_AUDIENCE_MAX);
  });
  it("rides on the activity report of both sockets next to the game", () => {
    for (const Event of [ClientEvent, DirectoryClientEvent]) {
      const e = Event.parse({ type: "activity", idle: false, game: { name: "A" }, gameAudience: { mode: "only", keys: [A] } });
      expect(e.type === "activity" && e.gameAudience).toEqual({ mode: "only", keys: [A] });
      const open = Event.parse({ type: "activity", idle: false, game: { name: "A" } });
      expect(open.type === "activity" && open.gameAudience).toBeUndefined();
      expect(Event.safeParse({ type: "activity", idle: false, game: { name: "A" }, gameAudience: { mode: "all", keys: [] } }).success).toBe(false);
      expect(Event.safeParse({ type: "activity", idle: false, game: { name: "A" }, gameAudience: { mode: "only", keys: ["nokey"] } }).success).toBe(false);
    }
  });
});

describe("game display", () => {
  it("takes a launcher's id with a name, or a name alone", () => {
    expect(GamePresence.parse({ id: "steam:730", name: "  Counter-Strike 2 " })).toEqual({ id: "steam:730", name: "Counter-Strike 2" });
    expect(GamePresence.parse({ name: "Altes Spiel" })).toEqual({ name: "Altes Spiel" });
  });

  it("never takes what is not a launcher's id (a path of an added program), a name with line breaks, or an endless one", () => {
    for (const bad of [{ id: "custom:d:\\spiele\\alt.exe", name: "A" }, { id: "epic:Sugar", name: "A" }, { name: "" }, { name: "  " }, { name: "A\nB" }, { name: "A\u0000B" }, { name: "x".repeat(65) }, { id: "steam:730" }, "steam:730"]) {
      expect(GamePresence.safeParse(bad).success).toBe(false);
    }
  });

  it("rides on the activity report of both sockets: a game, none, or nothing said", () => {
    for (const Event of [ClientEvent, DirectoryClientEvent]) {
      const playing = Event.parse({ type: "activity", idle: false, game: { id: "xbox:9NHFVWX1V7QJ", name: "Deep Rock Galactic" } });
      expect(playing.type === "activity" && playing.game).toEqual({ id: "xbox:9NHFVWX1V7QJ", name: "Deep Rock Galactic" });
      const none = Event.parse({ type: "activity", idle: true, game: null });
      expect(none.type === "activity" && none.game).toBeNull();
      const silent = Event.parse({ type: "activity", idle: true });
      expect(silent.type === "activity" && silent.game).toBeUndefined();
      expect(Event.safeParse({ type: "activity", idle: false, game: { id: "custom:x", name: "A" } }).success).toBe(false);
    }
  });

  it("stays readable for data from before it: members, friends and presence default to no game", () => {
    expect(Member.parse({ userId: UUID, displayName: "A", publicKey: KEY, roleIds: [], joinedAt: "2026-09-17T00:00:00.000Z", online: true, streamBlocked: false, handle: null, isOwner: false }).game).toBeNull();
    expect(Friend.parse({ handle: "anna", publicKey: KEY, displayName: null, state: "accepted", since: "2026-09-17T00:00:00.000Z", online: true }).game).toBeNull();
    const presence = DirectoryServerEvent.parse({ type: "friends.presence", publicKey: KEY, online: true, game: { name: "Balatro" } });
    expect(presence.type === "friends.presence" && presence.game).toEqual({ name: "Balatro" });
  });

  it("keeps the two switches in the account, and an account from before them says nothing", () => {
    expect(AccountSettings.parse({}).games).toBeUndefined();
    expect(AccountSettings.parse({ games: {} }).games).toEqual({ enabled: false, servers: true });
    expect(AccountSettings.parse({ games: { enabled: true, servers: false } }).games).toEqual({ enabled: true, servers: false });
  });
});
