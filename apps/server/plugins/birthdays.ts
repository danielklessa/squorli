/* squorli-plugin
{
  "id": "birthdays",
  "name": { "en": "Birthdays", "de": "Geburtstage" },
  "description": {
    "en": "Members enter their birthday with /birthday and are congratulated in a channel on the day, with their age if they gave the year. /birthdays shows whose birthday comes next.",
    "de": "Mitglieder tragen mit /geburtstag ihren Geburtstag ein und werden am Tag selbst in einem Kanal beglückwünscht, mit Alter, wenn sie das Jahr angegeben haben. /geburtstage zeigt, wer als Nächstes Geburtstag hat."
  },
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "Squorli",
  "homepage": "https://squorli.com/en/docs/plugins/",
  "capabilities": ["members.read", "messages.write"],
  "settings": [
    {
      "key": "channel",
      "type": "channel",
      "required": true,
      "label": { "en": "Channel for the congratulations", "de": "Kanal für die Glückwünsche" }
    },
    {
      "key": "hour",
      "type": "number",
      "default": 9,
      "min": 0,
      "max": 23,
      "label": { "en": "Hour of the day (0 to 23)", "de": "Uhrzeit (Stunde, 0 bis 23)" }
    },
    {
      "key": "zone",
      "type": "select",
      "default": "cet",
      "label": { "en": "Time zone", "de": "Zeitzone" },
      "help": {
        "en": "The three European entries follow summer time by themselves. The fixed ones never change: adjust them by hand where clocks are turned.",
        "de": "Die drei europäischen Einträge folgen der Sommerzeit von selbst. Die festen ändern sich nie: Stelle sie von Hand um, wo die Uhren umgestellt werden."
      },
      "options": [
        { "value": "cet", "label": { "en": "Central Europe (Berlin, Vienna, Zurich, Paris)", "de": "Mitteleuropa (Berlin, Wien, Zürich, Paris)" } },
        { "value": "wet", "label": { "en": "Western Europe (London, Lisbon)", "de": "Westeuropa (London, Lissabon)" } },
        { "value": "eet", "label": { "en": "Eastern Europe (Helsinki, Athens)", "de": "Osteuropa (Helsinki, Athen)" } },
        { "value": "utc-11", "label": "UTC-11" }, { "value": "utc-10", "label": "UTC-10" }, { "value": "utc-9", "label": "UTC-9" },
        { "value": "utc-8", "label": "UTC-8" }, { "value": "utc-7", "label": "UTC-7" }, { "value": "utc-6", "label": "UTC-6" },
        { "value": "utc-5", "label": "UTC-5" }, { "value": "utc-4", "label": "UTC-4" }, { "value": "utc-3", "label": "UTC-3" },
        { "value": "utc-2", "label": "UTC-2" }, { "value": "utc-1", "label": "UTC-1" }, { "value": "utc+0", "label": "UTC" },
        { "value": "utc+1", "label": "UTC+1" }, { "value": "utc+2", "label": "UTC+2" }, { "value": "utc+3", "label": "UTC+3" },
        { "value": "utc+4", "label": "UTC+4" }, { "value": "utc+5", "label": "UTC+5" }, { "value": "utc+6", "label": "UTC+6" },
        { "value": "utc+7", "label": "UTC+7" }, { "value": "utc+8", "label": "UTC+8" }, { "value": "utc+9", "label": "UTC+9" },
        { "value": "utc+10", "label": "UTC+10" }, { "value": "utc+11", "label": "UTC+11" }, { "value": "utc+12", "label": "UTC+12" }
      ]
    },
    {
      "key": "language",
      "type": "select",
      "default": "de",
      "label": { "en": "Language of the congratulations", "de": "Sprache der Glückwünsche" },
      "options": [
        { "value": "de", "label": "Deutsch" },
        { "value": "en", "label": "English" }
      ]
    }
  ],
  "commands": [
    {
      "name": "geburtstag",
      "input": "form",
      "description": { "en": "Enter or remove your birthday", "de": "Deinen Geburtstag eintragen oder entfernen" },
      "fields": [
        { "key": "date", "type": "date", "yearOptional": true, "label": { "en": "Your birthday", "de": "Dein Geburtstag" },
          "help": { "en": "With the year, the congratulation names your age. Without it, it does not.", "de": "Mit Jahr nennt der Glückwunsch dein Alter. Ohne Jahr nicht." } },
        { "key": "remove", "type": "boolean", "label": { "en": "Remove my birthday again", "de": "Meinen Geburtstag wieder entfernen" } }
      ]
    },
    {
      "name": "birthday",
      "input": "form",
      "description": { "en": "Enter or remove your birthday", "de": "Deinen Geburtstag eintragen oder entfernen" },
      "fields": [
        { "key": "date", "type": "date", "yearOptional": true, "label": { "en": "Your birthday", "de": "Dein Geburtstag" },
          "help": { "en": "With the year, the congratulation names your age. Without it, it does not.", "de": "Mit Jahr nennt der Glückwunsch dein Alter. Ohne Jahr nicht." } },
        { "key": "remove", "type": "boolean", "label": { "en": "Remove my birthday again", "de": "Meinen Geburtstag wieder entfernen" } }
      ]
    },
    { "name": "geburtstage", "description": { "en": "Shows the next birthdays", "de": "Zeigt die nächsten Geburtstage" } },
    { "name": "birthdays", "description": { "en": "Shows the next birthdays", "de": "Zeigt die nächsten Geburtstage" } }
  ],
  "views": [
    {
      "id": "list",
      "title": { "en": "Entered birthdays", "de": "Eingetragene Geburtstage" },
      "columns": [
        { "key": "member", "type": "member", "label": { "en": "Member", "de": "Mitglied" } },
        { "key": "date", "label": { "en": "Birthday", "de": "Geburtstag" } },
        { "key": "year", "label": { "en": "Year", "de": "Jahr" } }
      ]
    }
  ]
}
*/

