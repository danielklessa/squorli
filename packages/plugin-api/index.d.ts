/**
 * Squorli plugin interface, version 2 (version 1 plus the network: `squorli.net`, the capability `net.fetch` and the
 * manifest's `network`; a plugin that uses none of it names `"apiVersion": 1` and runs on servers from before 0.15.0 too).
 *
 * This file describes everything a plugin can see: the global `squorli` and the events it listens to. It is the reference
 * for authors; the guide with examples is at https://squorli.com/en/docs/plugins/ (German: /de/docs/plugins/).
 *
 * A plugin is ONE file, JavaScript or TypeScript. It starts with its manifest as JSON in a block comment whose first word
 * is `squorli-plugin`; the code follows. The server runs the file in a sandbox: the JavaScript language and `squorli`,
 * nothing else. There is no `process`, no `require`, no `fetch`, no timers and no `import` of anything. The one way to
 * the internet is `squorli.net.get`, for plugins Squorli signed (see `Net`).
 *
 * For a TypeScript plugin, put this file next to yours (or name it in the `files` of a tsconfig) and nothing needs to be
 * imported: `squorli` and the namespace `Squorli` are global. The server only removes the types when it installs the file,
 * it does not check them, and it takes only what can be removed without rewriting code: no `enum`, no `namespace` with
 * values, no parameter properties (`"erasableSyntaxOnly": true` in a tsconfig finds these before the server does).
 *
 * Three rules that explain most of this interface:
 * - **Keep nothing in variables.** The server stops a plugin's sandbox when it is idle and starts a fresh one for the next
 *   event. State lives in `squorli.storage`, time in `squorli.schedule`.
 * - **Host functions answer only inside a handler.** Every function below returns a promise; `await` it in the handler
 *   of the event you are handling. A call made at the top level of the file, or left running after the handler returned,
 *   is refused.
 * - **A plugin touches what an admin picked.** Roles and channels are usable only when an admin chose them in one of the
 *   plugin's settings fields of type `role`, `roles`, `channel` or `channels`.
 *
 * Limits of one event: 200 ms of CPU time, 10 s in all, 50 host calls, 32 MB of memory, 64 KB per argument and per answer
 * (the operator can change the CPU time and the memory; the answer of `net.get` may be larger). Limits per minute: 300
 * host calls, 60 role changes, 20 messages, 120 storage writes, 60 log lines, 30 requests to the network. Five failures
 * within ten minutes suspend the plugin until an owner switches it on again.
 */
declare namespace Squorli {
  /** A text shown to people: plain English, or English and German. Shown as text, never as markup. */
  type Text = string | { en: string; de?: string };

  // ---------- What a plugin gets to see ----------

  interface Role {
    id: string;
    name: string;
    /** "#rrggbb" or null. */
    color: string | null;
    /** Higher = more powerful. */
    position: number;
    /** The role every member has; it cannot be given or taken. */
    isDefault: boolean;
    /** May this plugin give and take the role right now (it is in the scope and unchanged since the settings were saved)? */
    manageable: boolean;
  }

  interface Member {
    userId: string;
    displayName: string;
    /** "@name" (an account of the directory), "~name" (an account of this server) or null. */
    handle: string | null;
    /** The member's roles without the default role. */
    roleIds: string[];
    /** ISO time. */
    joinedAt: string;
    isOwner: boolean;
  }

  interface Channel {
    id: string;
    name: string;
    kind: "text" | "voice";
  }

  interface Message {
    id: string;
    /** Rises with every message of the server; `messages.history` pages with it. */
    seq: number;
    channelId: string;
    /** A member's id, or a plugin's own author (then `plugin` is set). */
    authorId: string;
    content: string;
    /** ISO time. */
    createdAt: string;
    editedAt: string | null;
    /** How many files hang on the message; null where it is not counted (`messages.history`). A plugin never gets the files. */
    attachments: number | null;
    /** The id of the plugin that wrote the message, else null. */
    plugin: string | null;
  }

