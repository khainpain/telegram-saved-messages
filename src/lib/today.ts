import type { Card } from "./types";
import { effectiveAction, effectiveTopic, getOwnTopics } from "./library";
import { domainOf } from "./rules";
import { dupeKey, findDuplicates } from "./smart";

/**
 * "Three for today": a few small cleanup tasks a day, each a single decision that sorts
 * several cards at once. Everything is worked out on the device from what is already there.
 *
 * The day's plan is a list of task keys, fixed when the day starts so the banner doesn't
 * reshuffle while people work through it. Each key is resolved against the cards every time:
 * a task whose cards were sorted some other way simply counts as done.
 */

/** A site needs at least this many cards without a topic to become a task. */
export const SITE_MIN = 3;
/** Pairs of duplicates in one task. */
export const DUPE_GROUPS = 3;
/** Tasks in a day. */
export const PER_DAY = 3;
/** A skipped task stays away this many days. */
export const SKIP_DAYS = 7;
/** "Read later" this old is asked about: still worth reading? */
export const STALE_DAYS = 90;
/** A to-do this old is asked about: done yet? */
export const TODO_DAYS = 30;
/** Cards in one "still relevant?" or "done?" task, so an old archive doesn't flood the day. */
export const REVIEW_CARDS = 5;

export type DailyTask =
  | { kind: "dupes"; key: "dupes"; groups: Array<{ key: string; cards: Card[] }> }
  | { kind: "site"; key: string; site: string; cards: Card[]; suggest: string[] }
  /** Old cards asked about one at a time: "read later" (stale) or "to do" (todo). Oldest first. */
  | { kind: "review"; key: "stale" | "todo"; cards: Card[] };

export interface TodayState {
  /** Local date the plan is for, YYYY-MM-DD. */
  date: string;
  /** Task keys in the order shown. */
  keys: string[];
  /** Keys finished or skipped today. */
  done: string[];
}

/**
 * Tasks and groups the user set aside: key → local date until which it stays away, or
 * "never" ("they're different", "leave without a topic"). Keys are content (a link, a site),
 * not card ids, so they survive a re-import.
 */
export type Skips = Record<string, string>;

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

function skipped(skips: Skips, key: string, today: string): boolean {
  const until = skips[key];
  return until === "never" || (!!until && until > today);
}

/** Cards that can take part: not removed, not hidden, not junk, and never sensitive ones. */
function inPlay(c: Card): boolean {
  return !c.removed && !c.sensitive && !c.user?.hidden && effectiveAction(c) !== "junk";
}

/** Sites with cards that have no topic, most cards first. */
function siteTasks(cards: Card[], skips: Skips, today: string): Array<Extract<DailyTask, { kind: "site" }>> {
  const loose = new Map<string, Card[]>();
  const known = new Map<string, Map<string, number>>();
  const overall = new Map<string, number>();
  for (const c of cards) {
    if (!inPlay(c)) continue;
    const topic = effectiveTopic(c);
    if (topic) overall.set(topic, (overall.get(topic) ?? 0) + 1);
    const site = c.urls[0] ? domainOf(c.urls[0]) : "";
    if (!site) continue;
    if (topic) {
      const m = known.get(site) ?? new Map<string, number>();
      m.set(topic, (m.get(topic) ?? 0) + 1);
      known.set(site, m);
    } else {
      const g = loose.get(site);
      if (g) g.push(c);
      else loose.set(site, [c]);
    }
  }
  const own = getOwnTopics();
  const byCount = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
  const popular = byCount(overall);
  const out: Array<Extract<DailyTask, { kind: "site" }>> = [];
  for (const [site, cs] of loose) {
    const key = `s:${site}`;
    if (cs.length < SITE_MIN || skipped(skips, key, today)) continue;
    // Topics other cards from this site already have, then the user's own, then the most used.
    const suggest = [...new Set([...byCount(known.get(site) ?? new Map()), ...own, ...popular])].slice(0, 3);
    out.push({ kind: "site", key, site, cards: cs, suggest });
  }
  return out.sort((a, b) => b.cards.length - a.cards.length || (a.site < b.site ? -1 : 1));
}

