/**
 * Holds `index.d.ts` against the server (docs/features/plugins.md): the functions the declaration names are exactly the host
 * functions the server answers, and its events exactly the ones a plugin can listen to. Checked by `pnpm typecheck` of the
 * server (its second `tsc` run, over this folder's tsconfig), together with the plugin that ships with the server: a
 * function added on one side only, or an event renamed, fails the typecheck. Nothing here runs.
 */
import type { HostFunction, PluginEventName } from "../../apps/server/src/plugins/prelude";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type Group = "roles" | "members" | "channels" | "messages" | "storage" | "schedule" | "settings";
/** `roles.give`, `storage.get`, ...; the three log functions are one host call named `log`. */
type Declared = { [G in Group]: `${G}.${keyof Squorli.Api[G] & string}` }[Group] | "log";

export type Checks = [
  Expect<Equal<Declared, HostFunction>>,
  Expect<Equal<Squorli.EventName, PluginEventName>>,
  Expect<Equal<keyof Squorli.Api, "apiVersion" | "on" | "log" | Group>>,
];
