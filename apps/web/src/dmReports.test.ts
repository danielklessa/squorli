import { describe, expect, it } from "vitest";
import { DM_REPORT_CONTEXT_MAX } from "@squorli/protocol";
import { dmReportContent } from "./dmReports";
import type { Dm } from "./store";

const A = "a".repeat(64), B = "b".repeat(64);
const dm = (n: number, from: string, text: string | null = `m${n}`, control?: Dm["control"]): Dm =>
  ({ id: `6f1c2a4e-1b2c-4d3e-8f90-${String(n).padStart(12, "0")}`, seq: n, from, to: from === A ? B : A, sentAt: `2026-09-26T10:${String(n).padStart(2, "0")}:00.000Z`, text, ...(control ? { control } : {}) });

describe("dmReportContent", () => {
  it("takes the reported message and the readable messages before it, oldest first, both sides", () => {
    const list = [dm(1, A), dm(2, B), dm(3, A, null), dm(4, B, "", { type: "preview.remove", id: dm(2, B).id, url: "https://x" }), dm(5, B), dm(6, A)];
    const r = dmReportContent(list, dm(5, B).id);
    expect(r?.message).toEqual({ id: dm(5, B).id, from: B, sentAt: dm(5, B).sentAt, text: "m5" });
    expect(r?.context.map((m) => m.text)).toEqual(["m1", "m2"]);
    expect(Object.keys(r!.context[0]!).sort()).toEqual(["from", "id", "sentAt", "text"]);
  });
  it("caps the context at the limit and can leave it out", () => {
    const list = Array.from({ length: 30 }, (_, i) => dm(i + 1, i % 2 ? A : B));
    expect(dmReportContent(list, dm(30, B).id)?.context.map((m) => m.text)).toEqual(list.slice(9, 29).map((m) => m.text));
    expect(dmReportContent(list, dm(30, B).id, 0)?.context).toEqual([]);
  });
  it("refuses what is not a readable message", () => {
    expect(dmReportContent([dm(1, A), dm(2, B, null)], dm(2, B).id)).toBeNull();
    expect(dmReportContent([dm(1, A)], "6f1c2a4e-1b2c-4d3e-8f90-999999999999")).toBeNull();
    expect(dmReportContent([dm(1, B, "", { type: "preview.remove", id: "x", url: "y" })], dm(1, B).id)).toBeNull();
  });
  it("carries iv and ciphertext only when the directory can check them, and only for messages that have them", () => {
    const proof = { iv: "ab".repeat(12), ciphertext: "QUJD" };
    const list = [{ ...dm(1, A), ...proof }, dm(2, B), { ...dm(3, B), ...proof }];
    const plain = dmReportContent(list, dm(3, B).id);
    expect(Object.keys(plain!.message).sort()).toEqual(["from", "id", "sentAt", "text"]);
    const withProof = dmReportContent(list, dm(3, B).id, DM_REPORT_CONTEXT_MAX, true);
    expect(withProof?.message).toEqual({ id: dm(3, B).id, from: B, sentAt: dm(3, B).sentAt, text: "m3", ...proof });
    expect(withProof?.context.map((m) => m.iv ?? null)).toEqual([proof.iv, null]);
  });
});
