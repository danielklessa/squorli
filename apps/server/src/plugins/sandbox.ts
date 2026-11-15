import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { stripTypeScriptTypes } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten-core";
import { preludeSource } from "./prelude";
import { MAX_JSON_CHARS, type FailureKind, type FromWorker, type ToWorker, type WorkerStart } from "./wire";

/**
 * The inside of a plugin's worker thread (docs/features/plugins.md): one QuickJS engine compiled to WebAssembly, with a
 * memory of its own, running one plugin. The plugin's code sees the language and the object `squorli` (prelude.ts) and
 * nothing else: no `process`, no `require`, no `fetch`, no timers, and `import` of anything fails. Its only way out is
 * `__host(fn, json)`, which posts a message to the main thread and gets an answer later; what that may do is decided
 * there (host.ts).
 *
 * Three walls, measured on 15 November 2026 (the spike in the feature note):
 * - **Memory:** the WebAssembly memory has a `maximum`. QuickJS's own `setMemoryLimit` stops strings and arrays, but typed
 *   arrays went past it to 2 GB, so it is only the first line.
 * - **CPU:** the interrupt handler ends ordinary loops at the budget. Native functions (JSON, `join`, a recursion that
 *   catches its own stack overflow) never ask it, so the main thread watches the clock this worker writes into shared
 *   memory and terminates the worker when an entry into the engine lasts too long (runner.ts).
 * - **Stack:** a fixed size, a deep recursion is an ordinary error.
 */

const STACK_BYTES = 512 * 1024;
/** WebAssembly pages are 64 KiB; the engine itself needs 16 MB to start and a little room besides the plugin's own heap. */
const PAGES_PER_MB = 16;
const MIN_MB = 16;
const HEADROOM_MB = 8;

function describe(vm: QuickJSContext, handle: QuickJSHandle): string {
  let text: string;
  try {
    const e = vm.dump(handle) as unknown;
    if (e && typeof e === "object" && "message" in e) {
      const err = e as { name?: unknown; message?: unknown; stack?: unknown };
      text = `${typeof err.name === "string" ? err.name : "Error"}: ${String(err.message)}${typeof err.stack === "string" && err.stack ? `\n${err.stack.trimEnd()}` : ""}`;
    } else text = typeof e === "string" ? e : JSON.stringify(e) ?? String(e);
  } catch (err) { text = `an error that could not be read (${String(err)})`; }
  return text.length > 2000 ? `${text.slice(0, 2000)} …` : text;
}

function kindOf(message: string, interrupted: boolean): FailureKind {
  if (interrupted || /InternalError: interrupted/.test(message)) return "cpu";
  if (/out of memory/i.test(message)) return "memory";
  return "error";
}

async function newEngine(memoryMb: number): Promise<{ rt: QuickJSRuntime; vm: QuickJSContext }> {
  const mb = Math.max(MIN_MB, memoryMb);
  const wasmMemory = new WebAssembly.Memory({ initial: MIN_MB * PAGES_PER_MB, maximum: (mb + HEADROOM_MB) * PAGES_PER_MB });
  const QuickJS = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory }));
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(mb * 1024 * 1024);
  rt.setMaxStackSize(STACK_BYTES);
  return { rt, vm: rt.newContext() };
}

/**
 * Read one plugin file without running it: a TypeScript file loses its types (Node's own type stripping, which keeps every
 * line and column, so an error's position points into the source), then the engine compiles the result. Whatever does not
 * compile is refused here with the parser's message, before the file is stored.
 */
