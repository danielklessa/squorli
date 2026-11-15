import { Permission, PluginSurface, type Channel, type PluginCommand, type PluginField, type PluginMemberAction, type Role } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { blockedByUnknown, isDrawableField, listItems, newListItem, channelOptions, commandQueryAt, dateDraftOf, dateValueOf, daysWithoutYear, initialValues, pickerValueOf, withDayMonth, withPicked, isKnownFieldType, matchCommands, parseCommandDraft, permissionBit, roleOptions, submitValues, targetFits, usableCommands, usableMemberActions } from "./pluginFields";

const role = (id: string, position: number, permissions = 0, isDefault = false): Role => ({ id, name: id, color: null, permissions, position, isDefault });
const roles = [role("guest", 0, Permission.VIEW_CHANNELS, true), role("member", 1, Permission.SEND_MESSAGES), role("lend", 2), role("kicker", 3, Permission.KICK_MEMBERS), role("mod", 5, Permission.MANAGE_ROLES | Permission.SEND_MESSAGES), role("admin", 9, Permission.ADMINISTRATOR)];
const m = (userId: string, roleIds: string[], isOwner = false) => ({ userId, roleIds, isOwner });
const owner = m("owner", [], true), mod = m("mod", ["mod", "member"]), mod2 = m("mod2", ["mod"]), member = m("member", ["member"]);
const name = { en: "Probe" };
const action = (id: string, permission: string, target: string): PluginMemberAction => ({ plugin: "probe", pluginName: name, id, label: { en: id }, permission, target, fields: [] });
const command = (cmd: string, permission = "SEND_MESSAGES", input = "none"): PluginCommand => ({ plugin: "probe", pluginName: name, name: cmd, description: { en: cmd }, permission, input, fields: [] });
const field = (key: string, type: string, more: Partial<PluginField> = {}): PluginField => ({ key, type, label: { en: key }, required: false, ...more });
const channel = (id: string, kind: "text" | "voice", position = 0): Channel => ({ id, kind, name: id, position } as Channel);

