import { parentPort } from "node:worker_threads";
import { parseHead, type HeadParserJob, type HeadParserReply } from "./headParser";

/**
 * The worker's side of `createHeadParser` (headParser.ts): says `ready` once it listens, then reads the pages the main
 * thread sends, one after the other, and answers with what they say about themselves. A consumer's worker entry file is
 * only `runHeadParserWorker()`; it is bundled by the consumer and named to `createHeadParser` as `workerFile`. Nothing here
 * touches the network or the disk.
 */
export function runHeadParserWorker(): void {
  const port = parentPort;
  if (!port) throw new Error("runHeadParserWorker: not inside a worker thread");
  const send = (reply: HeadParserReply) => port.postMessage(reply);
  port.on("message", (job: HeadParserJob) => {
    try {
      send({ id: job.id, meta: parseHead(Buffer.from(job.bytes), job.contentType, job.baseUrl) });
    } catch (err) {
      send({ id: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  });
  send({ ready: true });
}