async function prepare(start: Extract<WorkerStart, { mode: "prepare" }>, post: (m: FromWorker) => void): Promise<void> {
  let code = start.source;
  if (start.language === "ts") {
    // `stripTypeScriptTypes` is marked experimental in Node 26 and says so on stderr once per thread; this thread ends right after.
    process.removeAllListeners("warning");
    try { code = stripTypeScriptTypes(start.source, { mode: "strip" }); }
    catch (err) {
      const e = err as { code?: string; message?: string };
      const hint = e.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" ? " (the server only removes types: enum, namespace and parameter properties need a bundler, see the plugin guide)" : "";
      return post({ t: "prepared", ok: false, message: `TypeScript: ${String(e.message ?? err).split("\n")[0]}${hint}` });
    }
  }
  const { rt, vm } = await newEngine(start.memoryMb);
  const until = performance.now() + 1000;
  rt.setInterruptHandler(() => performance.now() > until);
  const r = vm.evalCode(code, start.language === "ts" ? "plugin.ts" : "plugin.js", { compileOnly: true });
  if (r.error) { const message = describe(vm, r.error); r.error.dispose(); return post({ t: "prepared", ok: false, message }); }
  r.value.dispose();
  post({ t: "prepared", ok: true, code });
}

async function run(start: Extract<WorkerStart, { mode: "run" }>, post: (m: FromWorker) => void, onMessage: (fn: (m: ToWorker) => void) => void): Promise<void> {
  const { rt, vm } = await newEngine(start.memoryMb);
  const clock = new BigInt64Array(start.clock);
  let deadline = 0;
  let interrupted = false;
  /** CPU time of the event being handled, summed over every entry into the engine. */
  let spent = 0;
  let current: { id: number } | null = null;
  let callSeq = 0;
  const pending = new Map<number, QuickJSDeferredPromise>();
  rt.setInterruptHandler(() => {
    if (performance.now() <= deadline) return false;
    interrupted = true;
    return true;
  });

  /** Every step into the engine goes through here: the budget that is left, and the clock the main thread watches. */
  function enter(fn: () => void): void {
    const t0 = performance.now();
    deadline = t0 + Math.max(1, start.cpuMs - spent);
    Atomics.store(clock, 0, BigInt(Date.now()));
    try { fn(); } finally {
      spent += performance.now() - t0;
      Atomics.store(clock, 0, 0n);
    }
  }
  /** Promise reactions waiting in the engine. A flood of them ends at the budget like any loop. */
  function drain(): string | null {
    const r = rt.executePendingJobs();
    if ("error" in r && r.error) { const message = describe(vm, r.error); r.error.dispose(); return message; }
    return null;
  }

  const host = vm.newFunction("__host", (fnHandle, argsHandle) => {
    const d = vm.newPromise();
    const refuse = (message: string) => { const e = vm.newError(message); d.reject(e); e.dispose(); return d.handle; };
    let fn: string, args: string;
    try { fn = vm.getString(fnHandle); args = vm.getString(argsHandle); } catch { return refuse("squorli: a host call takes a name and JSON"); }
    if (!current) return refuse("squorli: host functions answer only while an event is being handled; await them inside the handler");
    if (args.length > MAX_JSON_CHARS) return refuse(`squorli: the argument of ${fn} is larger than ${MAX_JSON_CHARS / 1024} KB`);
    const callId = ++callSeq;
    pending.set(callId, d);
    post({ t: "call", invocation: current.id, callId, fn, args });
    return d.handle;
  });
  vm.setProp(vm.global, "__host", host);
  host.dispose();

  // The interface, then the plugin itself. Whatever it does at the top level counts against one event's budget.
  let loadError: string | null = null;
  enter(() => {
    const p = vm.evalCode(preludeSource(start.apiVersion), "squorli.js");
    if (p.error) { loadError = describe(vm, p.error); p.error.dispose(); return; }
    p.value.dispose();
    const r = vm.evalCode(start.code, `${start.pluginId}.js`);
    if (r.error) { loadError = describe(vm, r.error); r.error.dispose(); return; }
    r.value.dispose();
    loadError = drain();
  });
  if (loadError !== null || interrupted) {
    post({ t: "loadError", kind: interrupted ? "cpu" : kindOf(loadError ?? "", false), message: interrupted ? `the plugin's start took more than ${start.cpuMs} ms of CPU time` : loadError! });
    return;
  }
  let handlers: string[] = [];
  enter(() => {
    const fn = vm.getProp(vm.global, "__handlers");
    const r = vm.callFunction(fn, vm.undefined);
    fn.dispose();
    if (r.error) r.error.dispose(); else { try { handlers = JSON.parse(vm.getString(r.value)) as string[]; } catch { /* none */ } r.value.dispose(); }
  });
  post({ t: "ready", handlers });

  function finish(id: number, result: { ok: true; handled: boolean; value: string } | { ok: false; kind: FailureKind; message: string }): void {
    if (current?.id !== id) return;
    current = null;
    // Host calls the handler left open get an answer nobody waits for any more; without one their promises would stay for good.
    if (pending.size) {
      const open = [...pending.values()];
      pending.clear();
      enter(() => { for (const d of open) { const e = vm.newError("squorli: the event ended before this call was answered"); d.reject(e); e.dispose(); } drain(); });
    }
    post({ t: "done", id, ...result });
  }
  /** After a step into the engine: did it run out of budget, did a reaction throw out of the engine? */
  function settle(id: number, jobError: string | null): void {
    if (interrupted) finish(id, { ok: false, kind: "cpu", message: `used more than ${start.cpuMs} ms of CPU time` });
    else if (jobError !== null) finish(id, { ok: false, kind: kindOf(jobError, false), message: jobError });
  }

  onMessage((m) => {
    if (m.t === "invoke") {
      current = { id: m.id };
      spent = 0;
      interrupted = false;
      let jobError: string | null = null;
      let outcome: Promise<void> | null = null;
      enter(() => {
        const fn = vm.getProp(vm.global, "__dispatch");
        const name = vm.newString(m.event), payload = vm.newString(m.payload);
        const r = vm.callFunction(fn, vm.undefined, name, payload);
        fn.dispose(); name.dispose(); payload.dispose();
        if (r.error) { jobError = describe(vm, r.error); r.error.dispose(); return; }
        if (vm.typeof(r.value) === "undefined") { r.value.dispose(); finish(m.id, { ok: true, handled: false, value: "" }); return; }
        outcome = vm.resolvePromise(r.value).then((res) => {
          if (res.error) { const message = describe(vm, res.error); res.error.dispose(); finish(m.id, { ok: false, kind: kindOf(message, interrupted), message }); return; }
          let value = "";
          try { value = vm.getString(res.value); } catch { /* not a string: nothing */ }
          res.value.dispose();
          if (value.length > MAX_JSON_CHARS) finish(m.id, { ok: false, kind: "error", message: `the handler returned more than ${MAX_JSON_CHARS / 1024} KB` });
          else finish(m.id, { ok: true, handled: true, value });
        });
        r.value.dispose();
        jobError = drain();
      });
      void outcome;
      settle(m.id, jobError);
      return;
    }
    const d = pending.get(m.callId);
    if (!d) return;
    pending.delete(m.callId);
    const id = current?.id;
    let jobError: string | null = null;
    enter(() => {
      if (m.ok) { const v = vm.newString(m.value); d.resolve(v); v.dispose(); }
      else { const e = vm.newError(m.error); d.reject(e); e.dispose(); }
      jobError = drain();
    });
    if (id !== undefined) settle(id, jobError);
  });
}

/** The worker's entry (src/plugin-worker.ts). */
export function runPluginWorker(): void {
  const port = parentPort;
  if (!port) throw new Error("plugin worker: started without a parent");
  const start = workerData as WorkerStart;
  const post = (m: FromWorker) => port.postMessage(m);
  if (start.mode === "prepare") {
    void prepare(start, post).catch((err) => post({ t: "prepared", ok: false, message: String(err) }));
    return;
  }
  void run(start, post, (fn) => port.on("message", fn)).catch((err) => post({ t: "loadError", kind: "crash", message: String(err) }));
}
