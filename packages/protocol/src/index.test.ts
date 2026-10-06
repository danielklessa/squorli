import { describe, expect, it } from "vitest";
import {
  ClientEvent, CreateMessageRequest, MarkReadRequest, MuteRequest, ReadStateResponse, DEFAULT_EVERYONE_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS, PERMISSION_GROUPS, Permission, RtcTokenRequest, ServerEvent,
  CHANNEL_OVERRIDABLE, CHANNEL_PERMISSION_GROUPS, channelOverridableFor,
  ServerSettings, ServerStatus, StatusApiMode, UpdateMeRequest, VerifyRequest, challengeMessage, displayNameOf, hasPermission, mentionedUserIds, permissionNames,
  PRIVACY_POLICY_URL_MAX, UpdateSettingsRequest, WS_CLOSE_ACCOUNT_SUSPENDED, suspendedCloseReason, suspendedUntilOf,
} from "./index";

const U1 = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";

describe("protocol", () => {
  it("carries read states and the event for my other devices", () => {
    expect(ReadStateResponse.safeParse({ channels: [{ channelId: U1, lastReadSeq: null, latestSeq: null, unread: false, mentions: 0 }, { channelId: U1, lastReadSeq: 4, latestSeq: 9, unread: true, mentions: 2 }] }).success).toBe(true);
    expect(ReadStateResponse.safeParse({ channels: [{ channelId: U1, lastReadSeq: 4, latestSeq: 9, unread: true, mentions: -1 }] }).success).toBe(false);
    // The number of unread messages (collapsed categories): optional, never negative.
    expect(ReadStateResponse.safeParse({ channels: [{ channelId: U1, lastReadSeq: 4, latestSeq: 9, unread: true, unreadCount: 5, mentions: 2 }] }).success).toBe(true);
    expect(ReadStateResponse.safeParse({ channels: [{ channelId: U1, lastReadSeq: 4, latestSeq: 9, unread: true, unreadCount: -1, mentions: 2 }] }).success).toBe(false);
    expect(MarkReadRequest.safeParse({ seq: 12 }).success).toBe(true);
    expect(MarkReadRequest.safeParse({ seq: -1 }).success).toBe(false);
    expect(MarkReadRequest.safeParse({ seq: 1.5 }).success).toBe(false);
    expect(ServerEvent.safeParse({ type: "read.update", channelId: U1, lastReadSeq: 12 }).success).toBe(true);
    // Mutes: a server from before mutes leaves the fields out, the client reads that as "not muted".
    const old = ReadStateResponse.parse({ channels: [{ channelId: U1, lastReadSeq: 4, latestSeq: 9, unread: true, mentions: 0 }] });
    expect(old.serverMuted).toBe(false);
    expect(old.channels[0]?.muted).toBe(false);
    expect(old.channels[0]?.unreadCount).toBeUndefined();
    expect(ServerEvent.safeParse({ type: "mute.update", serverMuted: true, channelIds: [U1] }).success).toBe(true);
    expect(MuteRequest.safeParse({ muted: "ja" }).success).toBe(false);
  });
  it("finds mentions outside code only", () => {
    const tok = `<@${U1}>`, tick = String.fromCharCode(96), fence = tick.repeat(3);
    expect(mentionedUserIds(`hi ${tok} und ${tok}`)).toEqual([U1]);
    expect(mentionedUserIds(`> ${tok}`)).toEqual([U1]);
    expect(mentionedUserIds(`${fence}\nnie geschlossen ${tok}`)).toEqual([U1]);
    for (const c of [`${tick}${tok}${tick}`, `${fence}\n${tok}\n${fence}`, `> ${fence}\n> ${tok}\n> ${fence}`, `\\${tok}`, "<@nobody>", `- ${tick}x\n- y${tick} ${tok} ${tick}z${tick}`]) expect(mentionedUserIds(c)).toEqual([]);
  });
  it("parses a hello", () => {
    expect(ClientEvent.safeParse({ type: "hello", protocolVersion: 1, sessionToken: "x" }).success).toBe(true);
  });
  it("rejects unknown event types", () => {
    expect(ClientEvent.safeParse({ type: "nope" }).success).toBe(false);
  });
  it("carries the mute state with the join and as voice.status, and fills it in for older servers", () => {
    expect(ClientEvent.safeParse({ type: "voice.join", channelId: U1, micMuted: true, deafened: false }).success).toBe(true);
    expect(ClientEvent.safeParse({ type: "voice.status", micMuted: false, deafened: true }).success).toBe(true);
    expect(ClientEvent.safeParse({ type: "voice.status", micMuted: "ja" }).success).toBe(false);
    const state = ServerEvent.safeParse({ type: "voice.state", channelId: U1, members: [{ userId: U1, displayName: "A" }] });
    expect(state.success && state.data.type === "voice.state" && state.data.members[0]).toEqual({ userId: U1, displayName: "A", micMuted: false, deafened: false, cameraOn: false, screenOn: false });
    const status = ClientEvent.safeParse({ type: "voice.status", micMuted: false, deafened: false, screenOn: true });
    expect(status.success && status.data.type === "voice.status" && status.data).toEqual({ type: "voice.status", micMuted: false, deafened: false, cameraOn: false, screenOn: true });
    expect(ServerSettings.shape.statusApi.safeParse(undefined).success).toBe(true);
    expect(StatusApiMode.options).toEqual(["off", "key", "public"]);
    const statusApi = ServerStatus.safeParse({
      name: "S", iconUrl: null, time: "2026-09-23T00:00:00.000Z", categories: [], channels: [{ id: U1, kind: "voice", name: "Lobby", topic: null, categoryId: null, position: 0 }],
      members: [{ userId: U1, displayName: "A", handle: null, avatarUrl: null, afk: false, isOwner: false, voice: { channelId: U1, micMuted: true, deafened: false } }],
    });
    expect(statusApi.success).toBe(true);
    // Only members in a voice channel are listed, so a member without a seat is not a status member.
    expect(ServerStatus.shape.members.element.safeParse({ userId: U1, displayName: "A", handle: null, avatarUrl: null, afk: false, isOwner: false, voice: null }).success).toBe(false);
  });
  it("binds the challenge to a domain", () => {
    expect(challengeMessage("a.example", "00")).not.toBe(challengeMessage("b.example", "00"));
  });
  it("parses voice and typing events with uuid channels", () => {
    expect(ClientEvent.safeParse({ type: "voice.join", channelId: U1 }).success).toBe(true);
    expect(ClientEvent.safeParse({ type: "voice.join", channelId: "lobby" }).success).toBe(false);
    expect(ClientEvent.safeParse({ type: "typing", channelId: U1 }).success).toBe(true);
    const state = ServerEvent.safeParse({ type: "voice.state", channelId: U1, members: [{ userId: U1, displayName: "Dani" }] });
    expect(state.success).toBe(true);
  });
  it("accepts optional invite on verify", () => {
    const base = { challengeId: U1, publicKey: "a".repeat(64), signature: "b".repeat(128) };
    expect(VerifyRequest.safeParse(base).success).toBe(true);
    expect(VerifyRequest.safeParse({ ...base, invite: "abc123XYZ_-" }).success).toBe(true);
    expect(VerifyRequest.safeParse({ ...base, invite: "no spaces!" }).success).toBe(false);
  });
  it("restricts rtc-token requests to channel ids", () => {
    expect(RtcTokenRequest.safeParse({ channelId: U1 }).success).toBe(true);
    expect(RtcTokenRequest.safeParse({ room: "lobby" }).success).toBe(false);
  });
  it("trims and bounds display names", () => {
    expect(UpdateMeRequest.parse({ displayName: "  Dani  " }).displayName).toBe("Dani");
    expect(UpdateMeRequest.safeParse({ displayName: "x".repeat(33) }).success).toBe(false);
  });
  it("requires content or attachment on messages", () => {
    expect(CreateMessageRequest.safeParse({ content: "   " }).success).toBe(false);
    expect(CreateMessageRequest.safeParse({ content: "hi" }).success).toBe(true);
    expect(CreateMessageRequest.safeParse({ content: "", attachmentIds: [U1] }).success).toBe(true);
  });
  it("falls back to a key-derived name", () => {
    expect(displayNameOf({ displayName: null, publicKey: "abcdef0123" })).toBe("anon-abcdef");
  });
});

