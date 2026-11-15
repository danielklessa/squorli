/**
 * The worker thread one plugin runs in (docs/features/plugins.md). Its own bundle (tsup entry `plugin-worker`), started by
 * `PluginRunner` with the path next to the main bundle: `dist/plugin-worker.js` in the build, `src/plugin-worker.ts` under
 * `tsx` in development. Everything it does is in plugins/sandbox.ts.
 */
import { runPluginWorker } from "./plugins/sandbox";

runPluginWorker();
