import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MentionContext, MessageText } from "./MessageText";
import { t } from "./i18n";

const html = (text: string, edited = false) => renderToStaticMarkup(<MessageText text={text} edited={edited} />);

const copyButton = `<button type="button" class="icon md-copy idle" title="${t("chat.copyCode")}" aria-label="${t("chat.copyCode")}"><i class="ic ic-copy" aria-hidden="true"></i></button>`
  + '<span class="md-copy-status" role="status"></span>';

describe("message text rendering", () => {
  it("renders the blocks as elements", () => {
    expect(html("# Titel\n**fett** und `code`\n\n- a\n  1. b\n\n> zitat\n\n```js\nx < 1\n```\n---")).toBe(
      '<div class="md"><h3 class="md-h1">Titel</h3><p><strong>fett</strong> und <code>code</code></p>'
      + '<ul><li>a<ol start="1"><li>b</li></ol></li></ul><blockquote><p>zitat</p></blockquote>'
      + `<div class="md-code"><pre data-lang="js"><code>x &lt; 1</code></pre>${copyButton}</div><hr/></div>`,
    );
  });
  it("renders a table with its alignment inside a scrolling wrapper", () => {
    expect(html("| a | b |\n|:-:|--:|\n| *1* | 2 |")).toBe(
      '<div class="md"><div class="md-table"><table><thead><tr><th style="text-align:center">a</th><th style="text-align:right">b</th></tr></thead>'
      + '<tbody><tr><td style="text-align:center"><em>1</em></td><td style="text-align:right">2</td></tr></tbody></table></div></div>',
    );
    expect(html("| a |\n|---|")).toBe('<div class="md"><div class="md-table"><table><thead><tr><th>a</th></tr></thead></table></div></div>');
  });
  it("sets emoji in the emoji font, says what was typed and shows emoji-only messages large", () => {
    expect(html("ok :) 🎉")).toBe('<div class="md"><p>ok <span class="emoji" title=":)">🙂</span> <span class="emoji">🎉</span></p></div>');
    expect(html(":tada: 🎉")).toBe('<div class="md md-jumbo"><p><span class="emoji" title=":tada:">🎉</span> <span class="emoji">🎉</span></p></div>');
    expect(html("🎉".repeat(13))).toContain('<div class="md">');
  });
  it("renders task lists, highlight, subscript and superscript", () => {
    expect(html("- [x] ==fertig==\n- [ ] H~2~O^2^")).toBe(
      `<div class="md"><ul><li class="md-task"><input type="checkbox" disabled="" readOnly="" aria-label="${t("chat.taskDone")}" checked=""/><mark>fertig</mark></li>`
      + `<li class="md-task"><input type="checkbox" disabled="" readOnly="" aria-label="${t("chat.taskOpen")}"/>H<sub>2</sub>O<sup>2</sup></li></ul></div>`,
    );
  });
  it("shows mentions with the current name, marks the own one and leaves tokens alone without a channel", () => {
    const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002", gone = "00000000-0000-4000-8000-000000000003";
    const names = new Map([[a, "Max"], [b, "@anna"]]);
    const inChannel = renderToStaticMarkup(<MentionContext.Provider value={{ names, me: b }}><MessageText text={`<@${a}> <@${b}> <@${gone}>`} /></MentionContext.Provider>);
    expect(inChannel).toBe(`<div class="md"><p><span class="mention">@Max</span> <span class="mention me">@anna</span> <span class="mention">@${t("chat.formerMember")}</span></p></div>`);
    expect(html(`<@${a}>`)).toBe(`<div class="md"><p>&lt;@${a}&gt;</p></div>`);
  });
  it("never lets message text become markup", () => {
    expect(html('<img src=x onerror="alert(1)"> <b>x</b>')).toBe('<div class="md"><p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &lt;b&gt;x&lt;/b&gt;</p></div>');
  });
  it("opens links in a new tab without a referrer and shows the target", () => {
    expect(html("[Doku](https://squorli.com)")).toBe('<div class="md"><p><a href="https://squorli.com" title="https://squorli.com" target="_blank" rel="noreferrer noopener">Doku</a></p></div>');
  });
  it("puts the edited mark into the last line, or below a block that cannot take it", () => {
    const mark = `<span class="muted md-edited"> ${t("chat.edited")}</span>`;
    expect(html("a\n\nb", true)).toBe(`<div class="md"><p>a</p><p>b${mark}</p></div>`);
    expect(html("- a", true)).toBe(`<div class="md"><ul><li>a</li></ul><p>${mark}</p></div>`);
  });
});
