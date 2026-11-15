/**
 * What crosses between the server's main thread (runner.ts) and a plugin's worker thread (sandbox.ts). Only plain objects
 * with JSON text inside: the worker holds no reference into the server, and the server parses whatever a plugin hands back.
 */

/** JSON a plugin passes to a host function or returns from a handler, and JSON the host answers with: at most this long. */
export const MAX_JSON_CHARS = 64 * 1024;

/** How a worker is started. `run` keeps one plugin alive; `prepare` reads one file (types off, a look at the syntax) and ends. */
export type WorkerStart =
  | { mode: "run"; pluginId: string; code: string; apiVersion: number; cpuMs: number; memoryMb: number; clock: SharedArrayBuffer }
  | { mode: "prepare"; source: string; language: "js" | "ts"; memoryMb: number };

export type ToWorker =
  /** Hand the plugin an event; `payload` is JSON. One at a time: the next one waits for `done`. */
  | { t: "invoke"; id: number; event: string; payload: string }
  /** The answer to a host call. */
  | { t: "result"; callId: number; ok: true; value: string }
  | { t: "result"; callId: number; ok: false; error: string };

/** Why an event failed. `cpu`, `memory` and `crash` leave a context that is not trusted any more: the runner starts a fresh worker. */
export type FailureKind = "error" | "cpu" | "memory" | "timeout" | "killed" | "crash" | "load";

export type FromWorker =
  | { t: "ready"; handlers: string[] }
  | { t: "loadError"; kind: FailureKind; message: string }
  | { t: "call"; invocation: number; callId: number; fn: string; args: string }
  /** `handled` false = the plugin listens to no such event; `value` = what its handler returned, as JSON ("" = nothing). */
  | { t: "done"; id: number; ok: true; handled: boolean; value: string }
  | { t: "done"; id: number; ok: false; kind: FailureKind; message: string }
  | { t: "prepared"; ok: true; code: string }
  | { t: "prepared"; ok: false; message: string };
