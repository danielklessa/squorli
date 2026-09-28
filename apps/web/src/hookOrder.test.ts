import { describe, expect, it } from "vitest";

/**
 * A component that calls a hook below an early `return` runs that hook in one render and not in the next. React answers
 * with "Rendered more hooks than during the previous render" and, without an error boundary, takes the whole client
 * down: only the window's background is left (RadioControl.tsx, 28 September 2026, docs/features/radio.md). No linter
 * is configured, so this test reads the sources. It knows the repo's style only: components and hooks declared with
 * `function` at the start of a line, their statements indented by two spaces.
 */
function hooksAfterReturn(source: string): string[] {
  const found: string[] = [];
  let name: string | null = null, returned = 0;
  source.split(/\r?\n/).forEach((line, index) => {
    const start = /^(?:export )?(?:default )?function ([A-Z]\w*|use[A-Z]\w*)\(/.exec(line);
    if (start) { name = start[1]!; returned = 0; }
    else if (line.startsWith("}")) name = null;
    else if (name === null) return;
    else if (returned === 0) { if (/^ {2}if \(.*\) return\b/.test(line)) returned = index + 1; }
    else if (/^ {2}\S/.test(line) && /\buse[A-Z]\w*\(/.test(line)) found.push(`${name}, line ${index + 1}: hook below the return of line ${returned}`);
  });
  return found;
}

const sources = import.meta.glob<string>("./**/*.tsx", { query: "?raw", import: "default", eager: true });

describe("order of hooks", () => {
  it("finds a hook below an early return", () => {
    const broken = ["export function Control({ on }: { on: boolean }) {", "  const [a] = useState(0);", "  if (!on) return null;", "  const [b] = useState(false);", "  return <i>{a}{b}</i>;", "}"].join("\n");
    expect(hooksAfterReturn(broken)).toEqual(["Control, line 4: hook below the return of line 3"]);
    const fine = ["function Control({ on }: { on: boolean }) {", "  const [a] = useState(0);", "  const [b] = useState(false);", "  if (!on) return null;", "  return <i>{a}{b}</i>;", "}", "function other() {", "  if (x) return;", "  useThing();", "}"].join("\n");
    expect(hooksAfterReturn(fine)).toEqual([]);
  });

  it("no component of the client calls a hook below an early return", () => {
    const files = Object.entries(sources);
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap(([file, source]) => hooksAfterReturn(source).map((text) => `${file}: ${text}`))).toEqual([]);
  });
});
