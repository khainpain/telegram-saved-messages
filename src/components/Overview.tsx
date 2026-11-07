import { useLayoutEffect, useRef, useState } from "react";
import { useNarrow } from "../lib/narrow";
import type { Card, Library } from "../lib/types";
import { T, formatNumber } from "../i18n";
import { CardView } from "./CardView";
import { Icon } from "./Icon";
import { taskRow } from "./TodayDialog";
import type { DailyTask } from "../lib/today";
import { hueOf, type ListKey, type Scope } from "./nav";

const WIDE_GAP = 16;
/** On a phone: two columns with a tighter gap, like a pinboard app. */
const NARROW_GAP = 10;
const NARROW_COL = 150;
const MIN_COL = 220;
const MAX_COLS = 6;

export interface OverviewSection {
  key: ListKey;
  icon: string;
  title: string;
  hint: string;
  /** Number shown next to the title: cards, or groups for duplicates. */
  count: number;
  /** The first few cards, already in the order to show. */
  cards: Card[];
}

/**
 * The start screen: what needs attention now, one row of cards per smart list, then the
 * topics as shelves. Each row leads to its full list; empty ones are left out.
 */
export function Overview(props: {
  lib: Library;
  sections: OverviewSection[];
  topics: Array<[string, number]>;
  /** Groups of similar topics and tags that could be merged. */
  tidyCount: number;
  onTidy: () => void;
  activeId: number | null;
  onScope: (s: Scope) => void;
  onOpen: (c: Card) => void;
  onJunk: (c: Card) => void;
  onPin: (c: Card) => void;
  onMove: (c: Card, topic: string) => void;
  onOpenLink: (url: string) => void;
  /** Today's tasks in plan order, null for a finished one; undefined when there's no plan. */
  today?: Array<DailyTask | null>;
  /** Opens the tasks, starting at this one. */
  onToday: (start: number) => void;
  /** Three more once today's are done; undefined when there's nothing else. */
  onTodayMore?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [outer, setWidth] = useState(1000);
  const narrow = useNarrow();
  const GAP = narrow ? NARROW_GAP : WIDE_GAP;
  const width = outer - 2 * GAP;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.min(MAX_COLS, Math.max(1, Math.floor((width + GAP) / ((narrow ? NARROW_COL : MIN_COL) + GAP))));
  const sections = props.sections.filter((s) => s.count > 0);

  return (
    <div className="grid-scroll overview" ref={ref}>
      {sections.length === 0 && props.topics.length === 0 && (
        <div className="empty">
          <b>{T.overview.emptyTitle}</b>
          <span>{T.overview.emptyHint}</span>
        </div>
      )}

      {props.today && <TodayBanner tasks={props.today} onOpen={props.onToday} onMore={props.onTodayMore} />}

      {props.tidyCount > 0 && (
        <div className="ov-notice">
          <Icon name="merge" />
          <span>{T.tidy.notice(props.tidyCount)}</span>
          <button className="secondary small-btn" onClick={props.onTidy}>
            {T.tidy.noticeAction}
          </button>
        </div>
      )}

      {sections.map((s) => (
        <section key={s.key} className="ov-section">
          <header className="ov-head">
            <button className="ov-title" onClick={() => props.onScope({ kind: "list", key: s.key })}>
              <Icon name={s.icon} />
              <h2>{s.title}</h2>
              <small>{formatNumber(s.count)}</small>
            </button>
            <span className="ov-hint">{s.hint}</span>
            <span className="spacer" />
            <button className="link-btn ov-all" onClick={() => props.onScope({ kind: "list", key: s.key })}>
              {T.overview.showAll} <Icon name="right" size={13} />
            </button>
          </header>
          <div className="ov-row" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {s.cards.slice(0, cols).map((c) => (
              <CardView
                key={c.id}
                lib={props.lib}
                card={c}
                view="grid"
                selected={false}
                selecting={false}
                active={props.activeId === c.id}
                onOpen={() => props.onOpen(c)}
                onToggleSelect={() => props.onOpen(c)}
                onJunk={() => props.onJunk(c)}
                onPin={() => props.onPin(c)}
                topics={props.topics.map(([t]) => t)}
                onMove={(t) => props.onMove(c, t)}
                onOpenLink={props.onOpenLink}
              />
            ))}
          </div>
        </section>
      ))}

      {props.topics.length > 0 && (
        <section className="ov-section">
          <header className="ov-head">
            <span className="ov-title static">
              <Icon name="folder" />
              <h2>{T.sidebar.topics}</h2>
              <small>{formatNumber(props.topics.length)}</small>
            </span>
          </header>
          <div className="ov-shelves">
            {props.topics.slice(0, 12).map(([t, n]) => (
              <button key={t} className="ov-shelf" onClick={() => props.onScope({ kind: "topic", name: t })}>
                <span className="topic-dot" style={{ "--h": hueOf(t) } as React.CSSProperties} />
                <span className="label">{t}</span>
                <small>{formatNumber(n)}</small>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * "Three for today" at the top of the overview: a ring, the rows themselves (no separate inbox),
 * and Start. Once they're done it shrinks to one quiet line.
 */
function TodayBanner(props: { tasks: Array<DailyTask | null>; onOpen: (start: number) => void; onMore?: () => void }) {
  const total = props.tasks.length;
  const done = props.tasks.filter((t) => !t).length;
  const first = props.tasks.findIndex((t) => !!t);
  if (first < 0) {
    return (
      <div className="today-banner done">
        <Icon name="check" />
        <span>{T.today.allDone}</span>
        {props.onMore && (
          <button className="link-btn" onClick={props.onMore}>
            {T.today.more}
          </button>
        )}
      </div>
    );
  }
  return (
    <section className="today-banner" aria-labelledby="today-h">
      <div className="today-head">
        <svg className="today-ring" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
          <circle cx="14" cy="14" r="11" />
          {done > 0 && <circle cx="14" cy="14" r="11" className="fill" strokeDasharray={`${(done / total) * 69.1} 69.1`} />}
        </svg>
        <div className="today-titles">
          <h2 id="today-h">{T.today.title}</h2>
          <span className="hint">{T.today.progress(done, total)}</span>
        </div>
        <button className="today-go" onClick={() => props.onOpen(first)}>
          {done ? T.today.resume : T.today.start}
        </button>
      </div>
      <ul className="today-rows">
        {props.tasks.map((t, i) => {
          if (!t) return null;
          const row = taskRow(t);
          return (
            <li key={t.key}>
              <button className="today-row" onClick={() => props.onOpen(i)}>
                <span className={`today-icon ${t.kind}`}>
                  <Icon name={row.icon} size={16} />
                </span>
                <span className="label">{row.title}</span>
                <small>{row.count}</small>
                <Icon name="right" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