describe("what a member may use of a plugin's surface", () => {
  const surface: PluginSurface = {
    memberActions: [action("any", "MANAGE_ROLES", "any"), action("ranked", "MANAGE_ROLES", "manageable"), action("others", "MANAGE_ROLES", "notSelf"), action("kick", "KICK_MEMBERS", "any"), action("later", "A_LATER_PERMISSION", "any"), action("odd", "MANAGE_ROLES", "aLaterRule")],
    commands: [command("hello"), command("modonly", "MANAGE_MESSAGES"), command("later", "A_LATER_PERMISSION"), command("wizard", "SEND_MESSAGES", "aLaterInput"), command("ask", "SEND_MESSAGES", "form")],
  };
  const MOD = Permission.MANAGE_ROLES | Permission.SEND_MESSAGES;
  const ids = (list: { id: string }[]) => list.map((a) => a.id);

  it("knows a permission by its name and nothing else", () => {
    expect(permissionBit("MANAGE_ROLES")).toBe(Permission.MANAGE_ROLES);
    expect(permissionBit("A_LATER_PERMISSION")).toBeNull();
    expect(permissionBit("toString")).toBeNull();
    expect(permissionBit("__proto__")).toBeNull();
  });
  it("offers a member action only with its server-wide permission", () => {
    expect(ids(usableMemberActions(surface, MOD, mod, member, roles))).toEqual(["any", "ranked", "others"]);
    expect(usableMemberActions(surface, Permission.SEND_MESSAGES, member, mod, roles)).toEqual([]);
    expect(ids(usableMemberActions(surface, Permission.KICK_MEMBERS, member, mod, roles))).toEqual(["kick"]);
  });
  it("hides an action whose permission or target rule this app does not know, even from an owner", () => {
    expect(ids(usableMemberActions(surface, Permission.ADMINISTRATOR, owner, member, roles))).toEqual(["any", "ranked", "others", "kick"]);
  });
  it("applies the target rule: anybody, only whom the viewer outranks, anybody but oneself", () => {
    expect(ids(usableMemberActions(surface, MOD, mod, mod, roles))).toEqual(["any"]);
    expect(ids(usableMemberActions(surface, MOD, mod, mod2, roles))).toEqual(["any", "others"]);
    expect(ids(usableMemberActions(surface, MOD, mod, owner, roles))).toEqual(["any", "others"]);
    expect(targetFits("manageable", owner, mod, roles)).toBe(true);
    expect(targetFits("manageable", owner, owner, roles)).toBe(false);
    expect(targetFits("manageable", mod, member, roles)).toBe(true);
  });
  it("offers nothing without a surface (a server without plugins) or before the own member is known", () => {
    expect(usableMemberActions(undefined, Permission.ADMINISTRATOR, owner, member, roles)).toEqual([]);
    expect(usableMemberActions(surface, Permission.ADMINISTRATOR, null, member, roles)).toEqual([]);
    expect(usableCommands(undefined, Permission.ADMINISTRATOR)).toEqual([]);
  });
  it("offers a command with its permission in the channel, and never one with an unknown permission or input", () => {
    expect(usableCommands(surface, Permission.SEND_MESSAGES).map((c) => c.name)).toEqual(["hello", "ask"]);
    expect(usableCommands(surface, Permission.SEND_MESSAGES | Permission.MANAGE_MESSAGES).map((c) => c.name)).toEqual(["hello", "modonly", "ask"]);
    expect(usableCommands(surface, Permission.ADMINISTRATOR).map((c) => c.name)).toEqual(["hello", "modonly", "ask"]);
    expect(usableCommands(surface, Permission.VIEW_CHANNELS)).toEqual([]);
  });
  it("reads a surface with entries it cannot parse and keeps the rest", () => {
    const parsed = PluginSurface.parse({ commands: [command("ok"), { name: 7 }, "x"], memberActions: [{ nonsense: true }, action("a", "MANAGE_ROLES", "any")] });
    expect(parsed.commands.map((c) => c.name)).toEqual(["ok"]);
    expect(ids(parsed.memberActions)).toEqual(["a"]);
  });
});