describe("permissions", () => {
  it("shows every permission in exactly one group", () => {
    // A new permission must be sorted into PERMISSION_GROUPS by meaning (role editor); forgetting it fails here.
    const grouped = PERMISSION_GROUPS.flatMap((g) => [...g.permissions]);
    expect([...grouped].sort()).toEqual(Object.keys(Permission).sort());
    expect(new Set(PERMISSION_GROUPS.map((g) => g.id)).size).toBe(PERMISSION_GROUPS.length);
  });
  it("lists every channel-overridable permission once per channel kind, and nothing else", () => {
    // The channel dialog shows CHANNEL_PERMISSION_GROUPS; what a group names must be overridable, and a text or voice channel
    // must see each of its bits exactly once (docs/features/channel-permissions.md).
    for (const kind of ["text", "voice"] as const) {
      const names = CHANNEL_PERMISSION_GROUPS.filter((g) => (g.kinds as readonly string[]).includes(kind)).flatMap((g) => [...g.permissions]);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(CHANNEL_OVERRIDABLE & Permission[n]).toBe(Permission[n]);
    }
    const union = CHANNEL_PERMISSION_GROUPS.flatMap((g) => [...g.permissions]).reduce((m, n) => m | Permission[n], 0);
    expect(union).toBe(CHANNEL_OVERRIDABLE);
    expect(channelOverridableFor("text") & Permission.CONNECT_VOICE).toBe(0);
    expect(channelOverridableFor("voice") & Permission.SEND_MESSAGES).toBe(0);
    // Server-wide only: an overwrite may not hand these out.
    for (const n of ["ADMINISTRATOR", "MANAGE_SERVER", "MANAGE_ROLES", "KICK_MEMBERS", "BAN_MEMBERS", "CREATE_INVITES"] as const) expect(CHANNEL_OVERRIDABLE & Permission[n]).toBe(0);
  });
  it("administrator implies everything", () => {
    expect(hasPermission(Permission.ADMINISTRATOR, Permission.BAN_MEMBERS)).toBe(true);
  });
  it("checks masks", () => {
    // Guest: view and voice only; member: post and stream
    expect(hasPermission(DEFAULT_EVERYONE_PERMISSIONS, Permission.VIEW_CHANNELS)).toBe(true);
    expect(hasPermission(DEFAULT_EVERYONE_PERMISSIONS, Permission.CONNECT_VOICE)).toBe(true);
    expect(hasPermission(DEFAULT_EVERYONE_PERMISSIONS, Permission.SEND_MESSAGES)).toBe(false);
    expect(hasPermission(DEFAULT_EVERYONE_PERMISSIONS, Permission.KICK_MEMBERS)).toBe(false);
    expect(hasPermission(DEFAULT_MEMBER_PERMISSIONS, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(DEFAULT_MEMBER_PERMISSIONS, Permission.STREAM_VIDEO)).toBe(true);
    expect(hasPermission(DEFAULT_MEMBER_PERMISSIONS, Permission.KICK_MEMBERS)).toBe(false);
    // Guests hear the voice channel but do not watch camera/screen; members do.
    expect(hasPermission(DEFAULT_EVERYONE_PERMISSIONS, Permission.VIEW_VIDEO)).toBe(false);
    expect(hasPermission(DEFAULT_MEMBER_PERMISSIONS, Permission.VIEW_VIDEO)).toBe(true);
    // The bit values are part of the migrations (0003/0004, VIEW_VIDEO 16384 in 0013); never renumber them.
    expect(Permission.VIEW_VIDEO).toBe(16384);
    // Starting the radio plays it for everyone in the channel: neither guests nor members may by default (admins always).
    expect(Permission.CONTROL_RADIO).toBe(32768);
    expect(hasPermission(DEFAULT_MEMBER_PERMISSIONS, Permission.CONTROL_RADIO)).toBe(false);
    // Channel permissions (23 September 2026): moving got its own bit (migration 0028 gives it to every role with
    // MODERATE_VOICE), and BYPASS_STICKY frees a member from sticky voice channels.
    expect(Permission.MOVE_MEMBERS).toBe(65536);
    expect(Permission.BYPASS_STICKY).toBe(131072);
    // Reports (26 September 2026): migration 0036 gives MANAGE_REPORTS to every role with MANAGE_MESSAGES.
    expect(Permission.MANAGE_REPORTS).toBe(262144);
    // Reactions (6 October 2026): migration 0042 gives ADD_REACTIONS to every role with SEND_MESSAGES; guests stay without.
    expect(Permission.ADD_REACTIONS).toBe(524288);
    expect(CHANNEL_OVERRIDABLE & Permission.ADD_REACTIONS).toBe(Permission.ADD_REACTIONS);
    expect(CHANNEL_OVERRIDABLE & Permission.MANAGE_NOTICES).toBe(Permission.MANAGE_NOTICES);
    expect(hasPermission(DEFAULT_EVERYONE_PERMISSIONS, Permission.ADD_REACTIONS)).toBe(false);
    expect(DEFAULT_EVERYONE_PERMISSIONS).toBe(1152);
    expect(DEFAULT_MEMBER_PERMISSIONS).toBe(7616 | 16384 | 524288);
    expect(permissionNames(Permission.KICK_MEMBERS | Permission.BAN_MEMBERS)).toEqual(["KICK_MEMBERS", "BAN_MEMBERS"]);
  });
});

describe("suspended directory accounts on a chat server", () => {
  it("carries the end of the suspension in the close reason and reads it back", () => {
    const until = "2026-10-04T10:00:00.000Z";
    expect(WS_CLOSE_ACCOUNT_SUSPENDED).toBe(4014);
    expect(suspendedUntilOf(suspendedCloseReason(until))).toBe(until);
    expect(suspendedUntilOf(until)).toBe(until);
    expect(suspendedUntilOf("account_suspended")).toBeNull();
    expect(suspendedUntilOf("session_revoked")).toBeNull();
    expect(suspendedUntilOf(undefined)).toBeNull();
    expect(new TextEncoder().encode(suspendedCloseReason(until)).length).toBeLessThanOrEqual(123);
  });
  it("reads the switch as absent from a server that predates it and takes it in a settings change", () => {
    const settings = { name: "S", openJoin: true, ownerId: null, iconUrl: null, requireAccount: true, requireAccountLocked: true, listed: false, description: null };
    expect(ServerSettings.parse(settings).refuseSuspended).toBeUndefined();
    expect(ServerSettings.parse({ ...settings, refuseSuspended: false }).refuseSuspended).toBe(false);
    expect(UpdateSettingsRequest.parse({ refuseSuspended: true })).toEqual({ refuseSuspended: true });
  });
});

describe("the server's privacy policy", () => {
  const settings = { name: "S", openJoin: true, ownerId: null, iconUrl: null, requireAccount: true, requireAccountLocked: true, listed: false, description: null };
  it("is absent on a server that predates it and null for none", () => {
    expect(ServerSettings.parse(settings).privacyPolicyUrl).toBeUndefined();
    expect(ServerSettings.parse({ ...settings, privacyPolicyUrl: null }).privacyPolicyUrl).toBeNull();
    expect(UpdateSettingsRequest.parse({ privacyPolicyUrl: null })).toEqual({ privacyPolicyUrl: null });
  });
  it("takes an https address only", () => {
    expect(UpdateSettingsRequest.parse({ privacyPolicyUrl: " https://example.org/datenschutz " })).toEqual({ privacyPolicyUrl: "https://example.org/datenschutz" });
    for (const bad of ["http://example.org/privacy", "javascript:alert(1)", "example.org/privacy", "https://", "https://user:pw@example.org/", "", `https://example.org/${"a".repeat(PRIVACY_POLICY_URL_MAX)}`]) {
      expect(UpdateSettingsRequest.safeParse({ privacyPolicyUrl: bad }).success, bad).toBe(false);
    }
  });
});