// Birthdays: the second plugin that ships with Squorli Server (https://squorli.com/en/docs/plugins/). It shows a slash
// command with a form under two names (a date field whose year may be left out), a command whose answer only the caller sees, a job that comes back every day, and
// what a plugin does about time: the sandbox has no time zones, so the plugin computes the local day itself.
//
// Only a member enters their own birthday, and only they take it out again (the form's last field); it also goes when
// they leave the server. The year is optional; without one no age is named.

/** A member's birthday: day 1 to 31, month 1 to 12, and the year of birth when they gave one. */
interface Birthday { d: number; m: number; y?: number }
type Birthdays = Record<string, Birthday>;
interface Config { channel?: string; hour: number; zone: string; language: string }

const STORE = "birthdays";
/** The date (in the server's time zone of the settings) the last congratulations went out for: a job that comes twice does nothing. */
const LAST_RUN = "lastRun";
const JOB = "daily";
/** One storage value holds everybody; this many entries stay well inside its 64 KB. */
const MAX_ENTRIES = 1200;
const DAY_MS = 86_400_000;

async function load(): Promise<Birthdays> {
  return ((await squorli.storage.get(STORE)) as Birthdays | null) ?? {};
}
async function config(): Promise<Config> {
  const s = await squorli.settings.get();
  return {
    ...(typeof s.channel === "string" ? { channel: s.channel } : {}),
    hour: typeof s.hour === "number" ? Math.min(23, Math.max(0, Math.floor(s.hour))) : 9,
    zone: typeof s.zone === "string" ? s.zone : "cet",
    language: s.language === "en" ? "en" : "de",
  };
}

// ---------- Time. The sandbox knows UTC only, so the local day is computed here.

