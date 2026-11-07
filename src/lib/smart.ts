import type { Card } from "./types";
import { effectiveTags, effectiveTopic } from "./library";

/** How far back "Recent" reaches. */
export const RECENT_DAYS = 30;

/**
 * Important: pinned by hand, or marked priority 1 by the AI and not unpinned since.
 * `pinned: false` is an explicit "not important" that overrides the AI.
 */
export function isImportant(c: Card): boolean {
  return c.user?.pinned ?? c.ai?.priority === 1;
}

export function isRecent(c: Card, now = Date.now()): boolean {
  return now - Date.parse(c.date) <= RECENT_DAYS * 864e5;
}

/**
 * Needs sorting: no topic or no tags yet (not tagged by the AI, or tagged poorly).
 * Sensitive cards never go to the AI and have their own list, so they don't count.
 */
export function isUnsorted(c: Card): boolean {
  return !c.sensitive && (!effectiveTopic(c) || effectiveTags(c).length === 0);
}

const TRACKING = /^(utm_\w+|fbclid|gclid|yclid|igshid|si|ref|ref_src|feature)$/i;

/** A link reduced to what tells pages apart: no scheme, www, tracking params, anchor or trailing slash. */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
  // youtu.be/ID, youtube.com/shorts/ID and youtube.com/watch?v=ID are the same video.
  if (host === "youtu.be") return `youtube.com/watch?v=${u.pathname.slice(1)}`;
  if (host === "youtube.com") {
    const short = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]+)/);
    const v = short?.[2] ?? u.searchParams.get("v");
    if (v) return `youtube.com/watch?v=${v}`;
  }
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return `${host}${u.pathname.replace(/\/+$/, "")}${query}`;
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** What makes two cards "the same thing": the link, the file, or a long enough identical text. */
export function dupeKey(c: Card): string | undefined {
  if (c.urls[0]) return `u:${normalizeUrl(c.urls[0])}`;
  const m = c.media;
  if (m?.fileName && m.size) return `f:${m.fileName.toLowerCase()}:${m.size}`;
  if (m?.size && m.width && m.height) return `m:${c.kind}:${m.width}x${m.height}:${m.size}`;
  const t = normText(c.text);
  if (t.length >= 30) return `t:${t}`;
  return undefined;
}

/**
 * Possible duplicates among the given cards: card id → group key, for every card that
 * shares its link, file or text with another one. Map order keeps each group together,
 * newest group first.
 */
export function findDuplicates(cards: Card[]): Map<number, string> {
  const groups = new Map<string, Card[]>();
  for (const c of cards) {
    const k = dupeKey(c);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const out = new Map<number, string>();
  for (const [k, g] of groups) if (g.length > 1) for (const c of g) out.set(c.id, k);
  return out;
}

/** Duplicate cards in group order (each group together, groups in the order their newest card appears). */
export function groupDuplicates(cards: Card[], dupes: Map<number, string>): Card[] {
  const byKey = new Map<string, Card[]>();
  for (const c of cards) {
    const k = dupes.get(c.id);
    if (!k) continue;
    const g = byKey.get(k);
    if (g) g.push(c);
    else byKey.set(k, [c]);
  }
  return [...byKey.values()].filter((g) => g.length > 1).flat();
}

/** How many groups of duplicates there are among the cards. */
export function countDuplicateGroups(cards: Card[], dupes: Map<number, string>): number {
  const n = new Map<string, number>();
  for (const c of cards) {
    const k = dupes.get(c.id);
    if (k) n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.values()].filter((x) => x > 1).length;
}