describe("a plugin's fields", () => {
  const fields = [field("note", "text", { default: "hi" }), field("on", "boolean"), field("many", "roles"), field("rooms", "channels"), field("one", "role"), field("n", "number", { default: 3 }), field("later", "colour", { default: "#fff" })];

  it("starts a form with the defaults, switches off and lists empty, and leaves unknown types alone", () => {
    expect(initialValues(fields)).toEqual({ note: "hi", on: false, many: [], rooms: [], n: 3 });
  });
  it("tells a known field type from one of a later version", () => {
    expect(isKnownFieldType("duration")).toBe(true);
    expect(isKnownFieldType("colour")).toBe(false);
    expect(isKnownFieldType("")).toBe(false);
  });
  it("blocks sending only when an unknown field is required", () => {
    expect(blockedByUnknown(fields)).toBe(false);
    expect(blockedByUnknown([...fields, field("must", "colour", { required: true })])).toBe(true);
    expect(blockedByUnknown([field("must", "text", { required: true })])).toBe(false);
  });
  it("sends only what it drew: an unknown field's value never goes out, an emptied one goes out as empty", () => {
    expect(submitValues(fields, { note: "x", on: true, many: ["a"], later: "#000", stray: 1 })).toEqual({ note: "x", on: true, many: ["a"], rooms: [], one: null, n: null });
  });

  const games = field("games", "list", { fields: [{ key: "game", type: "text", label: { en: "Game" }, required: true }, { key: "show", type: "select", label: { en: "Show" }, required: false, default: "all", options: [{ value: "all", label: { en: "All" } }] }, { key: "pin", type: "boolean", label: { en: "Pin" }, required: false }] });
  it("draws a list whose entries are made of fields it knows, and none with a column of a later version", () => {
    expect(isDrawableField(games)).toBe(true);
    expect(isDrawableField(field("x", "list", { fields: [{ key: "c", type: "colour", label: { en: "C" }, required: false }] }))).toBe(false);
    expect(isDrawableField(field("x", "list"))).toBe(false);
    expect(isDrawableField(field("x", "list", { fields: [] }))).toBe(false);
    expect(isDrawableField(field("x", "text"))).toBe(true);
    expect(isDrawableField(field("x", "colour"))).toBe(false);
    expect(blockedByUnknown([field("x", "list", { required: true, fields: [{ key: "c", type: "colour", label: { en: "C" }, required: false }] })])).toBe(true);
  });
  it("starts a list empty and a new entry with its fields' defaults; a list it cannot draw is left as the server has it", () => {
    expect(initialValues([games])).toEqual({ games: [] });
    expect(newListItem(games)).toEqual({ show: "all", pin: false });
    expect(submitValues([games], {})).toEqual({ games: [] });
    expect(submitValues([games], { games: [{ game: "A" }] })).toEqual({ games: [{ game: "A" }] });
    const later = field("later", "list", { fields: [{ key: "c", type: "colour", label: { en: "C" }, required: false }] });
    expect(initialValues([later])).toEqual({});
    expect(submitValues([later], { later: [{ c: "#fff" }] })).toEqual({});
  });
  it("reads a stored list as its entries, whatever else is in it", () => {
    expect(listItems([{ game: "A" }, "x", null, 5, ["y"], { game: "B" }])).toEqual([{ game: "A" }, { game: "B" }]);
    expect(listItems(undefined)).toEqual([]);
    expect(listItems("A")).toEqual([]);
  });

  it("a dialog's role field offers the plugin's scope and of that only what the member may assign", () => {
    const f = field("role", "role", { allowed: ["lend", "kicker", "mod", "gone"] });
    expect(roleOptions(f, mod, roles).map((o) => o.id)).toEqual(["lend"]);          // kicker: a right the mod lacks; mod: not below their own
    expect(roleOptions(f, owner, roles).map((o) => o.id)).toEqual(["mod", "kicker", "lend"]);
    expect(roleOptions(f, member, roles)).toEqual([]);
    expect(roleOptions(field("role", "role"), owner, roles)).toEqual([]);            // no list from the server = nothing
    expect(roleOptions(f, null, roles)).toEqual([]);
  });
  it("a settings role field offers what the admin may assign, never an administrator role, plus what is stored", () => {
    const f = field("roles", "roles");
    expect(roleOptions(f, owner, roles, { settings: true }).map((o) => o.id)).toEqual(["mod", "kicker", "lend", "member"]);
    expect(roleOptions(f, mod, roles, { settings: true }).map((o) => o.id)).toEqual(["lend", "member"]);
    // The owner stored "kicker"; the mod cannot add it but sees it, in the owner's order; a deleted role comes last without a role.
    const withStored = roleOptions(f, mod, roles, { settings: true, stored: ["kicker", "lend", "deleted-role"] });
    expect(withStored.map((o) => o.id)).toEqual(["kicker", "lend", "member", "deleted-role"]);
    expect(withStored.at(-1)!.role).toBeNull();
    expect(roleOptions(field("role", "role"), mod, roles, { settings: true, stored: "kicker" }).map((o) => o.id)).toEqual(["kicker", "lend", "member"]);
  });
  it("a channel field offers the visible channels of its kind, text by default, inside the server's list when there is one", () => {
    const channels = [channel("b", "text", 2), channel("a", "text", 1), channel("v", "voice", 0)];
    expect(channelOptions(field("c", "channel"), channels).map((o) => o.id)).toEqual(["a", "b"]);
    expect(channelOptions(field("c", "channel", { channelKind: "voice" }), channels).map((o) => o.id)).toEqual(["v"]);
    expect(channelOptions(field("c", "channel", { allowed: ["b", "v", "hidden"] }), channels).map((o) => o.id)).toEqual(["b"]);
    expect(channelOptions(field("c", "channel", { allowed: [] }), channels)).toEqual([]);
    expect(channelOptions(field("c", "channel", { channelKind: "stage" }), channels)).toEqual([]);
  });
  it("keeps a stored channel this member does not see as an entry without a channel", () => {
    const options = channelOptions(field("c", "channels"), [channel("a", "text")], { stored: ["a", "private"] });
    expect(options.map((o) => [o.id, o.channel !== null])).toEqual([["a", true], ["private", false]]);
  });
});

