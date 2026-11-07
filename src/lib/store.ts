import { platform } from "@platform";
import type { EditEvent, Library } from "./types";
import { annotateContext, applyEdits, type Aliases } from "./library";
import { emptyBoardState, type BoardState } from "./telegram";
import type { LangPref } from "../i18n";
import { DEFAULT_AI_MODEL, type AiModel } from "./ai";
import type { Skips, TodayState } from "./today";

const { exists, read, write: atomicWrite, append } = platform.data;
const LIBRARY = "library.json";
const EDITS = "edits.jsonl";
const SETTINGS = "settings.json";
const TELEGRAM = "telegram.json";

export interface Settings {
  /** AI tagging on. Only counts together with aiConsentAt: see aiAllowed. */
  aiEnabled: boolean;
  /**
   * When the user agreed, in the consent dialog, that card text goes to Anthropic. Without it
   * nothing is ever sent, whatever aiEnabled says (older versions saved aiEnabled: true by default).
   */
  aiConsentAt?: string;
  /** The consent dialog was shown once, so the app doesn't offer AI again on its own. */
  aiAsked?: boolean;
  fetchLinks: boolean;
  /** Send downscaled copies of uncaptioned photos to the AI to name them. Off unless the user turns it on. */
  aiImages: boolean;
  /** Interface language; "auto" follows the system. */
  language: LangPref;
  /** AI titles, summaries, topics and tags: in the interface language, or in each message's own. */
  aiLanguage: "ui" | "source";
  /** Which Claude model tags cards and names pictures. */
  aiModel: AiModel;
  /** Merged topics and tags (see Aliases in library.ts). */
  aliases?: Aliases;
  /** Topics the user made by hand: shown even when empty, offered to the AI first. */
  topics?: string[];
  /** Anonymous usage statistics (src/lib/telemetry.ts); on unless turned off. */
  telemetry: boolean;
  /** Today's "Three for today" plan (src/lib/today.ts). */
  today?: TodayState;
  /** Cleanup tasks set aside, for a week or for good. */
  taskSkips?: Skips;
}

export const DEFAULT_SETTINGS: Settings = { aiEnabled: false, fetchLinks: true, aiImages: false, language: "auto", aiLanguage: "ui", aiModel: DEFAULT_AI_MODEL, telemetry: true };

export async function loadLibrary(): Promise<Library | null> {
  if (!(await exists(LIBRARY))) return null;
  const lib = JSON.parse(await read(LIBRARY)) as Library | null;
  if (!lib?.cards) return null;
  applyEdits(lib.cards, await loadEdits());
  annotateContext(lib.cards);
  return lib;
}

/** Saves imported data and AI results. User edits are stripped: they live in the edit log. */
export async function saveLibrary(lib: Library) {
  const cards = lib.cards.map(({ user: _user, context: _context, ...rest }) => rest);
  await atomicWrite(LIBRARY, JSON.stringify({ ...lib, cards }));
}

export async function loadEdits(): Promise<EditEvent[]> {
  if (!(await exists(EDITS))) return [];
  const text = await read(EDITS);
  const out: EditEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line after a crash: ignore it.
    }
  }
  return out;
}

export async function appendEdit(ev: EditEvent) {
  await append(EDITS, JSON.stringify(ev) + "\n");
}

/** Whether anything may go to the AI at all: turned on and agreed to. */
export const aiAllowed = (s: Settings) => s.aiEnabled && !!s.aiConsentAt;

export async function loadSettings(): Promise<Settings> {
  if (!(await exists(SETTINGS))) return DEFAULT_SETTINGS;
  return withoutUnconsentedAi({ ...DEFAULT_SETTINGS, ...JSON.parse(await read(SETTINGS)) });
}

/** Installs from before the consent dialog had AI on by default: off until the user agrees. */
export function withoutUnconsentedAi(s: Settings): Settings {
  return s.aiConsentAt ? s : { ...s, aiEnabled: false, aiImages: false };
}

export async function saveSettings(s: Settings) {
  await atomicWrite(SETTINGS, JSON.stringify(s));
}

/** What was already sent to the Telegram group, so later runs only send new cards. */
export async function loadBoardState(): Promise<BoardState> {
  if (!(await exists(TELEGRAM))) return emptyBoardState();
  const s = JSON.parse(await read(TELEGRAM)) as Partial<BoardState> | null;
  return { ...emptyBoardState(), ...s };
}

export async function saveBoardState(s: BoardState) {
  await atomicWrite(TELEGRAM, JSON.stringify(s));
}

export async function wipeAll() {
  await atomicWrite(LIBRARY, "null");
  await atomicWrite(EDITS, "");
  await atomicWrite(TELEGRAM, "null");
}
