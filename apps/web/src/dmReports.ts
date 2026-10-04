import { DM_REPORT_CONTEXT_MAX, type DmReportMessage } from "@squorli/protocol";
import type { Dm } from "./store";

/**
 * A report of a direct message (docs/features/reports.md, stage 4): the directory cannot read the conversation, so the
 * reporter's client sends the plain text of the reported message and, unless the reporter unticks it, the messages before
 * it as context (the user's decision 6 of 25 September 2026: up to 20, opt-out). Only what is readable here goes: a message
 * that could not be decrypted, and an instruction such as a removed preview, is no message. With `withProof` (the directory's
 * `features.reportProof`, security audit D10, 4 October 2026) each message also carries the iv and ciphertext the directory
 * delivered, so the directory can check that it stored exactly this message from that sender; the text stays the reporter's word.
 */
export function dmReportContent(list: readonly Dm[], messageId: string, contextMax = DM_REPORT_CONTEXT_MAX, withProof = false): { message: DmReportMessage; context: DmReportMessage[] } | null {
  const at = list.findIndex((m) => m.id === messageId);
  const target = at >= 0 ? list[at] : undefined;
  if (!target || target.text === null || target.control) return null;
  const readable = list.slice(0, at).filter((m) => m.text !== null && !m.control);
  const context = readable.slice(Math.max(0, readable.length - contextMax)).map((m) => pick(m, withProof));
  return { message: pick(target, withProof), context };
}

const pick = (m: Dm, withProof: boolean): DmReportMessage => ({
  id: m.id, from: m.from, sentAt: m.sentAt, text: m.text ?? "",
  ...(withProof && m.iv && m.ciphertext ? { iv: m.iv, ciphertext: m.ciphertext } : {}),
});