  interface Job {
    key: string | null;
    name: string;
    /** ISO time. */
    dueAt: string;
  }

  // ---------- Events ----------

  /** An owner switched the plugin on, or installed a new version of it. Not sent when the server starts. */
  interface EnableEvent { reason: "enabled" | "updated" }
  /** The plugin is being switched off or removed. About a second is left. */
  interface DisableEvent {}
  /** An admin saved the plugin's settings. Read them with `settings.get()`. */
  interface SettingsChangeEvent {}
  /**
   * Interface version 2. An admin is about to save the plugin's settings: `values` is what would be saved, checked against
   * the manifest's fields already. Sent only while the plugin runs, and the admin waits for the answer, so be quick.
   * Return nothing to let it pass; `fieldErrors` to refuse fields with a sentence each (nothing is saved then); `values`
   * to save some fields in another form, for example a typed name as the name and number it stands for. Values handed back
   * are checked like the admin's; a role, channel or member field cannot be changed this way.
   */
  interface SettingsCheckEvent { values: Record<string, unknown>; by: string }
  interface SettingsCheckResult { fieldErrors?: Record<string, Text>; values?: Record<string, unknown> }

  /** Needs `members.read`. A new membership (not a sign-in of somebody who was a member already). */
  interface MemberJoinEvent { userId: string }
  /** Needs `members.read`. */
  interface MemberLeaveEvent { userId: string; reason: "kicked" | "banned" | "deleted" }
  /**
   * Needs `members.read`. A member's roles changed. Never sent for a change this plugin made itself.
   * `origin`: a person (`by` = who), a reaction role (`by` = the member), another plugin, or the server.
   */
  interface MemberRolesEvent { userId: string; added: string[]; removed: string[]; origin: "user" | "reaction" | "plugin" | "system"; by?: string }
  /** Needs `members.read` or `roles.manage`. Members who had the role get no `member.roles` each. */
  interface RoleDeleteEvent { roleId: string; name: string }

  /**
   * Needs `messages.read`, and only for channels of the plugin's scope. `message.update` means the text changed. Never
   * sent for the plugin's own messages.
   */
  interface MessageEvent { message: Message }
  interface MessageDeleteEvent { channelId: string; messageIds: string[] }

  /**
   * A member ran one of the manifest's `commands`. The server has checked the command's `permission` in that channel and,
   * for `input: "form"`, the `values` against the fields. `text` is the rest of the line for `input: "text"`, else "".
   * While this event is handled the plugin may `messages.send` into `channelId` even when it is not in its scope (if the
   * caller may write there); such a message is marked with the caller and the command.
   */
  interface CommandEvent { command: string; channelId: string; by: string; text: string; values: Record<string, unknown> }
  /**
   * A member ran one of the manifest's `memberActions` on the member `userId`. The server has checked the action's
   * `permission`, its `target` rule and the `values`: a role in them lies in the plugin's scope and is one the caller could
   * assign to that member by hand.
   */
  interface MemberActionEvent { action: string; userId: string; by: string; values: Record<string, unknown> }
  /** What a `command` or `memberAction` handler returns; `message` is shown to the caller only. A bare string is a message. */
  interface ActionResult { ok?: boolean; message?: Text; fieldErrors?: Record<string, Text> }

  /** Verwaltung > Plugins asks for the rows of one of the manifest's `views`. */
  interface ViewEvent { view: string }
  /** Rows as objects keyed by the view's column keys (at most 500 are shown). Ids for `member`, `role`, `channel` columns; milliseconds or an ISO string for `time`; seconds for `duration`. */
  type ViewResult = Record<string, unknown>[] | { rows: Record<string, unknown>[] };

  /**
   * A job scheduled with `schedule.at` is due. Delivered at least once: after a restart at the wrong moment a job comes a
   * second time, and a handler that fails gets it again after 2 minutes, 10 minutes and an hour (`attempt` counts from 1).
   * `late` = more than a minute after its time (the server was down, or the plugin was switched off).
   */
  interface JobEvent { name: string; key: string | null; payload: unknown; dueAt: string; late: boolean; attempt: number }