/** The day of the month of the last Sunday of a month (0 = January). */
function lastSunday(year: number, month: number): number {
  const end = new Date(Date.UTC(year, month + 1, 0));
  return end.getUTCDate() - end.getUTCDay();
}
/** European summer time: from the last Sunday of March to the last Sunday of October, each at 01:00 UTC. */
function europeanSummer(utcMs: number): boolean {
  const year = new Date(utcMs).getUTCFullYear();
  return utcMs >= Date.UTC(year, 2, lastSunday(year, 2), 1) && utcMs < Date.UTC(year, 9, lastSunday(year, 9), 1);
}
/** Minutes a zone is ahead of UTC at a moment. */
function offsetMinutes(zone: string, utcMs: number): number {
  const summer = europeanSummer(utcMs) ? 60 : 0;
  if (zone === "wet") return summer;
  if (zone === "cet") return 60 + summer;
  if (zone === "eet") return 120 + summer;
  const fixed = /^utc([+-]\d{1,2})$/.exec(zone);
  return fixed ? Number(fixed[1]) * 60 : 60 + summer;
}
/** The calendar day a moment falls on in a zone. */
function localDay(zone: string, utcMs: number): { y: number; m: number; d: number } {
  const local = new Date(utcMs + offsetMinutes(zone, utcMs) * 60_000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}
/** The next moment after `now` at which the zone's clock shows `hour`:00. */
function nextRun(zone: string, hour: number, now: number): number {
  for (let ahead = 0; ahead < 3; ahead++) {
    const day = localDay(zone, now + ahead * DAY_MS);
    const guess = Date.UTC(day.y, day.m - 1, day.d, hour) - offsetMinutes(zone, now + ahead * DAY_MS) * 60_000;
    // The offset of the moment itself, which differs from the guess's on the two days a year the clocks are turned.
    const at = Date.UTC(day.y, day.m - 1, day.d, hour) - offsetMinutes(zone, guess) * 60_000;
    if (at > now + 1000) return at;
  }
  return now + DAY_MS;
}
const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Is this birthday today? Somebody born on 29 February is congratulated on the 28th in a year without one. */
function isToday(b: Birthday, today: { y: number; m: number; d: number }): boolean {
  if (b.m === today.m && b.d === today.d) return true;
  return b.m === 2 && b.d === 29 && today.m === 2 && today.d === 28 && !isLeapYear(today.y);
}

async function schedule(): Promise<void> {
  const c = await config();
  await squorli.schedule.at(nextRun(c.zone, c.hour, Date.now()), "congratulate", null, { key: JOB });
}

// ---------- Texts

const MONTHS_DE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dateText = (b: Birthday): { en: string; de: string } => ({ en: `${MONTHS_EN[b.m - 1]} ${b.d}`, de: `${b.d}. ${MONTHS_DE[b.m - 1]}` });

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
/** The line that goes into the channel. `<@id>` is how a message mentions a member. */
function congratulation(language: string, userId: string, age: number | null): string {
  const who = `<@${userId}>`;
  if (language === "en") return age === null ? `🎉 Happy birthday, ${who}!` : `🎉 Happy ${ordinal(age)} birthday, ${who}!`;
  return age === null ? `🎉 Alles Gute zum Geburtstag, ${who}!` : `🎉 Alles Gute zum ${age}. Geburtstag, ${who}!`;
}

/** The day a birthday falls on in a year, as a number to sort by (29 February counts as the 28th in a year without one). */
function occurrence(b: Birthday, year: number): number {
  return Date.UTC(year, b.m - 1, b.m === 2 && b.d === 29 && !isLeapYear(year) ? 28 : b.d);
}

// /geburtstage or /birthdays: whose birthday comes next. The answer goes to the caller only, and it is plain text of at
// most 500 characters, so it names as many as fit. An age is named where the member gave a year, as the congratulation
// will name it.
async function upcoming(): Promise<Squorli.ActionResult> {
  const all = await load();
  const today = localDay((await config()).zone, Date.now());
  const start = Date.UTC(today.y, today.m - 1, today.d);
  const next = Object.keys(all).map((userId) => {
    const b = all[userId]!;
    const year = occurrence(b, today.y) < start ? today.y + 1 : today.y;
    return { userId, b, year, at: occurrence(b, year) };
  }).sort((x, y) => x.at - y.at).slice(0, 8);
  const en = ["The next birthdays:"], de = ["Die nächsten Geburtstage:"];
  for (const n of next) {
    const member = await squorli.members.get(n.userId);
    if (!member) continue;
    const name = member.displayName.length > 24 ? `${member.displayName.slice(0, 23)}…` : member.displayName;
    const when = dateText(n.b);
    const isToday = n.at === start;
    const lineEn = `${isToday ? "today" : when.en}: ${name}${n.b.y === undefined ? "" : ` (turns ${n.year - n.b.y})`}`;
    const lineDe = `${isToday ? "heute" : when.de}: ${name}${n.b.y === undefined ? "" : ` (wird ${n.year - n.b.y})`}`;
    if ([...de, lineDe].join("\n").length > 480 || [...en, lineEn].join("\n").length > 480) break;
    en.push(lineEn);
    de.push(lineDe);
  }
  if (en.length === 1) return { ok: true, message: { en: "Nobody has entered a birthday yet. Enter yours with /birthday.", de: "Noch hat niemand einen Geburtstag eingetragen. Trage deinen mit /geburtstag ein." } };
  return { ok: true, message: { en: en.join("\n"), de: de.join("\n") } };
}

// ---------- Events

// /geburtstag or /birthday: one date field, which the app draws as a date picker, and the switch that takes the entry out.
squorli.on("command", async (e: Squorli.CommandEvent): Promise<Squorli.ActionResult> => {
  if (e.command === "geburtstage" || e.command === "birthdays") return upcoming();
  const all = await load();
  if (e.values.remove === true) {
    if (!all[e.by]) return { ok: true, message: { en: "No birthday of yours was entered.", de: "Von dir war kein Geburtstag eingetragen." } };
    delete all[e.by];
    await squorli.storage.set(STORE, all);
    return { ok: true, message: { en: "Your birthday was removed.", de: "Dein Geburtstag wurde entfernt." } };
  }
  // The date arrives as the form's date field checked it: "YYYY-MM-DD", or "--MM-DD" when the member left the year out.
  // That it is a day of the calendar is settled by then; whether the year can be a year of birth is this plugin's question.
  const given = typeof e.values.date === "string" ? /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(e.values.date) : null;
  if (!given) return { ok: false, fieldErrors: { date: { en: "Pick your birthday.", de: "Wähle deinen Geburtstag." } } };
  const y = given[1] === undefined ? null : Number(given[1]);
  const m = Number(given[2]), d = Number(given[3]);
  const c = await config();
  const today = localDay(c.zone, Date.now());
  const born = y === null ? null : Date.UTC(y, m - 1, d);
  if (y !== null && (born! > Date.UTC(today.y, today.m - 1, today.d) || today.y - y > 130)) {
    return { ok: false, fieldErrors: { date: { en: "This year cannot be right.", de: "Dieses Jahr kann nicht stimmen." } } };
  }

  if (!all[e.by] && Object.keys(all).length >= MAX_ENTRIES) {
    return { ok: false, message: { en: "The list of birthdays is full. Tell an admin.", de: "Die Geburtstagsliste ist voll. Sag einem Admin Bescheid." } };
  }
  const entry: Birthday = y === null ? { d, m } : { d, m, y };
  all[e.by] = entry;
  await squorli.storage.set(STORE, all);
  // In case the daily job was ever lost: asking again costs nothing, the key replaces it.
  await schedule();
  const when = dateText(entry);
  const how = y === null
    ? { en: "Your age is not named, because you gave no year.", de: "Dein Alter wird nicht genannt, weil du kein Jahr angegeben hast." }
    : { en: "The congratulation will name your age.", de: "Der Glückwunsch nennt dein Alter." };
  if (!c.channel) {
    return { ok: true, message: { en: `Saved: ${when.en}. ${how.en} No channel is set up yet, so nothing is posted until an admin picks one.`, de: `Gespeichert: ${when.de}. ${how.de} Noch ist kein Kanal eingestellt; bis ein Admin einen auswählt, wird nichts geschrieben.` } };
  }
  return { ok: true, message: { en: `Saved: ${when.en}. ${how.en}`, de: `Gespeichert: ${when.de}. ${how.de}` } };
});

// Once a day. The day that counts is the one the job was due on, not the one it arrives on: after a night in which the
// server was down, the congratulations are late, but they are the right ones. `lastRun` keeps a job that comes twice
// from congratulating twice.
squorli.on("job", async (job: Squorli.JobEvent): Promise<void> => {
  if (job.name !== "congratulate") return;
  const c = await config();
  const today = localDay(c.zone, Date.parse(job.dueAt));
  const stamp = `${today.y}-${today.m}-${today.d}`;
  // The next day first: whatever fails below, tomorrow's job waits.
  await schedule();
  if ((await squorli.storage.get(LAST_RUN)) === stamp || !c.channel) return;
  await squorli.storage.set(LAST_RUN, stamp);
  const all = await load();
  // At most ten congratulations a day keep this event inside its limits; a community with more shared birthdays than
  // that on one day sees the first ten.
  const due = Object.keys(all).filter((userId) => isToday(all[userId]!, today)).slice(0, 10);
  for (const userId of due) {
    const b = all[userId]!;
    await squorli.messages.send(c.channel, congratulation(c.language, userId, b.y === undefined ? null : today.y - b.y));
  }
});

// The hour or the zone may have changed, and a fresh installation has no job yet.
squorli.on("enable", schedule);
squorli.on("settings.change", schedule);

// Whoever leaves the server takes their birthday along.
squorli.on("member.leave", async (e: Squorli.MemberLeaveEvent): Promise<void> => {
  const all = await load();
  if (!all[e.userId]) return;
  delete all[e.userId];
  await squorli.storage.set(STORE, all);
});

// Verwaltung > Plugins > Geburtstage > "Eingetragene Geburtstage", in the order of the calendar.
squorli.on("view", async (): Promise<Squorli.ViewResult> => {
  const all = await load();
  const language = (await config()).language;
  return Object.keys(all)
    .sort((a, b) => all[a]!.m - all[b]!.m || all[a]!.d - all[b]!.d)
    .map((userId) => ({ member: userId, date: language === "en" ? dateText(all[userId]!).en : dateText(all[userId]!).de, year: all[userId]!.y ?? "" }));
});
