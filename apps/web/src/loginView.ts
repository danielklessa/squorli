export type LoginChoice = "account" | "device";

/**
 * Desktop app's own login (DesktopLogin.tsx): the directory account, or on without one (server accounts only, since
 * 25 September 2026). UI routing only; the servers' account rules remain authoritative.
 */
export function loginView(directory: boolean, hasAccount: boolean, requireAccount: boolean, choice: LoginChoice | null) {
  const accountRequired = directory && requireAccount;
  const deviceAllowed = !accountRequired || hasAccount;
  const mode = !directory ? "device"
    : choice === "device" && !deviceAllowed ? "account"
    : choice ?? (hasAccount ? "device" : "account");
  return { mode, accountRequired, deviceAllowed, showDevice: mode !== "account", showAccount: mode === "account" };
}

// ---------- A server's login (docs/features/local-accounts.md): the prefix decides how to sign in, only creating has tabs.
export type LoginKind = "directory" | "local";
/** The kind a typed prefix asks for (`@` directory, `~` server account); null = no prefix typed. */
export function loginPrefix(value: string): LoginKind | null {
  const s = value.trimStart();
  return s.startsWith("@") ? "directory" : s.startsWith("~") ? "local" : null;
}

/**
 * Why a sign-in of this kind cannot go ahead on this server, or null. Only the directory's can be missing (a server without a
 * directory has no `@name`). **A server account is never refused here, whatever the switch for new server accounts says**
 * (3 October 2026): the switch decides who may REGISTER, the server lets an existing account in either way, and the owner's
 * account may be one (registered with the setup code while server accounts are off), which must always work.
 */
export function signInUnavailable(kind: LoginKind, hasDirectory: boolean): "noDirectoryForAt" | null {
  return kind === "directory" && !hasDirectory ? "noDirectoryForAt" : null;
}

export type CreateTab = "directory" | "local";
/** Tabs of "create an account": the directory's first when the server has one, the server account's where it allows them. */
export function createTabs(directory: boolean, localAccounts: boolean): CreateTab[] {
  return [...(directory ? ["directory" as const] : []), ...(localAccounts || !directory ? ["local" as const] : [])];
}
