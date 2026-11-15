/* squorli-plugin
{
  "id": "timed-roles",
  "name": { "en": "Timed roles", "de": "Zeitrollen" },
  "description": {
    "en": "Give a member a role for a limited time. When the time is up, the role is taken away again.",
    "de": "Einem Mitglied eine Rolle für begrenzte Zeit geben. Ist die Zeit um, wird die Rolle wieder entzogen."
  },
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "Squorli",
  "homepage": "https://squorli.com/en/docs/plugins/",
  "capabilities": ["members.read", "roles.manage"],
  "settings": [
    {
      "key": "roles",
      "type": "roles",
      "required": true,
      "label": { "en": "Roles that may be given for a time", "de": "Rollen, die auf Zeit vergeben werden dürfen" },
      "help": {
        "en": "Only these roles appear in the member menu's dialog, and only these can the plugin give and take.",
        "de": "Nur diese Rollen erscheinen im Dialog des Mitgliedermenüs, und nur diese kann das Plugin vergeben und entziehen."
      }
    }
  ],
  "memberActions": [
    {
      "id": "give",
      "label": { "en": "Role for a time…", "de": "Rolle auf Zeit…" },
      "permission": "MANAGE_ROLES",
      "target": "any",
      "submitLabel": { "en": "Give", "de": "Vergeben" },
      "fields": [
        { "key": "role", "type": "role", "from": "roles", "required": true, "label": { "en": "Role", "de": "Rolle" } },
        {
          "key": "duration",
          "type": "duration",
          "required": true,
          "min": 60,
          "presets": [3600, 86400, 604800, 2592000],
          "label": { "en": "For how long", "de": "Wie lange" }
        }
      ]
    }
  ],
  "views": [
    {
      "id": "running",
      "title": { "en": "Running assignments", "de": "Laufende Zuweisungen" },
      "columns": [
        { "key": "member", "type": "member", "label": { "en": "Member", "de": "Mitglied" } },
        { "key": "role", "type": "role", "label": { "en": "Role", "de": "Rolle" } },
        { "key": "until", "type": "time", "label": { "en": "Until", "de": "Bis" } },
        { "key": "by", "type": "member", "label": { "en": "Given by", "de": "Vergeben von" } }
      ]
    }
  ]
}
*/

// Timed roles: the reference plugin that ships with Squorli Server, and the worked example of the plugin guide
// (https://squorli.com/en/docs/plugins/). It shows a settings field that sets the plugin's scope, a member action with a
// dialog, a schedule that survives a restart, storage, and a view in Verwaltung > Plugins.
//
// A plugin keeps nothing in variables: the server may stop its sandbox whenever it is idle and start a fresh one for the
// next event. Everything here lives in one storage value and in the schedules.

/** One running assignment. `until` is a time in milliseconds, `by` the member who gave the role. */
interface Assignment { userId: string; roleId: string; until: number; by: string }
type Assignments = Record<string, Assignment>;

const STORE = "assignments";
/** The one value holds every assignment; this many fit comfortably into the 64 KB one storage value may have. */
const MAX_ASSIGNMENTS = 400;

const keyOf = (userId: string, roleId: string): string => `${userId}:${roleId}`;

async function load(): Promise<Assignments> {
  return ((await squorli.storage.get(STORE)) as Assignments | null) ?? {};
}
async function save(all: Assignments): Promise<void> {
  await squorli.storage.set(STORE, all);
}

/** "3 days" / "3 Tagen", for the sentence the dialog answers with. */
function span(seconds: number): { en: string; de: string } {
  const units: [number, string, string, string, string][] = [
    [86400, "day", "days", "Tag", "Tagen"],
    [3600, "hour", "hours", "Stunde", "Stunden"],
    [60, "minute", "minutes", "Minute", "Minuten"],
  ];
  for (const [size, one, many, ein, viele] of units) {
    if (seconds >= size) {
      const n = Math.round(seconds / size);
      return { en: `${n} ${n === 1 ? one : many}`, de: `${n} ${n === 1 ? ein : viele}` };
    }
  }
  return { en: `${seconds} seconds`, de: `${seconds} Sekunden` };
}