/** Groups of the same link, file or text, newest first, minus the ones set aside. */
function dupeGroups(cards: Card[], skips: Skips, today: string): Array<{ key: string; cards: Card[] }> {
  const live = cards.filter(inPlay);
  const map = findDuplicates(live);
  const groups = new Map<string, Card[]>();
  for (const c of live) {
    const k = map.get(c.id);
    if (!k || skipped(skips, `d:${k}`, today)) continue;
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  return [...groups].filter(([, g]) => g.length > 1).map(([key, g]) => ({ key, cards: g }));
}

/** How a single card is set aside ("still want to read it"): by its link, file or text, else its id. */
export function cardKey(c: Card): string {
  const k = dupeKey(c);
  return `c:${k ? k.slice(0, 120) : `id:${c.id}`}`;
}

/** The oldest few cards with this status, saved before the cut-off and not set aside. */
function reviewTask(cards: Card[], key: "stale" | "todo", skips: Skips, today: string): Extract<DailyTask, { kind: "review" }> | null {
  if (skipped(skips, key, today)) return null;
  const action = key === "stale" ? "read_later" : "todo";
  const before = addDays(today, -(key === "stale" ? STALE_DAYS : TODO_DAYS));
  const old = cards
    .filter((c) => inPlay(c) && effectiveAction(c) === action && c.date.slice(0, 10) < before && !skipped(skips, cardKey(c), today))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  return old.length ? { kind: "review", key, cards: old.slice(0, REVIEW_CARDS) } : null;
}

/**
 * Every task that could be offered now: duplicates first (one click clears a pair), then the
 * biggest site, then the old "read later" and to-dos, then the other sites. Mixing them keeps a
 * day from being all of one kind.
 */
export function candidates(cards: Card[], skips: Skips, today: string): DailyTask[] {
  const out: DailyTask[] = [];
  const groups = dupeGroups(cards, skips, today);
  if (groups.length && !skipped(skips, "dupes", today)) out.push({ kind: "dupes", key: "dupes", groups: groups.slice(0, DUPE_GROUPS) });
  const [first, ...sites] = siteTasks(cards, skips, today);
  if (first) out.push(first);
  for (const k of ["stale", "todo"] as const) {
    const t = reviewTask(cards, k, skips, today);
    if (t) out.push(t);
  }
  out.push(...sites);
  return out;
}

/** A new plan: the first few candidates. */
export function makePlan(cards: Card[], skips: Skips, today: string, exclude: string[] = []): TodayState {
  const keys = candidates(cards, skips, today)
    .filter((t) => !exclude.includes(t.key))
    .slice(0, PER_DAY)
    .map((t) => t.key);
  return { date: today, keys, done: [] };
}

/** The plan for today: the saved one if it is today's, else a fresh one. */
export function planFor(saved: TodayState | undefined, cards: Card[], skips: Skips, today: string): TodayState {
  return saved?.date === today ? saved : makePlan(cards, skips, today);
}

/** Today's tasks as they are now; null for one that is finished or has nothing left to do. */
export function resolvePlan(plan: TodayState, cards: Card[], skips: Skips, today: string): Array<DailyTask | null> {
  const all = new Map(candidates(cards, skips, today).map((t) => [t.key, t]));
  return plan.keys.map((k) => (plan.done.includes(k) ? null : all.get(k) ?? null));
}

/** Skips after setting a task (or one group or card) aside: for a week, for some days, or for good. */
export function withSkip(skips: Skips, key: string, today: string, forever: boolean | number = false): Skips {
  // Old dates are dropped as we go, so the record doesn't grow for ever.
  const kept = Object.fromEntries(Object.entries(skips).filter(([, v]) => v === "never" || v > today));
  return { ...kept, [key]: forever === true ? "never" : addDays(today, typeof forever === "number" ? forever : SKIP_DAYS) };
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Two copies differ in something the user might want to keep: their text or their note. */
export function copiesDiffer(cards: Card[]): boolean {
  const first = cards[0];
  return cards.some((c) => norm(c.text) !== norm(first.text) || norm(c.user?.note) !== norm(first.user?.note));
}
