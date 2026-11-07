import { useEffect, useRef, useState } from "react";
import type { Card, Library, UserFields } from "../lib/types";
import { effectiveAction } from "../lib/library";
import { STALE_DAYS, TODO_DAYS, cardKey, copiesDiffer, type DailyTask } from "../lib/today";
import { T, formatNumber, locale } from "../i18n";
import { CardView } from "./CardView";
import { Icon } from "./Icon";
import { TopicMenu } from "./TopicMenu";
import mascot from "../../brand/kipple-mascot-light.svg";

/** How a finished step can be taken back: the fields each card had before. */
interface Undo {
  before: Array<{ id: number; patch: UserFields }>;
  step: number;
  group: number;
  /** A task this step finished, so it can be reopened. */
  finished?: string;
}

const noop = () => {};
const dateOf = (c: Card) => new Date(c.date).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
const PREVIEW = 3;

/**
 * "Three for today": one decision per screen. A choice on a single card applies at once;
 * a choice that changes many cards, or copies that differ, is picked first and then confirmed.
 * Every step can be taken back with Undo or Ctrl+Z.
 */
export function TodayDialog(props: {
  lib: Library;
  tasks: DailyTask[];
  /** Index of the task to start on. */
  start: number;
  topics: string[];
  onEdit: (ids: number[], patch: UserFields) => void;
  /** The task is finished (or skipped for a week with `skip`). */
  onDone: (key: string, skip?: "week" | "never") => void;
  /** Bring a finished task back (after Undo). */
  onReopen: (key: string) => void;
  /** Set one group of duplicates aside for good, or one card for some days. */
  onSkipGroup: (key: string, days?: number) => void;
  /** Counts for the last screen. */
  left: () => { unsorted: number; dupes: number };
  /** Another three, when there are more; undefined when there are none. */
  onMore?: () => void;
  onClose: () => void;
}) {
  // Fixed when the dialog opens: a task sorted here would otherwise drop out of the list mid-way.
  const [tasks] = useState(props.tasks);
  const [step, setStep] = useState(props.start);
  const [group, setGroup] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sorted, setSorted] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  const task = step < tasks.length ? tasks[step] : null;
  const pair = task?.kind === "dupes" ? task.groups[group] : undefined;
  const one = task?.kind === "review" ? task.cards[group] : undefined;
  // Newest first; the oldest is the last one.
  const copies = pair ? [...pair.cards].sort((a, b) => (a.date < b.date ? 1 : -1)) : [];
  const differ = copies.length > 1 && copiesDiffer(copies);

  // Focus follows the question, so a screen reader reads it first; it goes back where it came from on close.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step, group]);
  useEffect(() => () => (opener.current as HTMLElement | null)?.focus?.({ preventScroll: true }), []);

  function next() {
    setPicked(null);
    setMenuAt(null);
    setGroup(0);
    setStep((s) => s + 1);
  }

  /** Applies a patch to some cards, remembering what they had so it can be undone. */
  function change(cards: Card[], patch: (c: Card) => UserFields, finished?: string) {
    const before = cards.map((c) => {
      const p = patch(c);
      const was: UserFields = {};
      // The edit log drops undefined, so "had nothing" is written back as "" (no topic) or the status it showed.
      if ("topic" in p) was.topic = c.user?.topic ?? "";
      if ("action" in p) was.action = c.user?.action ?? effectiveAction(c) ?? "reference";
      return { id: c.id, patch: was };
    });
    const byPatch = new Map<string, number[]>();
    for (const c of cards) {
      const k = JSON.stringify(patch(c));
      byPatch.set(k, [...(byPatch.get(k) ?? []), c.id]);
    }
    for (const [k, ids] of byPatch) props.onEdit(ids, JSON.parse(k));
    setUndo({ before, step, group, finished });
    setSorted((n) => n + cards.length);
  }

  function doUndo() {
    if (!undo) return;
    for (const b of undo.before) props.onEdit([b.id], b.patch);
    if (undo.finished) props.onReopen(undo.finished);
    setSorted((n) => Math.max(0, n - undo.before.length));
    setStep(undo.step);
    setGroup(undo.group);
    setPicked(null);
    setUndo(null);
    setNote(T.today.undone);
  }

  function applyTopic(topic: string) {
    if (task?.kind !== "site") return;
    change(task.cards, () => ({ topic }), task.key);
    props.onDone(task.key);
    setNote(T.today.sortedTopic(task.cards.length, topic));
    next();
  }

  function pickTopic(topic: string) {
    if (picked === topic) applyTopic(topic);
    else setPicked(topic);
  }

  /** Steps within a task: duplicate pairs, or old cards one by one. */
  const parts = task?.kind === "dupes" ? task.groups.length : task?.kind === "review" ? task.cards.length : 1;

  function finishGroup() {
    if (!task) return;
    if (group + 1 < parts) {
      setPicked(null);
      setGroup(group + 1);
    } else {
      props.onDone(task.key);
      next();
    }
  }

  function keep(which: "new" | "old") {
    if (task?.kind !== "dupes" || !pair) return;
    if (differ && picked !== which) {
      setPicked(which);
      return;
    }
    const keepId = which === "new" ? copies[0].id : copies[copies.length - 1].id;
    const last = group + 1 >= task.groups.length;
    change(
      copies.filter((c) => c.id !== keepId),
      () => ({ action: "junk" }),
      last ? task.key : undefined,
    );
    setNote(T.today.sortedDupes(copies.length - 1));
    finishGroup();
  }

  function different() {
    if (!pair) return;
    props.onSkipGroup(`d:${pair.key}`);
    setUndo(null);
    finishGroup();
  }

  /** An old card: keep it as reference, set it aside for a while, or send it to Junk. */
  function review(how: "reference" | "later" | "junk") {
    if (task?.kind !== "review" || !one) return;
    const last = group + 1 >= parts;
    if (how === "later") {
      props.onSkipGroup(cardKey(one), task.key === "stale" ? STALE_DAYS : TODO_DAYS);
      if (last) props.onDone(task.key);
      setUndo(null);
      setNote(T.today.later);
    } else {
      change([one], () => ({ action: how }), last ? task.key : undefined);
      if (last) props.onDone(task.key);
      setNote(how === "junk" ? T.today.sortedDupes(1) : T.today.toReference);
    }
    finishGroup();
  }

  function skip() {
    if (!task) return;
    props.onDone(task.key, "week");
    setUndo(null);
    next();
  }

  function leaveSite() {
    if (task?.kind !== "site") return;
    props.onDone(task.key, "never");
    setUndo(null);
    next();
  }

  const choices: Array<{ id: string; label: string; act: () => void; dashed?: boolean }> =
    task?.kind === "site"
      ? [
          ...task.suggest.map((t) => ({ id: t, label: t, act: () => pickTopic(t) })),
          { id: "__other", label: T.today.otherTopic, dashed: true, act: () => setMenuAt(document.querySelector<HTMLElement>(".today-chip.other")) },
        ]
      : task?.kind === "dupes"
        ? [
            { id: "new", label: T.today.keepNew, act: () => keep("new") },
            { id: "old", label: T.today.keepOld, act: () => keep("old") },
            { id: "diff", label: T.today.different, act: different },
          ]
        : task?.kind === "review"
          ? [
              { id: "ref", label: task.key === "stale" ? T.today.useful : T.today.didIt, act: () => review("reference") },
              { id: "later", label: task.key === "stale" ? T.today.stillRead : T.today.stillTodo, act: () => review("later") },
              { id: "junk", label: T.today.notNeeded, act: () => review("junk") },
            ]
          : [];

  // Keys: 1–4 pick, Enter applies the picked one, S skips, Ctrl+Z undoes, Esc closes. Caught before
  // the board's own shortcuts, and left alone while the topic filter has the focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
      let handled = true;
      if (e.key === "Escape") props.onClose();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") doUndo();
      else if (e.ctrlKey || e.metaKey || e.altKey) handled = false;
      else if (/^[1-9]$/.test(e.key) && choices[Number(e.key) - 1]) choices[Number(e.key) - 1].act();
      else if (e.key === "Enter" && picked && el.tagName !== "BUTTON" && el.tagName !== "A") {
        if (task?.kind === "site") applyTopic(picked);
        else if (picked === "new" || picked === "old") keep(picked);
      } else if ((e.key === "s" || e.key === "ы") && task) skip();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const total = tasks.length;
  const preview = (cards: Card[]) => (
    <div className="today-cards" style={{ gridTemplateColumns: `repeat(${Math.min(cards.length, PREVIEW)}, minmax(0, 1fr))` }}>
      {cards.slice(0, PREVIEW).map((c) => (
        <CardView
          key={c.id}
          lib={props.lib}
          card={c}
          view="grid"
          selected={false}
          selecting={false}
          active={false}
          onOpen={noop}
          onToggleSelect={noop}
          onJunk={noop}
          onPin={noop}
          topics={[]}
          onMove={noop}
          onOpenLink={noop}
        />
      ))}
    </div>
  );

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal today" role="dialog" aria-modal="true" aria-labelledby="today-q" onClick={(e) => e.stopPropagation()}>
        {task ? (
          <>
            <div className="today-top">
              <span className="today-steps" aria-hidden="true">
                {tasks.map((t, i) => (
                  <span key={t.key} className={i <= step ? "on" : ""} />
                ))}
              </span>
              <span className="hint today-count" aria-live="polite">
                {T.today.step(step + 1, total)}
                {task.kind === "dupes" && task.groups.length > 1 && <> · {T.today.pair(group + 1, task.groups.length)}</>}
                {task.kind === "review" && task.cards.length > 1 && <> · {T.today.cardOf(group + 1, task.cards.length)}</>}
              </span>
              <button className="link-btn today-skip" onClick={skip}>
                {T.today.skip} <kbd>S</kbd>
              </button>
              <button className="icon-btn" onClick={props.onClose} aria-label={T.common.close}>
                <Icon name="close" />
              </button>
            </div>

            {task.kind === "site" ? (
              <>
                <div className="today-q">
                  <h2 id="today-q" tabIndex={-1} ref={heading}>
                    {T.today.siteQ(task.site)}
                  </h2>
                  <p className="hint">{T.today.siteHint(task.cards.length)}</p>
                </div>
                {preview(task.cards)}
                {task.cards.length > PREVIEW && <p className="hint">{T.today.moreCards(task.cards.length - PREVIEW)}</p>}
                {task.suggest.length > 0 && <div className="today-label">{T.today.similar}</div>}
              </>
            ) : task.kind === "review" ? (
              <>
                <div className="today-q">
                  <h2 id="today-q" tabIndex={-1} ref={heading}>
                    {task.key === "stale" ? T.today.staleQ : T.today.todoQ}
                  </h2>
                  <p className="hint">{T.today.savedOn(dateOf(one!))}</p>
                </div>
                <div className="today-one">{preview([one!])}</div>
              </>
            ) : (
              <>
                <div className="today-q">
                  <h2 id="today-q" tabIndex={-1} ref={heading}>
                    {T.today.dupesQ}
                  </h2>
                  <p className="hint">{T.today.dupesHint}</p>
                </div>
                <div className="today-pair">
                  {[copies[copies.length - 1], copies[0]].map((c, i) => {
                    const own = differ ? (c.user?.note || c.text).trim() : "";
                    const shared = differ && copies.some((o) => o.id !== c.id && (o.user?.note || o.text).trim() === own);
                    return (
                      <div key={c.id} className="today-copy">
                        <span className="hint">{i === 0 ? T.today.older(dateOf(c)) : T.today.newer(dateOf(c))}</span>
                        {preview([c])}
                        {own && !shared && (
                          <p className="today-diff">
                            <b>{T.today.onlyHere}</b> «{own.length > 140 ? own.slice(0, 140) + "…" : own}»
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {copies.length > 2 && <p className="hint">{T.today.moreCards(copies.length - 2)}</p>}
              </>
            )}

            <div className="today-chips">
              {choices.map((ch, i) => (
                <button
                  key={ch.id}
                  className={`today-chip${ch.dashed ? " other" : ""}${picked === ch.id ? " on" : ""}`}
                  aria-pressed={task.kind === "site" && !ch.dashed ? picked === ch.id : undefined}
                  onClick={ch.act}
                >
                  {ch.label} <kbd>{i + 1}</kbd>
                </button>
              ))}
            </div>
            {menuAt && task.kind === "site" && (
              <TopicMenu anchor={menuAt} topics={props.topics} onPick={(t) => (setMenuAt(null), t && applyTopic(t))} onClose={() => setMenuAt(null)} />
            )}
            {picked && task.kind === "site" && <p className="hint">{T.today.sitePreview(task.cards.length, picked)}</p>}
            {picked && task.kind === "dupes" && <p className="hint">{T.today.dupesDiffer}</p>}

            <div className="today-foot">
              {task.kind === "site" && (
                <button className="link-btn muted" onClick={leaveSite}>
                  {T.today.leaveSite}
                </button>
              )}
              {undo && (
                <button className="link-btn" onClick={doUndo}>
                  {T.today.undo} <kbd>Ctrl+Z</kbd>
                </button>
              )}
              <span className="hint today-note" role="status">
                {note}
              </span>
              <span className="spacer" />
              {task.kind === "site" && picked && <button onClick={() => applyTopic(picked)}>{T.today.applyTo(task.cards.length)}</button>}
              {task.kind === "dupes" && picked && <button onClick={() => keep(picked as "new" | "old")}>{T.today.confirm}</button>}
            </div>
          </>
        ) : (
          <Finale sorted={sorted} left={props.left()} undo={undo ? doUndo : undefined} onMore={props.onMore} onClose={props.onClose} heading={heading} />
        )}
      </div>
    </div>
  );
}

function Finale(props: {
  sorted: number;
  left: { unsorted: number; dupes: number };
  undo?: () => void;
  onMore?: () => void;
  onClose: () => void;
  heading: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className="today-finale">
      <img src={mascot} alt="" className="today-mascot" />
      <h2 id="today-q" tabIndex={-1} ref={props.heading}>
        {T.today.finaleTitle}
      </h2>
      <p className="hint" role="status">
        {T.today.finaleText(props.sorted)}
      </p>
      <div className="today-stats">
        <div>
          <b>{formatNumber(props.sorted)}</b>
          <span>{T.today.statToday}</span>
        </div>
        <div>
          <b>{formatNumber(props.left.unsorted)}</b>
          <span>{T.today.statLeft}</span>
        </div>
        <div>
          <b>{formatNumber(props.left.dupes)}</b>
          <span>{T.today.statDupes}</span>
        </div>
      </div>
      <div className="today-finale-btns">
        {props.undo && (
          <button className="link-btn" onClick={props.undo}>
            {T.today.undo}
          </button>
        )}
        <span className="spacer" />
        {props.onMore && (
          <button className="secondary" onClick={props.onMore}>
            {T.today.more}
          </button>
        )}
        <button onClick={props.onClose}>{T.today.done}</button>
      </div>
    </div>
  );
}

/** Used by the banner: how the task is named in its row, and what it counts. */
export function taskRow(t: DailyTask): { icon: string; title: string; count: string } {
  if (t.kind === "dupes") return { icon: "copy", title: T.today.dupesTitle, count: T.today.dupesRow(t.groups.length) };
  if (t.kind === "review")
    return t.key === "stale"
      ? { icon: "clock", title: T.today.staleTitle, count: T.today.cardsRow(t.cards.length) }
      : { icon: "check", title: T.today.todoTitle, count: T.today.cardsRow(t.cards.length) };
  return { icon: "globe", title: T.today.siteTitle(t.site), count: T.today.cardsRow(t.cards.length) };
}

