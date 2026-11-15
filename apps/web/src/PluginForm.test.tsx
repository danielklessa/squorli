import type { Channel, Member, PluginField, PluginViewResponse, Role } from "@squorli/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import { PluginForm, type PluginFormContext } from "./PluginForm";
import { PluginChrome } from "./PluginFormDialog";
import { PluginTable, timeOf } from "./PluginTable";

const role = (id: string, position: number): Role => ({ id, name: `Role ${id}`, color: null, permissions: 0, position, isDefault: false });
const member = (userId: string, displayName: string, isOwner = false) => ({ userId, displayName, roleIds: [], isOwner } as unknown as Member);
const channel = (id: string, name: string) => ({ id, name, kind: "text", position: 0 } as unknown as Channel);
const context: PluginFormContext = { roles: [role("r1", 1), role("r2", 2)], channels: [channel("c1", "general")], members: [member("u1", "Ada", true), member("u2", "Bo")], me: member("u1", "Ada", true) };
const field = (key: string, type: string, more: Partial<PluginField> = {}): PluginField => ({ key, type, label: { en: key }, required: false, ...more });
const form = (fields: PluginField[], values: Record<string, unknown> = {}, more: { settings?: boolean; errors?: Record<string, { en: string }> } = {}) =>
  renderToStaticMarkup(<PluginForm fields={fields} values={values} context={context} onChange={() => undefined} {...more} />);

describe("a plugin's form", () => {
  it("draws every field type of version 1 without throwing", () => {
    const html = form([
      field("a", "text"), field("b", "text", { multiline: true }), field("c", "number", { min: 1, max: 5 }), field("d", "boolean"),
      field("e", "select", { options: [{ value: "x", label: { en: "X" } }] }), field("f", "role", { allowed: ["r1"] }), field("g", "roles", { allowed: ["r1", "r2"] }),
      field("h", "channel"), field("i", "channels"), field("j", "member"), field("k", "duration", { presets: [3600], min: 60 }),
    ], { a: "hello", c: 3, d: true, g: ["r2"], k: 3600 });
    for (const piece of ['value="hello"', "<textarea", 'role="switch"', "<option value=\"x\">X</option>", "Role r1", "# general", "general", "Ada", 'class="duration-input"']) expect(html, piece).toContain(piece);
    expect(html).toContain(t("plugin.field.range", { min: 1, max: 5 }));
  });
  it("draws a date field as a date picker, value in as YYYY-MM-DD, and without a switch when the year is wanted", () => {
    const html = form([field("d", "date")], { d: "1990-03-15" });
    expect(html).toMatch(/<input[^>]*type="date"[^>]*value="1990-03-15"/);
    expect(html).toContain('max="9999-12-31"');
    expect(html).not.toContain(t("plugin.date.noYear"));
    expect(html).not.toContain("<select");
    expect(form([field("d", "date")], { d: "--03-15" })).toMatch(/type="date"[^>]*value=""/);   // no year where the field wants one: empty
    expect(form([field("d", "date")])).toMatch(/type="date"[^>]*value=""/);
  });
  it("gives a date field whose year may be left out the switch, off for a whole date", () => {
    const html = form([field("d", "date", { yearOptional: true })], { d: "1990-03-15" });
    expect(html).toMatch(/type="date"[^>]*value="1990-03-15"/);
    expect(html).toContain(t("plugin.date.noYear"));
    expect(html).toMatch(/<input type="checkbox" class="switch" role="switch"\/>/);
    expect(html).not.toContain("<select");
  });
  it("shows a date without a year as day and month with the switch on, and no year anywhere", () => {
    const html = form([field("d", "date", { yearOptional: true })], { d: "--02-29" });
    expect(html).not.toContain('type="date"');
    expect(html).toMatch(/<input type="checkbox" class="switch" role="switch" checked=""\/>/);
    expect(html).toMatch(/<option value="29" selected="">29<\/option>/);
    expect(html).toMatch(/<option value="2" selected="">[^<]+<\/option>/);
    expect(html).not.toContain('<option value="30">');   // February without a year has 29 days
    expect(html).not.toContain("2000");
  });
  it("draws a list as rows of its fields, each with a remove button, and a button to add one", () => {
    const games = field("games", "list", { maxItems: 2, help: { en: "One game per entry." }, fields: [
      { key: "game", type: "text", label: { en: "Game <b>name</b>" }, required: true, maxLength: 40 },
      { key: "show", type: "select", label: { en: "What to post" }, required: false, default: "all", options: [{ value: "all", label: { en: "All announcements" } }, { value: "patch", label: { en: "Patch notes only" } }] },
      { key: "pin", type: "boolean", label: { en: "Pin" }, required: false },
    ] });
    const empty = form([games], {}, { settings: true });
    expect(empty).toContain(t("plugin.field.listEmpty"));
    expect(empty).toContain(t("plugin.field.listAdd"));
    expect(empty).toContain("One game per entry.");
    const filled = form([games], { games: [{ game: "Counter-Strike 2 (730)", show: "patch", pin: true }, { game: "<i>x</i>" }] }, { settings: true, errors: { games: { en: "Several games fit." } } });
    expect(filled.split('class="plugin-list-item"').length - 1).toBe(2);
    expect(filled).toContain('value="Counter-Strike 2 (730)"');
    expect(filled).toMatch(/<option value="patch" selected="">Patch notes only<\/option>/);
    expect(filled.split(`aria-label="${t("plugin.field.listRemove")}"`).length - 1).toBe(2);
    // A plugin's texts stay text, also as a column's label and as an entry's value.
    expect(filled).toContain("Game &lt;b&gt;name&lt;/b&gt;");
    expect(filled).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(filled).not.toContain("<i>x</i>");
    expect(filled).toContain("Several games fit.");
    // Full: the button rests and the list says why.
    expect(filled).toContain(t("plugin.field.listFull", { max: 2 }));
    expect(filled).toMatch(/<button type="button" class="secondary small" disabled="">/);
  });
  it("shows a list with a column of a later version as one line, not as rows that would lose that column", () => {
    const html = form([field("later", "list", { fields: [{ key: "c", type: "colour", label: { en: "C" }, required: false }] })], { later: [{ c: "#fff" }] }, { settings: true });
    expect(html).toContain(t("plugin.field.needsNewerApp"));
    expect(html).not.toContain("plugin-list-item");
  });
  it("shows one line for a field type it does not know, and no control", () => {
    const html = form([field("later", "colour", { label: { en: "Accent colour" } })], { later: "#fff" });
    expect(html).toContain("Accent colour");
    expect(html).toContain(t("plugin.field.needsNewerApp"));
    expect(html).not.toMatch(/<input|<select|<textarea/);
    expect(form([field("later", "colour", { required: true })])).toContain(t("plugin.field.needsNewerAppRequired"));
  });
  it("shows a plugin's texts as text, never as markup", () => {
    const html = form([field("a", "text", { label: { en: "<img src=x onerror=alert(1)>" }, help: { en: "<b>bold</b>" } })], {}, { errors: { a: { en: "<script>x</script>" } } });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(renderToStaticMarkup(<PluginChrome name={{ en: "<i>Evil</i>" }} />)).toContain("&lt;i&gt;Evil&lt;/i&gt;");
  });
  it("offers a dialog only the roles of the server's list, the settings what the admin may assign", () => {
    const inDialog = form([field("f", "role", { allowed: ["r1"] })]);
    expect(inDialog).toContain("Role r1");
    expect(inDialog).not.toContain("Role r2");
    expect(form([field("f", "role")])).toContain(t("plugin.field.noRoles"));
    const inSettings = form([field("f", "roles")], { f: ["gone"] }, { settings: true });
    expect(inSettings).toContain("Role r1");
    expect(inSettings).toContain("Role r2");
    expect(inSettings).toContain(t("chat.formerRole"));
  });
});

