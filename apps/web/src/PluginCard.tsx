import type { MessageCard } from "@squorli/protocol";
import { memo } from "react";
import { MessageText } from "./MessageText";
import { safeHref } from "./safeHref";

const linkProps = { target: "_blank", rel: "noreferrer noopener" } as const;

/**
 * A plugin's card (docs/features/plugins.md, interface version 2): its message as a framed box with a small line above
 * the title, the title as a link, a text in the Markdown of messages, a small picture in the corner and a large one below.
 * Drawn with the client's own parts only: the texts are text nodes or go through `MessageText` (never HTML), the link
 * through `safeHref`, and both pictures are files of the server that sent the message (the caller resolves their paths with
 * `api.abs`), never an address a plugin named. A plugin chooses no colour and no layout.
 *
 * Memoized with plain props: the chat renders on every keystroke.
 */
export const PluginCard = memo(function PluginCard({ card, image, thumbnail }: { card: MessageCard; image: string | null; thumbnail: string | null }) {
  const href = safeHref(card.url);
  const title = card.title?.trim(), kicker = card.kicker?.trim(), text = card.text?.trim();
  if (!title && !text) return null;
  return (
    <div className="plugin-card">
      {(kicker || title || thumbnail) && (
        <div className="plugin-card-head">
          <div className="plugin-card-titles">
            {kicker && <span className="plugin-card-kicker">{kicker}</span>}
            {title && (href ? <a className="plugin-card-title" href={href} title={card.url} {...linkProps}>{title}</a> : <strong className="plugin-card-title">{title}</strong>)}
          </div>
          {thumbnail && <img className="plugin-card-thumb" src={thumbnail} alt="" loading="lazy" />}
        </div>
      )}
      {text && <MessageText text={text} />}
      {image && (href
        ? <a className="plugin-card-image" href={href} title={card.url} tabIndex={-1} {...linkProps}><img src={image} alt="" loading="lazy" /></a>
        : <span className="plugin-card-image"><img src={image} alt="" loading="lazy" /></span>)}
    </div>
  );
});
