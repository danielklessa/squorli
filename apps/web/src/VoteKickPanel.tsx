import { useEffect, useState } from "react";
import type { VoteKickResult } from "@squorli/protocol";
import { Avatar } from "./Avatar";
import { useBackClose } from "./backStack";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { blockMinutes, outcomeKey, secondsLeft, voteBar, voteCounts, type VoteKickPerson, type VoteKickState } from "./voteKick";

/**
 * Vote kick in a voice channel (docs/features/votekick.md, 23 September 2026, user's wish): while a vote runs, everybody
 * in the channel sees the current result at the top of the member list; how it ended stays there for half a minute.
 * Whoever may vote and has not yet gets the modal below; the box keeps the two buttons, so a dismissed modal is not the
 * end of it.
 *
 * The box is the first element inside the member column (user's correction, 23 September 2026: "der Vote kick soll nicht
 * über der Liste sein, sondern oben in der Liste"), so `MemberList` renders it and it scrolls with the list. Yes and no
 * are a bar over everybody who sat in the channel at the start, with a mark where the quorum is reached (user's wish:
 * "das ja nein bitte als Balken optisch darstellen"). The member the vote is about is drawn like members are drawn
 * everywhere else: avatar or initials, presence dot, name in their role's colour (user's wish).
 */

/** A second's tick while something counts down (nothing runs when there is nothing to count). */
function useSeconds(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** Yes (the member goes) and no (they stay) as portions of the room; the rest has not voted. */
function VoteBar({ yes, no, roomSize }: { yes: number; no: number; roomSize: number }) {
  const bar = voteBar({ yes, no, roomSize });
  return (
    <div className="votekick-bar" role="img" aria-label={t("votekick.counts", { yes, no })}>
      <span className="votekick-fill yes" style={{ width: `${bar.yes}%` }} />
      <span className="votekick-fill no" style={{ width: `${bar.no}%` }} />
      <span className="votekick-quorum" style={{ left: `${bar.quorum}%` }} title={t("votekick.quorumMark")} />
    </div>
  );
}

/** The member the vote is about, as the member list would draw them. */
function Person({ person, label }: { person: VoteKickPerson; label: string }) {
  return (
    <div className="votekick-person" aria-label={label}>
      <Avatar name={person.displayName} src={person.avatarUrl} online={person.online} afk={person.afk} />
      <strong style={person.color ? { color: person.color } : undefined}>{person.displayName}</strong>
    </div>
  );
}

function Counts({ yes, no }: { yes: number; no: number }) {
  return <p className="votekick-counts"><span className="yes">{t("votekick.yes")} {yes}</span><span className="no">{t("votekick.no")} {no}</span></p>;
}

export function VoteKickPanel({ state, result, person, onVote }: { state: VoteKickState | null; result: VoteKickResult | null; person: VoteKickPerson | null; onVote: (yes: boolean) => void }) {
  const now = useSeconds(!!state);
  if ((!state && !result) || !person) return null;
  if (state) {
    const { vote, myVote, canVote } = state;
    const { yes, no, missing } = voteCounts(vote);
    return (
      <aside className="votekick-box" role="status" aria-live="polite">
        <header><Icon name="gavel" /><strong>{t("votekick.title")}</strong><span className="votekick-clock">{clock(secondsLeft(vote.endsAt, now))}</span></header>
        <Person person={person} label={t("votekick.against", { name: person.displayName })} />
        <VoteBar yes={yes} no={no} roomSize={vote.roomSize} />
        <Counts yes={yes} no={no} />
        <p className="muted small">{missing === 0 ? t("votekick.enough") : missing === 1 ? t("votekick.missingOne") : t("votekick.missing", { n: missing })}</p>
        {canVote
          ? <div className="row votekick-actions">
              <button className="small" onClick={() => onVote(true)}><Icon name="thumbs-up" /> {t("votekick.yes")}</button>
              <button className="secondary small" onClick={() => onVote(false)}><Icon name="thumbs-down" /> {t("votekick.no")}</button>
            </div>
          : <p className="muted small">{myVote ? t("votekick.voted", { vote: t(myVote === "yes" ? "votekick.yes" : "votekick.no") }) : t("votekick.startedBy", { name: vote.startedByName })}</p>}
      </aside>
    );
  }
  const minutes = blockMinutes(result!.blockedUntil, Date.now());
  return (
    <aside className={`votekick-box ${result!.outcome === "passed" ? "passed" : "stays"}`} role="status" aria-live="polite">
      <header><Icon name="gavel" /><strong>{t("votekick.title")}</strong></header>
      <Person person={person} label={t("votekick.against", { name: person.displayName })} />
      <p className="votekick-target">{t(outcomeKey(result!.outcome))}</p>
      {result!.outcome !== "cancelled" && <><VoteBar yes={result!.yes} no={result!.no} roomSize={result!.roomSize} /><Counts yes={result!.yes} no={result!.no} /></>}
      {minutes > 0 && <p className="muted small">{t("votekick.blocked", { minutes })}</p>}
    </aside>
  );
}

/**
 * The question for everybody who may vote (user's wish). Closing it (Escape, a click beside it) is no vote: the box keeps
 * offering the two buttons until the minute is over.
 */
export function VoteKickModal({ state, person, onVote, onClose }: { state: VoteKickState; person: VoteKickPerson; onVote: (yes: boolean) => void; onClose: () => void }) {
  const now = useSeconds(true);
  const left = secondsLeft(state.vote.endsAt, now);
  useBackClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onClose}>
      <div className="modal dialog votekick-dialog" role="dialog" aria-modal="true" aria-labelledby="votekick-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="votekick-title">{t("votekick.modalTitle", { name: person.displayName })}</h2>
        <Person person={person} label={t("votekick.against", { name: person.displayName })} />
        <p className="dialog-text">{t("votekick.modalText", { starter: state.vote.startedByName })}</p>
        <VoteBar yes={state.vote.yes} no={state.vote.no} roomSize={state.vote.roomSize} />
        <Counts yes={state.vote.yes} no={state.vote.no} />
        <p className="muted small">{t("votekick.modalSeconds", { n: left })} · {t("votekick.modalLater")}</p>
        <div className="dialog-actions">
          <button className="secondary" onClick={() => onVote(false)}><Icon name="thumbs-down" /> {t("votekick.no")}</button>
          <button className="danger" onClick={() => onVote(true)}><Icon name="thumbs-up" /> {t("votekick.yes")}</button>
        </div>
      </div>
    </div>
  );
}