describe("a plugin's table", () => {
  const view = (columns: PluginViewResponse["columns"], rows: PluginViewResponse["rows"]): PluginViewResponse => ({ title: { en: "T" }, columns, rows, truncated: false });
  const table = (v: PluginViewResponse) => renderToStaticMarkup(<PluginTable view={v} members={context.members} roles={context.roles} channels={context.channels} />);

  it("resolves members, roles and channels by id, with the usual words for what is gone", () => {
    const html = table(view(
      [{ key: "m", label: { en: "Member" }, type: "member" }, { key: "r", label: { en: "Role" }, type: "role" }, { key: "c", label: { en: "Channel" }, type: "channel" }],
      [{ m: "u2", r: "r1", c: "c1" }, { m: "nobody", r: "norole", c: "nochannel" }],
    ));
    for (const piece of ["Bo", "Role r1", "# general", t("chat.formerMember"), t("chat.formerRole"), t("plugin.field.hiddenChannel")]) expect(html, piece).toContain(piece);
  });
  it("takes a time as milliseconds or an ISO string, and whatever else as text", () => {
    expect(timeOf(Date.UTC(2026, 10, 22, 13, 5))).toBe("2026-11-22T13:05:00.000Z");
    expect(timeOf("2026-11-22T13:05:00.000Z")).toBe("2026-11-22T13:05:00.000Z");
    expect(timeOf("soon")).toBeNull();
    expect(timeOf(1e300)).toBeNull();
    expect(timeOf({})).toBeNull();
    expect(table(view([{ key: "t", label: { en: "When" }, type: "time" }], [{ t: "soon" }, { t: 1e300 }]))).toContain("soon");
  });
  it("falls back to text for a column type of a later version and for odd values", () => {
    const html = table(view([{ key: "x", label: { en: "<u>X</u>" }, type: "sparkline" }, { key: "d", label: { en: "D" }, type: "duration" }], [{ x: "<b>1</b>", d: 3600 }, { x: { a: 1 }, d: "long" }, { x: null, d: -5 }]));
    expect(html).toContain("&lt;b&gt;1&lt;/b&gt;");
    expect(html).toContain("&lt;u&gt;X&lt;/u&gt;");
    expect(html).toContain("{&quot;a&quot;:1}");
    expect(html).toContain("long");
    expect(html).not.toContain("<b>");
  });
  it("says so when there is nothing", () => {
    expect(table(view([{ key: "x", label: { en: "X" }, type: "text" }], []))).toContain(t("admin.plugins.viewEmpty"));
  });
});
