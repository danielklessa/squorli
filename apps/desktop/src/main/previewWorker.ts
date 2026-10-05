/**
 * The worker thread that reads the heads of linked pages for the previews of direct messages (linkLookup.ts,
 * docs/features/link-previews.md, security audit of 5 October 2026, H-1). Its own CommonJS bundle (tsup entry
 * `preview-worker`, `out/preview-worker.cjs`), started by `createHeadParser` with the path next to the main bundle.
 * Everything it does is the shared package's.
 */
import { runHeadParserWorker } from "@squorli/link-preview/worker";

runHeadParserWorker();