  /** Every event: what its handler gets and what it may return. */
  interface Events {
    "enable": [EnableEvent, void];
    "disable": [DisableEvent, void];
    "settings.check": [SettingsCheckEvent, SettingsCheckResult | void];
    "settings.change": [SettingsChangeEvent, void];
    "member.join": [MemberJoinEvent, void];
    "member.leave": [MemberLeaveEvent, void];
    "member.roles": [MemberRolesEvent, void];
    "role.delete": [RoleDeleteEvent, void];
    "message.create": [MessageEvent, void];
    "message.update": [MessageEvent, void];
    "message.delete": [MessageDeleteEvent, void];
    "command": [CommandEvent, ActionResult | string | void];
    "memberAction": [MemberActionEvent, ActionResult | string | void];
    "view": [ViewEvent, ViewResult];
    "job": [JobEvent, void];
  }
  type EventName = keyof Events;

  // ---------- squorli ----------

  interface Roles {
    /** Every role of the server, most powerful first. Needs `members.read` or `roles.manage`. */
    list(): Promise<Role[]>;
    /** Give a role of the scope to a member. Resolves to whether anything changed. Needs `roles.manage`. */
    give(userId: string, roleId: string): Promise<boolean>;
    /** Take a role of the scope from a member; false when they did not have it or are no member any more. Needs `roles.manage`. */
    take(userId: string, roleId: string): Promise<boolean>;
  }

  interface Members {
    /** A page of the member list in the order of joining (at most 100 per call). Needs `members.read`. */
    list(options?: { offset?: number; limit?: number }): Promise<{ total: number; members: Member[] }>;
    /** One member, or null when the id is no member. Needs `members.read`. */
    get(userId: string): Promise<Member | null>;
  }

  interface Channels {
    /** The channels of the plugin's scope. Needs `messages.read` or `messages.write`. */
    list(): Promise<Channel[]>;
  }

  /**
   * A card: a message drawn as a framed box (interface version 2). It needs a `title` or a `text`; everything else is
   * optional. The app draws it with its own components, a plugin chooses no colours and no layout.
   */
  interface Card {
    /** A small line above the title, at most 80 characters: what the card is about (a game's name, a source). */
    kicker?: string;
    /** One line, at most 200 characters. A link when `url` is given. */
    title?: string;
    /** Where the title leads: an https address of at most 500 characters. */
    url?: string;
    /** At most 2000 characters, Markdown as in a message (headings, lists, quotes, bold). */
    text?: string;
    /**
     * A large picture below the text and a small one in the corner: https addresses of pictures (PNG, JPEG, WebP, GIF, up
     * to 2 MB). The server fetches them itself and serves its own copies, so nobody's app asks a foreign host; they appear
     * a moment after the message. Only for a plugin that holds `net.fetch`, and only while the server makes link previews;
     * otherwise, or when an address is no picture, the card is shown without it.
     */
    image?: string;
    thumbnail?: string;
  }

  interface Messages {
    /** Messages of a channel of the scope, oldest first; `before` = a `seq` to page backwards. At most 50. Needs `messages.read`. */
    history(channelId: string, options?: { before?: number; limit?: number }): Promise<{ messages: Message[]; hasMore: boolean }>;
    /**
     * Write a message (1 to 4000 characters, Markdown as members write it, no files). Needs `messages.write`. Links get a
     * preview only in the messages of a plugin that holds `net.fetch`.
     *
     * With `options.card` (interface version 2) the message is drawn as a card; `content` is then what an app from before
     * cards shows and what notifications quote, so write it as a message that stands on its own.
     */
    send(channelId: string, content: string, options?: { card?: Card }): Promise<{ id: string; seq: number }>;
    /** Change the text of one of the plugin's own messages (a card it carries stays as it is). Needs `messages.write`. */
    edit(messageId: string, content: string): Promise<boolean>;
    /** Delete one of the plugin's own messages. Needs `messages.write`. */
    delete(messageId: string): Promise<boolean>;
  }

