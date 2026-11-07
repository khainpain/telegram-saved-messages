import { useCallback, useEffect, useRef, useState } from "react";
import { platform } from "@platform";
import { useUpdateCheck } from "./useUpdateCheck";
import { useTelegramAccount } from "./useTelegramAccount";
import "./App.css";
import type { Card, Library, UserFields } from "./lib/types";
import type { Skips, TodayState } from "./lib/today";
import { effectiveTags, effectiveTopic, findTopic, getOwnTopics, makeEdit, matchesFilter, mergeAlias, NO_ALIASES, setAliases, setOwnTopics, topicName, type Aliases } from "./lib/library";
import { aiAllowed, appendEdit, DEFAULT_SETTINGS, loadBoardState, loadLibrary, loadSettings, saveBoardState, saveLibrary, saveSettings, wipeAll, type Settings } from "./lib/store";
import { BOARD_TITLE, sendToTelegram, TelegramAuthError, telegramErrorText, type SendOptions } from "./lib/telegram";
import { TelegramDialog } from "./components/TelegramDialog";
import { importFolder, pickExportFolder } from "./lib/importer";
import { fetchLinkMeta, needsPreview } from "./lib/linkmeta";
import { AiStop, aiModelOf, type AiAuth, classifyCards, retagCount, nameImages, pendingForAi, pendingImages, suggestSynonyms, groupCards } from "./lib/ai";
import { displayTitle } from "./components/CardView";
import { toCsv, toMarkdown } from "./lib/exporters";
import { deleteApiKey, getAiAuth, getApiKey, setApiKey } from "./lib/secrets";
import { Workspace, type Job } from "./components/Workspace";
import { SettingsDialog } from "./components/Settings";
import { AiConsentDialog } from "./components/AiConsent";
import { Welcome } from "./components/Welcome";
import { demoLibrary } from "./lib/demo";
import { emptyTelegramLibrary, syncSaved } from "./lib/tgImport";
import { T, lang, resolveLang, setLang } from "./i18n";
import type { AiLang } from "./lib/ai";
import { Toast } from "./components/Motion";
import { initTelemetry, markImported, maybeSendPing, setTelemetryEnabled, setTelemetrySuspended, telemetrySupported, track } from "./lib/telemetry";

const isWeb = platform.kind === "web";

/**
 * On the production site visitors only get the demo: import works for real only in the desktop app.
 * Vercel previews (behind Vercel sign-in) and local builds keep the full browser build.
 */
const demoOnly = isWeb && __WEB_DEMO_ONLY__;

