# Squorli plugin interface

What a plugin for Squorli Server can see and call, as a TypeScript declaration: [`index.d.ts`](index.d.ts).

A plugin is one JavaScript or TypeScript file that the server runs in a sandbox. The guide, with a first plugin in five
minutes, the manifest, every event and function, and the limits:

- English: <https://squorli.com/en/docs/plugins/>
- German: <https://squorli.com/de/docs/plugins/>

Examples to read and copy:

- [`examples/plugins/hello/hello.js`](../../examples/plugins/hello/hello.js): two slash commands and a welcome message,
  in plain JavaScript.
- [`apps/server/plugins/timed-roles.ts`](../../apps/server/plugins/timed-roles.ts): the plugin that ships with the server,
  in TypeScript. A settings field that sets the plugin's scope, a dialog on a member, a schedule that survives a restart,
  storage, and a table in the admin area.
- [`apps/server/plugins/birthdays.ts`](../../apps/server/plugins/birthdays.ts): the second one that ships. A slash command
  with a form, a command whose answer only the caller sees, a job that comes back every day, and how a plugin works out
  the local day without time zones in the sandbox.
- [`apps/server/plugins/game-news.ts`](../../apps/server/plugins/game-news.ts): the third one, and the one that fetches
  from the internet (interface version 2, `squorli.net.get`). The hosts in its manifest, one request per event, a round
  that goes on when a source fails, and how text from outside is made harmless before it is posted.

## The network needs Squorli's signature

`squorli.net.get` and the capability `net.fetch` are taken only from a plugin file that carries Squorli's signature as
its last line. Submit a plugin for it at <https://github.com/danielklessa/squorli-plugins> (a pull request with the file
and a README that says what each host is for); that repository's `REVIEW.md` lists what is looked at. Before you do, run
the check the server itself uses, from a clone of this repository:

```
pnpm install
pnpm --filter @squorli/server plugin:check path/to/my-plugin.ts
```

It reads the manifest, removes the types, compiles the file in the sandbox without running it and prints what the
server would store, or why it would refuse the file.

## Writing a plugin in TypeScript

Copy `index.d.ts` next to your plugin and name both in a `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "types": [],
    "strict": true,
    "erasableSyntaxOnly": true,
    "noEmit": true
  },
  "files": ["index.d.ts", "my-plugin.ts"]
}
```

`squorli` and the namespace `Squorli` are global then; nothing is imported. `tsc` checks your types. The server does not:
when it installs a `.ts` file it only removes the types, and it takes only what can be removed without rewriting code
(`erasableSyntaxOnly` reports the rest: `enum`, `namespace` with values, parameter properties). A plugin that needs those,
or code from npm, is bundled into one `.js` file first.

## For maintainers

- `check.ts` and `tsconfig.json` hold the declaration against the server: its functions are exactly the host functions
  (`apps/server/src/plugins/prelude.ts`), its events exactly the ones a plugin can listen to, and the shipped plugin
  typechecks against it. They run with the server's `pnpm typecheck`.
- `reference.json` lists capabilities, events, functions, field types and limits as the server has them. The server's
  tests fail when it is stale (`UPDATE_PLUGIN_REFERENCE=1 pnpm --filter @squorli/server test` rewrites it); the website's
  guide is checked against a copy of it.
- This folder has no `package.json` on purpose: it is no workspace package and nothing imports it.
- `tools/plugin-sign.mjs` writes signatures and `apps/server/src/plugins/signature.ts` reads them; the key's public half
  is `tools/squorli-plugins.pub` and the newest entry of `signingKeys.ts`. Signing happens only in the workflow of the
  repository squorli-plugins (`docs/features/plugins.md`, `docs/features/release-signing.md`).