  /** The plugin's own storage: JSON values under keys of up to 128 characters, 5 MB and 10,000 keys in all. */
  interface Storage {
    /** The value, or null when the key does not exist. */
    get(key: string): Promise<unknown>;
    /** Store a value (anything JSON can hold except null; at most 64 KB). */
    set(key: string, value: unknown): Promise<boolean>;
    /** Resolves to whether the key existed. */
    delete(key: string): Promise<boolean>;
    /** The keys that start with `prefix` (all without one), sorted, at most 1000. */
    list(prefix?: string): Promise<string[]>;
  }

  interface Schedule {
    /**
     * Ask for a `job` event at a time (a Date, milliseconds or an ISO string; a time in the past is "now"). `payload` comes
     * back with the event (at most 4 KB). A `key` names the job: scheduling the same key again replaces it, and
     * `cancel(key)` removes it. At most 1000 jobs wait at a time, at most five years ahead.
     */
    at(when: Date | number | string, name: string, payload?: unknown, options?: { key?: string }): Promise<{ id: string; dueAt: string }>;
    /** Resolves to whether a job with that key waited. */
    cancel(key: string): Promise<boolean>;
    /** The waiting jobs, the next one first (at most 500). */
    list(): Promise<Job[]>;
  }

  interface Settings {
    /**
     * The values an admin saved, by the keys of the manifest's `settings`. A field nobody filled is absent, except that an
     * empty `boolean` is false and an empty `roles` or `channels` field is an empty list. Before anybody saved: `{}`.
     */
    get(): Promise<Record<string, unknown>>;
  }

  /** What `net.get` answers: the address the answer came from (after redirects), its content type and its text. */
  interface NetResponse {
    url: string;
    /** As the host sent it, in lower case, e.g. "application/json; charset=utf-8". */
    contentType: string;
    /** The body read as UTF-8. Parse it yourself: `JSON.parse(text)`. */
    text: string;
  }

  /**
   * The network (interface version 2). Needs the capability `net.fetch`, which the server takes only from a plugin file that
   * carries Squorli's signature: plugins are submitted for it at https://github.com/danielklessa/squorli-plugins. The
   * manifest names the hosts under `"network": { "hosts": ["api.example.org"] }`; the owner reads that list before
   * switching the plugin on, and a request to any other host is refused.
   */
  interface Net {
    /**
     * One GET over https to a host of the manifest. No headers of your own, no body, no cookies: the address is all a
     * plugin can send. Resolves with the answer when the host said 200 with text, JSON or XML of at most 512 KB within
     * 5 seconds; rejects otherwise (also for a redirect that leaves the manifest's hosts), so catch it: a source that is
     * down must not fail the handler. At most 30 requests a minute, and mind the 10 seconds one event has in all.
     */
    get(url: string): Promise<NetResponse>;
  }

  /** Lines in the plugin's log (Verwaltung > Plugins, `squorli plugin log`). `console.log` and friends write here too. */
  interface Log {
    info(...parts: unknown[]): void;
    warn(...parts: unknown[]): void;
    error(...parts: unknown[]): void;
  }

  interface Api {
    /** The interface version the plugin runs under: the `apiVersion` its manifest names. */
    readonly apiVersion: number;
    /** Listen to an event. One handler per event; a second `on` for the same event replaces the first. */
    on<K extends EventName>(name: K, handler: (event: Events[K][0]) => Events[K][1] | Promise<Events[K][1]>): void;
    readonly roles: Roles;
    readonly members: Members;
    readonly channels: Channels;
    readonly messages: Messages;
    readonly storage: Storage;
    readonly schedule: Schedule;
    readonly settings: Settings;
    readonly net: Net;
    readonly log: Log;
  }
}

/** The one global of a plugin. */
declare const squorli: Squorli.Api;