export default function App() {
  const [lib, setLib] = useState<Library | null>(null);
  const [rev, setRev] = useState(0); // bumps whenever cards change in place
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hasKey, setHasKey] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTelegram, setShowTelegram] = useState(false);
  const tgAccount = useTelegramAccount(!showTelegram && lib !== null);
  const [sendingTg, setSendingTg] = useState(false);
  const [job, setJob] = useState<Job>(null);
  /** The consent dialog is open; resolving it with the answer carries on with what asked. */
  const [consent, setConsent] = useState<((ok: boolean) => void) | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const [updating, setUpdating] = useState<number | null | false>(false);
  const updatingRef = useRef(updating);
  updatingRef.current = updating;
  const { update, later: updateLater } = useUpdateCheck(() => updatingRef.current !== false);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * The demo is a sealed sandbox: only in memory, never saved, no import, AI or Telegram,
   * so nothing done in it can touch the real library. "Exit demo" goes back to the start.
   */
  const [demo, setDemo] = useState(false);
  /** Merges tried out in the demo stay in memory, apart from the real ones in settings. */
  const [demoAliases, setDemoAliases] = useState<Aliases>(NO_ALIASES);
  const [demoTopics, setDemoTopics] = useState<string[]>([]);
  /** "Three for today" in the demo: in memory only, like its merges. */
  const [demoToday, setDemoToday] = useState<{ today?: TodayState; skips: Skips }>({ skips: {} });
  const demoRef = useRef(demo);
  demoRef.current = demo;
  /** Loading from Telegram already started by itself after sign-in in this launch. */
  const tgAutoRef = useRef(false);
  /** Settings as of now, for AI runs that start right after a save (state updates later). */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const libRef = useRef(lib);
  libRef.current = lib;
  const hasKeyRef = useRef(hasKey);
  hasKeyRef.current = hasKey;

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 6000);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [l, s, k] = await Promise.all([loadLibrary(), loadSettings(), getApiKey().catch(() => null)]);
        // Links from the landing page: ?lang=en|ru (unless a language was picked in Settings)
        // and ?demo, which opens the sample library straight away in the browser build.
        const q = new URLSearchParams(location.search);
        const qLang = q.get("lang");
        setLang(resolveLang(s.language === "ru" || s.language === "en" ? s.language : qLang === "ru" || qLang === "en" ? qLang : s.language));
        setLib(l);
        setSettings(s);
        setHasKey(!!k);
        void startTelemetry(s, !!l);
        if (demoOnly || (isWeb && q.has("demo"))) {
          history.replaceState(null, "", location.pathname); // "Exit demo" then leads to the normal start
          return openDemo();
        }
        if (!l) return;
        // Libraries imported before previews worked here (or by an older version) catch up in the background.
        const catchUp = () => {
          if (!s.fetchLinks || !platform.canFetchLinks || !l.cards.some(needsPreview)) return;
          const ctl = new AbortController();
          abortRef.current = ctl;
          void enrichLinks(l, ctl.signal).finally(() => {
            setJob(null);
            setRev((r) => r + 1);
          });
        };
        // Signed in to Telegram: bring in what was saved since last time (and finish an interrupted
        // load). That ends with previews and AI anyway; otherwise just catch up on previews.
        const tg = platform.telegram;
        if (!tg) return catchUp();
        void tg.status().then(
          (st) => (st.authorized ? void syncTelegram(l, false, catchUp) : catchUp()),
          catchUp,
        );
      } catch (e) {
        notify(T.app.loadFailed(String(e)));
      } finally {
        setLoading(false);
      }
    })();
  }, [notify]);

  useEffect(() => {
    platform.appVersion().then(setVersion, () => undefined);
  }, []);

  /** Anonymous statistics: today's ping on start, then checked every hour and when the window comes back. */
  async function startTelemetry(s: Settings, hadLibrary: boolean) {
    if (!telemetrySupported()) return;
    const firstAfterUpdate = await initTelemetry({
      enabled: s.telemetry,
      hadLibrary,
      context: () => ({
        libraryCount: libRef.current?.cards.length ?? 0,
        ai: aiAllowed(settingsRef.current) ? (hasKeyRef.current ? "own" : "builtin") : "off",
        lang: lang(),
      }),
    });
    if (firstAfterUpdate && s.telemetry) notify(T.app.statsNotice);
    void maybeSendPing();
  }
  useEffect(() => {
    if (!telemetrySupported()) return;
    const send = () => void maybeSendPing();
    const timer = setInterval(send, 3_600_000);
    window.addEventListener("focus", send);
    return () => (clearInterval(timer), window.removeEventListener("focus", send));
  }, []);

  async function installUpdate() {
    if (!update) return;
    abortRef.current?.abort();
    setUpdating(null);
    try {
      await update.install((p) => setUpdating(p));
    } catch (e) {
      setUpdating(false);
      notify(T.app.updateFailed(String(e)));
    }
  }

  const persist = useCallback(async (l: Library) => {
    if (demoRef.current) return;
    try {
      await saveLibrary(l);
    } catch (e) {
      notify(T.app.saveFailed(String(e)));
    }
  }, []);

  /** Default: the interface language, so all topics in the sidebar are in one language. */
  const aiLang = (): AiLang => (settingsRef.current.aiLanguage === "source" ? "source" : lang());

  async function enrichLinks(l: Library, signal: AbortSignal) {
    const todo = l.cards.filter(needsPreview);
    if (!todo.length) return;
    let done = 0;
    setJob({ label: T.app.jobLinks, done, total: todo.length });
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !signal.aborted) {
        const c = todo[next++];
        c.link = await fetchLinkMeta(c.urls[0]);
        done++;
        if (done % 10 === 0 || done === todo.length) {
          setJob({ label: T.app.jobLinks, done, total: todo.length });
          setRev((r) => r + 1);
        }
        if (done % 50 === 0) await persist(l);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    await persist(l);
  }

  async function runAi(l: Library, signal: AbortSignal) {
    if (!aiAllowed(settingsRef.current) || demoRef.current) return; // nothing leaves without consent
    const auth = await getAiAuth();
    if (!(await runTextAi(auth, l, signal))) return;
    if (settingsRef.current.aiImages && !signal.aborted) await runImageAi(auth, l, pendingImages(l.cards), signal);
  }

  async function runImageAi(auth: AiAuth, l: Library, todo: Card[], signal: AbortSignal) {
    if (!todo.length) return;
    setJob({ label: T.app.jobImages, done: 0, total: todo.length });
    try {
      const res = await nameImages(
        auth,
        l.cards,
        todo,
        aiLang(),
        aiModelOf(settingsRef.current.aiModel),
        (c) => platform.readMedia(l.sourceDir, c.media!.path!),
        (p) => {
          setJob({ label: T.app.jobImages, done: p.done + p.failed, total: p.total });
          setRev((r) => r + 1);
          void persist(l);
        },
        signal,
      );
      if (res.failed) notify(T.app.imagesFailed(res.failed));
    } catch (e) {
      notify(e instanceof AiStop ? e.message : T.app.aiError(String(e)));
    }
    await persist(l);
  }

  /** One photo, on the user's request from the card: sends just this picture. */
  async function nameOne(card: Card) {
    if (!lib || !aiAllowed(settingsRef.current)) return;
    const auth = await getAiAuth();
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const saved = card.ai;
    card.ai = undefined;
    try {
      await runImageAi(auth, lib, [card], ctl.signal);
    } finally {
      if (!card.ai) card.ai = saved;
      setJob(null);
      setRev((r) => r + 1);
    }
  }

  /** Tags the pending cards; false when the run had to stop (key, allowance), so pictures wait too. */
  async function runTextAi(auth: AiAuth, l: Library, signal: AbortSignal): Promise<boolean> {
    const total = pendingForAi(l.cards).length;
    if (!total) return true;
    setJob({ label: T.app.jobAi, done: 0, total });
    try {
      const res = await classifyCards(
        auth,
        l.cards,
        aiLang(),
        aiModelOf(settingsRef.current.aiModel),
        (p) => {
          setJob({ label: T.app.jobAi, done: p.done + p.failed, total: p.total });
          setRev((r) => r + 1);
          void persist(l);
        },
        signal,
      );
      if (res.failed) notify(T.app.aiFailed(res.failed));
      track("ai_run_completed", auth.kind);
    } catch (e) {
      notify(e instanceof AiStop ? e.message : T.app.aiError(String(e)));
      if (e instanceof AiStop && (e.message === T.ai.quotaUsed || e.message === T.ai.quotaGlobal)) track("ai_quota_hit");
      if (e instanceof AiStop) {
        await persist(l);
        return false;
      }
    }
    await persist(l);
    return true;
  }

  async function processAll(l: Library) {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      if (settingsRef.current.fetchLinks && platform.canFetchLinks) await enrichLinks(l, ctl.signal);
      if (!ctl.signal.aborted && !demoRef.current && !aiAllowed(settingsRef.current) && !settingsRef.current.aiAsked && pendingForAi(l.cards).length) {
        // The first time there is something to tag, ask once; "No AI" is remembered and not asked again.
        setJob(null);
        const ok = await askConsent();
        if (!ok) track("ai_consent_answered", "no"); // "yes" is counted in applySettings
        const s = settingsRef.current;
        await applySettings(ok ? { ...s, aiEnabled: true, aiConsentAt: new Date().toISOString(), aiAsked: true } : { ...s, aiAsked: true });
      }
      if (aiAllowed(settingsRef.current) && !ctl.signal.aborted) await runAi(l, ctl.signal);
    } finally {
      setJob(null);
      setRev((r) => r + 1);
    }
  }

  async function doImport() {
    const src = await pickExportFolder();
    if (!src) return;
    try {
      const { lib: next, added, warning } = await importFolder(src, demoRef.current ? null : lib);
      await saveLibrary(next);
      demoRef.current = false; // before processAll below, which saves as it goes
      setTelemetrySuspended(false);
      setDemo(false);
      setLib(next);
      setRev((r) => r + 1);
      notify(warning ?? T.app.imported(next.cards.length, added));
      track("import_completed", "export_json");
      markImported();
      void processAll(next);
    } catch (e) {
      track("import_failed", "export_json");
      notify(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Loads Saved Messages straight from Telegram into `l` (a fresh library after sign-in, or the
   * current one to fetch what's new), then downloads photos and runs previews and AI as after an import.
   * Stopping it keeps what was loaded; the next launch carries on.
   */
  async function syncTelegram(l: Library, fresh: boolean, nothingNew?: () => void) {
    const tg = platform.telegram;
    if (!tg || demoRef.current) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    if (fresh) {
      setLib(l);
      setRev((r) => r + 1);
    }
    let added = 0;
    try {
      const res = await syncSaved(l, {
        tg,
        save: persist,
        signal: ctl.signal,
        onProgress: (p) => setJob({ label: p.phase === "messages" ? T.app.jobTgLoad : T.app.jobTgPhotos, done: p.done, total: p.total }),
        onChange: () => setRev((r) => r + 1),
      });
      added = res.added;
      if (fresh || added) notify(T.app.tgLoaded(l.cards.length, added));
      if (fresh && l.cards.length) {
        track("import_completed", "direct");
        markImported();
      }
    } catch (e) {
      if (fresh) track("import_failed", "direct");
      notify(T.app.tgLoadFailed(telegramErrorText(e)));
      // Nothing came in on the first load: back to the start, where the export file still works.
      if (fresh && !l.cards.length) setLib(null);
    } finally {
      setJob(null);
      setRev((r) => r + 1);
    }
    if (ctl.signal.aborted || abortRef.current !== ctl) return;
    // AI only runs on its own after something new arrived, as after an import.
    if (fresh || added) await processAll(l);
    else nothingNew?.();
  }

  async function openDemo() {
    const next = demoLibrary();
    demoRef.current = true;
    setTelemetrySuspended(true);
    setDemo(true);
    setLib(next);
    setRev((r) => r + 1);
  }

  function exitDemo() {
    abortRef.current?.abort();
    demoRef.current = false;
    setTelemetrySuspended(false);
    setDemo(false);
    setLib(null);
  }

  const edit = useCallback(
    (ids: number[], patch: UserFields) => {
      if (!lib) return;
      const set = new Set(ids);
      for (const c of lib.cards) if (set.has(c.id)) c.user = { ...c.user, ...patch };
      setRev((r) => r + 1);
      if (demoRef.current) return;
      track("item_edited", "tags" in patch ? "tag" : "topic" in patch ? "topic" : "action" in patch ? "status" : "other");
      for (const id of ids) void appendEdit(makeEdit(id, patch)).catch((e) => notify(T.app.editFailed(String(e))));
    },
    [lib, notify],
  );

  async function doExport(kind: "csv" | "md", cards: Card[]) {
    const path = await platform.saveTextFile(
      kind === "csv" ? "saved-board.csv" : "saved-board.md",
      kind === "csv" ? { name: "CSV", ext: "csv" } : { name: "Markdown", ext: "md" },
      kind === "csv" ? toCsv(cards) : toMarkdown(cards, lib?.chatName),
    );
    if (!path) return;
    track("export_completed", kind);
    notify(T.app.exported(cards.length, path));
  }

  async function sendTelegram(opts: SendOptions) {
    const tg = platform.telegram;
    if (!lib || !tg) return;
    setShowTelegram(false);
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setSendingTg(true);
    try {
      const state = await loadBoardState();
      const res = await sendToTelegram(lib.cards, state, opts, {
        tg,
        save: saveBoardState,
        signal: ctl.signal,
        onProgress: (p) => setJob({ label: p.waitSeconds ? T.app.jobTelegramPause(p.waitSeconds) : T.app.jobTelegram, done: p.done, total: p.total }),
      });
      const missing = res.missing ? T.app.tgMissing(res.missing) : "";
      notify(ctl.signal.aborted ? T.app.tgStopped(res.done, res.total) : T.app.tgDone(res.done - res.missing, BOARD_TITLE) + missing);
    } catch (e) {
      notify(telegramErrorText(e));
      if (e instanceof TelegramAuthError) setShowTelegram(true);
    } finally {
      setSendingTg(false);
      setJob(null);
    }
  }

  function askConsent(): Promise<boolean> {
    return new Promise((resolve) => setConsent(() => (ok: boolean) => (setConsent(null), resolve(ok))));
  }

  async function applySettings(s: Settings) {
    if (s.aiConsentAt && !settingsRef.current.aiConsentAt) track("ai_consent_answered", "yes");
    setTelemetryEnabled(s.telemetry);
    await saveSettings(s);
    setLang(resolveLang(s.language));
    settingsRef.current = s;
    setSettings(s);
  }

  async function onSaveSettings(s: Settings, key: string | null) {
    await applySettings(s);
    if (key) {
      try {
        await setApiKey(key);
        setHasKey(true);
      } catch (e) {
        notify(T.app.keyFailed(String(e)));
      }
    }
    setShowSettings(false);
  }

  /** Saves the settings, then tags every already tagged card again with the chosen model. */
  async function onRetag(s: Settings, key: string | null) {
    await onSaveSettings(s, key);
    if (!lib || demoRef.current) return;
    const old = new Map<Card, NonNullable<Card["ai"]>>();
    for (const c of lib.cards) {
      if (!c.ai) continue;
      old.set(c, c.ai);
      c.ai = undefined;
    }
    // Put back what this run won't redo (hidden cards, photos when picture naming is off), so nothing loses its title.
    const redo = new Set([...pendingForAi(lib.cards), ...(s.aiImages ? pendingImages(lib.cards) : [])]);
    for (const [c, ai] of old) if (!redo.has(c)) c.ai = ai;
    setRev((r) => r + 1);
    void processAll(lib);
  }

  /** Back to the built-in key. */
  async function onForgetKey() {
    try {
      await deleteApiKey();
      setHasKey(false);
    } catch (e) {
      notify(T.app.keyFailed(String(e)));
    }
  }

  async function onWipe() {
    abortRef.current?.abort();
    await wipeAll();
    await deleteApiKey().catch(() => undefined);
    await platform.telegram?.forgetMedia().catch(() => undefined);
    await platform.telegram?.logout().catch(() => undefined);
    tgAutoRef.current = false;
    setHasKey(false);
    if (demoOnly) openDemo();
    else {
      setDemo(false);
      setLib(null);
    }
    setShowSettings(false);
    notify(T.app.wiped);
  }

  // Card names are read through the merges (lib/library.ts); set them before anything renders cards.
  const aliases = demo ? demoAliases : (settings.aliases ?? NO_ALIASES);
  setAliases(aliases);
  const ownTopics = demo ? demoTopics : (settings.topics ?? []);
  setOwnTopics(ownTopics);

  async function onAliases(a: Aliases) {
    await saveNames({ aliases: a });
  }

  /** Saves merges and the user's own topics: in settings, or only in memory in the demo. */
  async function saveNames(p: { aliases?: Aliases; topics?: string[] }) {
    if (demoRef.current) {
      if (p.aliases) setDemoAliases(p.aliases);
      if (p.topics) setDemoTopics(p.topics);
    } else {
      const s = { ...settingsRef.current, ...p };
      settingsRef.current = s;
      setSettings(s);
      try {
        await saveSettings(s);
      } catch (e) {
        notify(T.app.saveFailed(String(e)));
      }
    }
    if (p.aliases) setAliases(p.aliases);
    if (p.topics) setOwnTopics(p.topics);
    setRev((r) => r + 1);
  }

  /** Every topic shown now: the ones on cards and the user's own empty ones. */
  function allTopics(): string[] {
    const names = new Set(getOwnTopics());
    for (const c of lib?.cards ?? []) {
      const t = effectiveTopic(c);
      if (t) names.add(t);
    }
    return [...names];
  }

  /** A new empty topic made by hand. Returns the name it's shown under (an existing one in another case wins). */
  async function createTopic(raw: string): Promise<string> {
    const name = raw.trim().slice(0, 40);
    const same = findTopic(allTopics(), name);
    if (same) return same;
    // The name was merged away earlier: making it again by hand undoes that merge.
    let a = aliasesNow();
    if (Object.prototype.hasOwnProperty.call(a.topics, name)) {
      const { [name]: _gone, ...rest } = a.topics;
      a = { ...a, topics: rest };
    }
    await saveNames({ aliases: a, topics: [...ownTopicsNow(), name] });
    return name;
  }

  /** Renames a topic for every card in it, now and later (the AI's own name points at the new one). */
  async function renameTopic(from: string, raw: string): Promise<string> {
    const to = findTopic(allTopics().filter((t) => t !== from), raw) ?? raw.trim().slice(0, 40);
    if (!to || to === from) return from;
    const a = aliasesNow();
    const used = lib?.cards.some((c) => effectiveTopic(c) === from);
    const own = ownTopicsNow().filter((t) => topicName(t) !== from && topicName(t) !== to);
    if (lib?.subgroups?.[from]) {
      const { [from]: groups, ...rest } = lib.subgroups;
      lib.subgroups = rest[to] ? rest : { ...rest, [to]: groups };
      void persist(lib);
    }
    await saveNames({ aliases: used ? { ...a, topics: mergeAlias(a.topics, [from], to) } : a, topics: [...own, to] });
    return to;
  }

  /** Deletes a topic: its cards are left without one, and the AI won't be offered the name again. */
  async function deleteTopic(name: string) {
    if (!lib) return;
    const ids = lib.cards.filter((c) => effectiveTopic(c) === name).map((c) => c.id);
    if (ids.length) edit(ids, { topic: "" });
    if (lib.subgroups?.[name]) {
      const { [name]: _gone, ...rest } = lib.subgroups;
      lib.subgroups = rest;
      void persist(lib);
    }
    await saveNames({ topics: ownTopicsNow().filter((t) => topicName(t) !== name) });
  }

  /** Saves today's plan and the tasks set aside: in settings, or only in memory in the demo. */
  async function saveToday(p: { today?: TodayState; skips?: Skips }) {
    if (demoRef.current) {
      setDemoToday((d) => ({ today: p.today ?? d.today, skips: p.skips ?? d.skips }));
      return;
    }
    const s = { ...settingsRef.current, ...(p.today && { today: p.today }), ...(p.skips && { taskSkips: p.skips }) };
    settingsRef.current = s;
    setSettings(s);
    try {
      await saveSettings(s);
    } catch (e) {
      notify(T.app.saveFailed(String(e)));
    }
  }

  const aliasesNow = () => (demoRef.current ? demoAliases : (settingsRef.current.aliases ?? NO_ALIASES));
  const ownTopicsNow = () => (demoRef.current ? demoTopics : (settingsRef.current.topics ?? []));

  async function askSynonyms(kind: "topics" | "tags", counts: Map<string, number>) {
    if (!aiAllowed(settingsRef.current) || demoRef.current) return []; // nothing leaves without consent
    try {
      return await suggestSynonyms(await getAiAuth(), aiModelOf(settingsRef.current.aiModel), kind, counts);
    } catch (e) {
      throw new Error(e instanceof AiStop ? e.message : T.app.aiError(String(e)));
    }
  }

  /** Splits one topic into AI subgroups and keeps them in the library. Errors come back as readable messages. */
  async function groupTopic(topic: string) {
    if (!lib || !aiAllowed(settingsRef.current) || demoRef.current) return; // nothing leaves without consent
    const cards = lib.cards.filter((c) => !c.removed && matchesFilter(c, "all") && effectiveTopic(c) === topic);
    try {
      const groups = await groupCards(await getAiAuth(), aiModelOf(settingsRef.current.aiModel), aiLang(), topic, cards, displayTitle, effectiveTags);
      lib.subgroups = { ...lib.subgroups, [topic]: { at: new Date().toISOString(), groups } };
      await persist(lib);
      setRev((r) => r + 1);
    } catch (e) {
      throw new Error(e instanceof AiStop ? e.message : T.app.aiError(String(e)));
    }
  }

  if (loading) return <div className="center">{T.common.loading}</div>;

  const needAi = lib ? pendingForAi(lib.cards).length + (settings.aiImages ? pendingImages(lib.cards).length : 0) : 0;
  const settingsDialog = showSettings && <SettingsDialog settings={settings} hasKey={hasKey} version={version} onSave={onSaveSettings} onRetag={onRetag} retagCount={lib && !demo ? retagCount(lib.cards) : 0} onWipe={onWipe} onForgetKey={onForgetKey} onClose={() => setShowSettings(false)} />;

  const consentDialog = consent && <AiConsentDialog hasKey={hasKey} onAllow={() => consent(true)} onDecline={() => consent(false)} />;

  const banners = (
    <>
      {demoOnly && (
        <div className="banner demo">
          <span className="wide-only">{T.app.webDemoBanner}</span>
          <span className="narrow-only">{T.app.webDemoBannerShort}</span>
          <a className="banner-link" href="/download">
            {T.app.webDemoDownload}
          </a>
        </div>
      )}
      {isWeb && !demoOnly && (
        <div className="banner web">
          {T.app.webBanner(version)}
        </div>
      )}
      {demo && !demoOnly && (
        <div className="banner demo">
          {T.app.demoBanner}
          <button className="small" onClick={exitDemo}>
            {T.app.demoExit}
          </button>
        </div>
      )}
      {update && (
        <div className="banner update">
          {updating === false ? (
            <>
              {T.app.updateAvailable(update.version)}
              <button className="small" onClick={installUpdate}>
                {T.app.updateInstall}
              </button>
              <button className="secondary small" onClick={updateLater}>
                {T.app.updateLater}
              </button>
            </>
          ) : (
            <>{T.app.updateDownloading(updating)}</>
          )}
        </div>
      )}
    </>
  );

  if (!lib) {
    return (
      <Welcome
        tg={platform.telegram}
        showDemo
        onImport={doImport}
        onSignedIn={(auto) => {
          // On its own only once per launch, so a failed load doesn't loop back here and retry forever.
          if (auto && tgAutoRef.current) return;
          tgAutoRef.current = true;
          void syncTelegram(emptyTelegramLibrary(), true);
        }}
        onDemo={openDemo}
        telemetry={telemetrySupported() ? settings.telemetry : undefined}
        onTelemetry={(on) => void applySettings({ ...settingsRef.current, telemetry: on })}
        onSettings={() => setShowSettings(true)}
        onLanguage={(l) => void onSaveSettings({ ...settingsRef.current, language: l }, null)}
        openUrl={(u) => void platform.openUrl(u)}
        top={banners}
      >
        {settingsDialog}
        {consentDialog}
        <Toast text={toast} onClose={() => setToast(null)} />
      </Welcome>
    );
  }

  return (
    <div className="app">
      {banners}
      <Workspace
        lib={lib}
        rev={rev}
        tgAccount={tgAccount}
        job={job}
        needAi={demo ? 0 : needAi}
        aiEnabled={aiAllowed(settings)}
        onImport={demo ? undefined : doImport}
        onExport={doExport}
        onSettings={() => setShowSettings(true)}
        onTelegram={platform.telegram && !demo ? () => setShowTelegram(true) : undefined}
        onRunAi={() => processAll(lib)}
        onNameImage={aiAllowed(settings) && !demo ? nameOne : undefined}
        onStop={() => abortRef.current?.abort()}
        onEdit={edit}
        aliases={aliases}
        onAliases={onAliases}
        askSynonyms={aiAllowed(settings) && !demo ? askSynonyms : undefined}
        onGroupTopic={aiAllowed(settings) && !demo ? groupTopic : undefined}
        onCreateTopic={createTopic}
        onRenameTopic={renameTopic}
        onDeleteTopic={deleteTopic}
        today={demo ? demoToday.today : settings.today}
        taskSkips={demo ? demoToday.skips : (settings.taskSkips ?? {})}
        onToday={saveToday}
      />
      {settingsDialog}
      {consentDialog}
      {showTelegram && platform.telegram && (
        <TelegramDialog tg={platform.telegram} cards={lib.cards} running={sendingTg} onStart={sendTelegram} onOpenSettings={() => (setShowTelegram(false), setShowSettings(true))} onClose={() => setShowTelegram(false)} />
      )}
      <Toast text={toast} onClose={() => setToast(null)} />
    </div>
  );
}
