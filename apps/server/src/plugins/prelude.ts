/**
 * The JavaScript that runs inside a plugin's sandbox before the plugin itself: it builds the object `squorli` of interface
 * version 1 over the one native function the host installs (`__host(fn, json)`, a promise). Every function here is a thin
 * name over a host call; what a plugin may do is decided on the main thread (host.ts), never here, since a plugin can call
 * `__host` itself.
 *
 * `HOST_FUNCTIONS` names every host call the prelude makes; a test holds it against the host's registry and against
 * `packages/plugin-api/index.d.ts`, so the three cannot drift apart.
 */
export const HOST_FUNCTIONS = [
  "roles.list", "roles.give", "roles.take",
  "members.list", "members.get",
  "channels.list",
  "messages.history", "messages.send", "messages.edit", "messages.delete",
  "storage.get", "storage.set", "storage.delete", "storage.list",
  "schedule.at", "schedule.cancel", "schedule.list",
  "settings.get",
  "net.get",
  "log",
] as const;
export type HostFunction = (typeof HOST_FUNCTIONS)[number];

/** The events a plugin can listen to with `squorli.on`. */
export const PLUGIN_EVENTS = [
  "enable", "disable", "settings.change",
  "member.join", "member.leave", "member.roles", "role.delete",
  "message.create", "message.update", "message.delete",
  "command", "memberAction", "view", "job",
] as const;
export type PluginEventName = (typeof PLUGIN_EVENTS)[number];

export function preludeSource(apiVersion: number): string {
  return `(function () {
  "use strict";
  var host = globalThis.__host;
  var handlers = Object.create(null);
  var known = ${JSON.stringify(PLUGIN_EVENTS)};
  function call(fn, args) {
    return host(fn, JSON.stringify(args === undefined ? null : args)).then(function (text) { return text === "" ? undefined : JSON.parse(text); });
  }
  function line(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (typeof p === "string") out.push(p);
      else if (p instanceof Error) out.push(String(p.stack || p));
      else { try { out.push(JSON.stringify(p)); } catch (e) { out.push(String(p)); } }
    }
    return out.join(" ");
  }
  function logger(level) {
    return function () { call("log", { level: level, text: line(arguments) }).catch(function () {}); };
  }
  function time(when) {
    if (when instanceof Date) return when.getTime();
    if (typeof when === "number") return when;
    if (typeof when === "string") return Date.parse(when);
    throw new TypeError("schedule.at: the time is a Date, a number of milliseconds or an ISO string");
  }
  var log = Object.freeze({ info: logger("info"), warn: logger("warn"), error: logger("error") });
  var api = {
    apiVersion: ${apiVersion},
    on: function (name, handler) {
      if (typeof name !== "string" || typeof handler !== "function") throw new TypeError("squorli.on(name, handler)");
      if (known.indexOf(name) < 0) log.warn("squorli.on: this server knows no event \\"" + name + "\\"");
      handlers[name] = handler;
    },
    roles: Object.freeze({
      list: function () { return call("roles.list"); },
      give: function (userId, roleId) { return call("roles.give", { userId: userId, roleId: roleId }); },
      take: function (userId, roleId) { return call("roles.take", { userId: userId, roleId: roleId }); }
    }),
    members: Object.freeze({
      list: function (options) { return call("members.list", { offset: options && options.offset, limit: options && options.limit }); },
      get: function (userId) { return call("members.get", { userId: userId }); }
    }),
    channels: Object.freeze({ list: function () { return call("channels.list"); } }),
    messages: Object.freeze({
      history: function (channelId, options) { return call("messages.history", { channelId: channelId, before: options && options.before, limit: options && options.limit }); },
      send: function (channelId, content) { return call("messages.send", { channelId: channelId, content: content }); },
      edit: function (messageId, content) { return call("messages.edit", { messageId: messageId, content: content }); },
      delete: function (messageId) { return call("messages.delete", { messageId: messageId }); }
    }),
    storage: Object.freeze({
      get: function (key) { return call("storage.get", { key: key }); },
      set: function (key, value) { return call("storage.set", { key: key, value: value }); },
      delete: function (key) { return call("storage.delete", { key: key }); },
      list: function (prefix) { return call("storage.list", { prefix: prefix }); }
    }),
    schedule: Object.freeze({
      at: function (when, name, payload, options) { return call("schedule.at", { when: time(when), name: name, payload: payload, key: options && options.key }); },
      cancel: function (key) { return call("schedule.cancel", { key: key }); },
      list: function () { return call("schedule.list"); }
    }),
    settings: Object.freeze({ get: function () { return call("settings.get"); } }),
    net: Object.freeze({ get: function (url) { return call("net.get", { url: url }); } }),
    log: log
  };
  Object.defineProperty(globalThis, "squorli", { value: Object.freeze(api), writable: false, configurable: false, enumerable: true });
  Object.defineProperty(globalThis, "console", { value: Object.freeze({ log: log.info, info: log.info, debug: log.info, warn: log.warn, error: log.error }), writable: false, configurable: false });
  Object.defineProperty(globalThis, "__handlers", { value: function () { return JSON.stringify(Object.keys(handlers)); }, writable: false, configurable: false });
  Object.defineProperty(globalThis, "__dispatch", { value: function (name, json) {
    var handler = handlers[name];
    if (typeof handler !== "function") return undefined;
    return Promise.resolve(JSON.parse(json)).then(handler).then(function (value) { return value === undefined ? "" : JSON.stringify(value); });
  }, writable: false, configurable: false });
})();`;
}
