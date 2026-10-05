/**
 * The worker thread that reads the heads of linked pages for the link previews (docs/features/link-previews.md, security
 * audit of 5 October 2026, H-1). Its own bundle (tsup entry `preview-worker`), started by `createHeadParser` in index.ts
 * with the path next to the main bundle: `dist/preview-worker.js` in the build, `src/preview-worker.ts` under `tsx` in
 * development. Everything it does is the shared package's.
 */
import { runHeadParserWorker } from "@squorli/link-preview/worker";

runHeadParserWorker();