describe("a date field's value", () => {
  const empty = { year: null, month: null, day: null, noYear: false };

  it("reads a stored value: a whole date for the picker, a date without a year with the switch on", () => {
    expect(dateDraftOf("1990-03-15", true)).toEqual({ year: 1990, month: 3, day: 15, noYear: false });
    expect(dateDraftOf("--03-15", true)).toEqual({ year: null, month: 3, day: 15, noYear: true });
    expect(dateDraftOf("--02-29", true)).toEqual({ year: null, month: 2, day: 29, noYear: true });
    expect(dateDraftOf("2000-02-29", false)).toEqual({ year: 2000, month: 2, day: 29, noYear: false });
  });
  it("starts empty for nothing and for anything that is no date of the field", () => {
    for (const value of [undefined, null, "", "15.03.1990", "1990-3-15", "1990-02-30", "2001-02-29", "--13-01", 19900315, {}]) expect(dateDraftOf(value, true), String(value)).toEqual(empty);
    expect(dateDraftOf("--03-15", false)).toEqual(empty);   // a field that wants the year takes none without
  });
  it("yields the picker's whole date while the switch is off, and nothing while the picker is empty", () => {
    expect(dateValueOf(withPicked(empty, "1990-03-15"), true)).toBe("1990-03-15");
    expect(dateValueOf(withPicked(empty, "1990-03-15"), false)).toBe("1990-03-15");
    expect(dateValueOf(withPicked(empty, "0987-01-02"), false)).toBe("0987-01-02");
    expect(dateValueOf(empty, true)).toBeUndefined();
    expect(dateValueOf(withPicked(withPicked(empty, "1990-03-15"), ""), true)).toBeUndefined();
    expect(dateValueOf(withPicked(empty, "275760-01-01"), true)).toBeUndefined();   // only four-digit years are a value
  });
  it("drops the year with the switch on, and brings it back with the switch off again", () => {
    const picked = withPicked(empty, "1990-03-15");
    const without = { ...picked, noYear: true };
    expect(dateValueOf(without, true)).toBe("--03-15");
    expect(dateValueOf({ ...without, noYear: false }, true)).toBe("1990-03-15");
    expect(pickerValueOf({ ...without, noYear: false })).toBe("1990-03-15");
  });
  it("never yields a date without a year for a field that wants the year", () => {
    expect(dateValueOf({ year: 1990, month: 3, day: 15, noYear: true }, false)).toBe("1990-03-15");
    expect(dateValueOf({ year: null, month: 3, day: 15, noYear: true }, false)).toBeUndefined();
  });
  it("takes a day and a month without any year, and needs both", () => {
    const start = { ...empty, noYear: true };
    expect(dateValueOf(start, true)).toBeUndefined();
    expect(dateValueOf(withDayMonth(start, { month: 7 }), true)).toBeUndefined();
    expect(dateValueOf(withDayMonth(start, { day: 4 }), true)).toBeUndefined();
    expect(dateValueOf(withDayMonth(withDayMonth(start, { day: 4 }), { month: 7 }), true)).toBe("--07-04");
    expect(dateValueOf(withDayMonth(withDayMonth(start, { month: 2 }), { day: 29 }), true)).toBe("--02-29");
    expect(dateValueOf(withDayMonth(dateDraftOf("--07-04", true), { day: null }), true)).toBeUndefined();
  });
  it("offers the days a month has without a year, and takes back a day the new month lacks", () => {
    expect([1, 2, 4, 12].map(daysWithoutYear)).toEqual([31, 29, 30, 31]);
    expect(daysWithoutYear(null)).toBe(31);
    expect(withDayMonth({ year: null, month: 1, day: 31, noYear: true }, { month: 4 })).toEqual({ year: null, month: 4, day: null, noYear: true });
    expect(withDayMonth({ year: null, month: 1, day: 30, noYear: true }, { month: 4 }).day).toBe(30);
  });
  it("comes back empty, never with an invented year, when the switch goes off and no year was picked", () => {
    const stored = dateDraftOf("--03-15", true);
    expect(pickerValueOf({ ...stored, noYear: false })).toBe("");
    expect(dateValueOf({ ...stored, noYear: false }, true)).toBeUndefined();
    // 29 February picked without a year does not exist in the year remembered from before: the picker is empty too.
    const leap = withDayMonth(withDayMonth({ ...withPicked(empty, "2001-03-15"), noYear: true }, { month: 2 }), { day: 29 });
    expect(dateValueOf(leap, true)).toBe("--02-29");
    expect(pickerValueOf({ ...leap, noYear: false })).toBe("");
  });
});