/** Forget assignments without touching the roles themselves, and cancel their schedules. */
async function forget(all: Assignments, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  for (const key of keys) {
    delete all[key];
    await squorli.schedule.cancel(key);
  }
  await save(all);
}

// "Rolle auf Zeit…" in the member menu. The server has checked by now that the caller may assign this role to this
// member by hand and that the role is one of those picked in the settings.
squorli.on("memberAction", async (e: Squorli.MemberActionEvent): Promise<Squorli.ActionResult> => {
  const roleId = e.values.role as string;
  const seconds = e.values.duration as number;
  const all = await load();
  const key = keyOf(e.userId, roleId);
  if (!all[key] && Object.keys(all).length >= MAX_ASSIGNMENTS) {
    return { ok: false, message: { en: "Too many timed roles are running. Wait until some have ended.", de: "Es laufen zu viele Zeitrollen. Warte, bis einige abgelaufen sind." } };
  }
  const until = Date.now() + seconds * 1000;
  // The schedule first, the role second: if the server stops in between, the worst case is a job that takes a role the
  // member never got, which changes nothing. The other order could leave a role nobody takes away again.
  await squorli.schedule.at(until, "expire", { userId: e.userId, roleId }, { key });
  all[key] = { userId: e.userId, roleId, until, by: e.by };
  await save(all);
  try {
    await squorli.roles.give(e.userId, roleId);
  } catch (err) {
    await forget(all, [key]);
    squorli.log.warn("could not give the role", String(err));
    return { ok: false, message: { en: "The role could not be given. The plugin's log says why.", de: "Die Rolle konnte nicht vergeben werden. Das Protokoll des Plugins nennt den Grund." } };
  }
  const t = span(seconds);
  return { ok: true, message: { en: `The role is taken away again in ${t.en}.`, de: `Die Rolle wird in ${t.de} wieder entzogen.` } };
});

// The time is up. A job may come twice (after a restart at the wrong moment): taking a role that is gone changes nothing.
squorli.on("job", async (job: Squorli.JobEvent): Promise<void> => {
  if (job.name !== "expire") return;
  const { userId, roleId } = job.payload as { userId: string; roleId: string };
  const all = await load();
  const key = keyOf(userId, roleId);
  const entry = all[key];
  // Given again for longer in the meantime: that newer schedule replaced this one, so an entry that is not due stays.
  if (entry && entry.until > Date.now() + 5000) return;
  await squorli.roles.take(userId, roleId);
  if (entry) {
    delete all[key];
    await save(all);
  }
});

// Somebody took the role away by hand before its time: nothing is left to do, the assignment ends here.
squorli.on("member.roles", async (e: Squorli.MemberRolesEvent): Promise<void> => {
  if (e.removed.length === 0) return;
  const all = await load();
  await forget(all, e.removed.map((roleId) => keyOf(e.userId, roleId)).filter((key) => all[key] !== undefined));
});

squorli.on("member.leave", async (e: Squorli.MemberLeaveEvent): Promise<void> => {
  const all = await load();
  await forget(all, Object.keys(all).filter((key) => all[key]!.userId === e.userId));
});

squorli.on("role.delete", async (e: Squorli.RoleDeleteEvent): Promise<void> => {
  const all = await load();
  await forget(all, Object.keys(all).filter((key) => all[key]!.roleId === e.roleId));
});

// An admin took a role out of the settings: the plugin may not touch it any more, so its running assignments end without
// the role being taken. The log says so, because those members keep the role until somebody removes it by hand.
squorli.on("settings.change", async (): Promise<void> => {
  const allowed = new Set(((await squorli.settings.get()).roles as string[] | undefined) ?? []);
  const all = await load();
  const orphans = Object.keys(all).filter((key) => !allowed.has(all[key]!.roleId));
  if (orphans.length === 0) return;
  await forget(all, orphans);
  squorli.log.warn(`${orphans.length} timed role(s) are no longer watched, because their role left the settings; the members keep the role`);
});

// Verwaltung > Plugins > Zeitrollen > "Laufende Zuweisungen".
squorli.on("view", async (): Promise<Squorli.ViewResult> => {
  const all = await load();
  return Object.values(all)
    .sort((a, b) => a.until - b.until)
    .map((a) => ({ member: a.userId, role: a.roleId, until: a.until, by: a.by }));
});
