/**
 * What the client does when a device is not let in (docs/features/devices.md), the pure part. A device that was signed out
 * loses the account's key on this installation (the user's decision of 29 September 2026), so the question is whose word
 * counts:
 *  - a directory account (`@name`): only the directory's, and only the directory the device was enrolled at. A chat server
 *    that refuses the device may be behind (its list is a copy), mistaken or hostile: the client asks the directory, and
 *    only its refusal wipes. If the directory lets the device in, the client signs in again at that server, once.
 *  - a server account (`~name`): the chat server decides, its refusal removes that server account from this installation.
 * Nothing is ever wiped on an answer that is no refusal: an error, a 404, a directory that cannot be reached.
 */
import { isDeviceRefusal } from "@squorli/protocol";

/** Who refused: the directory, or a chat server (`local` = the account there is that server's own). */
export type RefusalSource = { from: "directory" } | { from: "server"; local: boolean };
export type RefusalStep = "wipe" | "wipe-local" | "ask-directory";

/** The first step after a refusal. */
export function refusalStep(source: RefusalSource): RefusalStep {
  if (source.from === "directory") return "wipe";
  return source.local ? "wipe-local" : "ask-directory";
}

/** What the directory said when it was asked about the device: its answer to a signed request. */
export type DirectoryWord = { kind: "ok" } | { kind: "refused"; code: string } | { kind: "unknown" };
/** Reads an error of a signed request to the directory: a refusal of the device, or something that says nothing about it. */
export function directoryWordOf(err: unknown): DirectoryWord {
  const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : null;
  return isDeviceRefusal(code) ? { kind: "refused", code } : { kind: "unknown" };
}

export type AfterAsking = "wipe" | "sign-in-again" | "say-refused" | "say-unchecked";
/**
 * After the directory was asked because a chat server refused the device. `triedAgain`: the client signed in again at
 * that server already since the refusal and was refused once more; then it says so instead of trying in a circle.
 */
export function afterAsking(word: DirectoryWord, triedAgain: boolean): AfterAsking {
  if (word.kind === "refused") return "wipe";
  if (word.kind === "unknown") return "say-unchecked";
  return triedAgain ? "say-refused" : "sign-in-again";
}

/** Whether a device's entry may be wiped for a refusal that named `refusedKey`: only while it is still the stored device. */
export const stillThatDevice = (storedKey: string | null | undefined, refusedKey: string | null | undefined): boolean => (storedKey ?? null) === (refusedKey ?? null);