describe("the composer's slash", () => {
  const commands = [command("timer"), command("roll"), command("role-info"), command("poll", "SEND_MESSAGES", "text")];

  it("is a command query while the caret stands in the first word of a draft that starts with one slash", () => {
    expect(commandQueryAt("/", 1)).toBe("");
    expect(commandQueryAt("/ro", 3)).toBe("ro");
    expect(commandQueryAt("/ro", 1)).toBe("ro");
    expect(commandQueryAt("/RO", 3)).toBe("ro");
    expect(commandQueryAt("/roll 2d6", 5)).toBe("roll");
  });
  it("is none before the slash, behind the first word, in the middle of a message or after two slashes", () => {
    expect(commandQueryAt("/ro", 0)).toBeNull();
    expect(commandQueryAt("/roll 2d6", 6)).toBeNull();
    expect(commandQueryAt("see /roll", 9)).toBeNull();
    expect(commandQueryAt(" /roll", 6)).toBeNull();
    expect(commandQueryAt("//roll", 6)).toBeNull();
    expect(commandQueryAt("", 0)).toBeNull();
  });
  it("lists the commands that start with what was typed before those that only contain it", () => {
    expect(matchCommands(commands, "").map((c) => c.name)).toEqual(["poll", "role-info", "roll", "timer"]);
    expect(matchCommands(commands, "ro").map((c) => c.name)).toEqual(["role-info", "roll"]);
    expect(matchCommands(commands, "ol").map((c) => c.name)).toEqual(["poll", "role-info", "roll"]);
    expect(matchCommands(commands, "i").map((c) => c.name)).toEqual(["role-info", "timer"]);
    expect(matchCommands(commands, "zz")).toEqual([]);
  });
  it("takes a sent draft as a command only for the exact name of a usable one", () => {
    expect(parseCommandDraft("/roll", commands)).toEqual({ command: commands[1], text: "" });
    expect(parseCommandDraft("/poll  Pizza or pasta? \n", commands)).toEqual({ command: commands[3], text: "Pizza or pasta?" });
    expect(parseCommandDraft("/poll one\ntwo", commands)?.text).toBe("one\ntwo");
    expect(parseCommandDraft("/Roll", commands)?.command.name).toBe("roll");
  });
  it("leaves everything else an ordinary message", () => {
    expect(parseCommandDraft("/ro", commands)).toBeNull();
    expect(parseCommandDraft("/unknown text", commands)).toBeNull();
    expect(parseCommandDraft("//roll", commands)).toBeNull();
    expect(parseCommandDraft("/", commands)).toBeNull();
    expect(parseCommandDraft("/ roll", commands)).toBeNull();
    expect(parseCommandDraft("roll /roll", commands)).toBeNull();
    expect(parseCommandDraft("/roll", [])).toBeNull();
  });
});
