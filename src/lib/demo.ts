// Sample library for the browser build's demo button: lets you see the grid without an export.
import fixture from "../../fixtures/saved_messages.json";
import { parseExport } from "./parser";
import { annotateContext } from "./library";
import type { Library } from "./types";
import { T } from "../i18n";

const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;");

/**
 * Earthy hues that sit next to Kipple's coral, cream and ink: terracotta, ochre, olive, sage,
 * teal, slate, plum, sand. Kept muted so screenshots of the demo stay calm.
 */
const HUES = [14, 38, 70, 140, 178, 212, 330, 28];
const hueAt = (seed: number) => HUES[Math.abs(seed) % HUES.length];

/** Splits a headline into lines of about `max` characters, at most three. */
function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + " " + word).length <= max) lines[lines.length - 1] = last + " " + word;
    else lines.push(word);
  }
  return lines.length > 3 ? [...lines.slice(0, 2), lines[2] + "…"] : lines;
}

/**
 * A made-up link preview in the style of a site's og:image: a tinted picture with soft shapes,
 * the headline and the site. Drawn here, so the demo needs nothing from the network.
 */
function ogImage(seed: number, title: string, site: string): string {
  const h = hueAt(seed);
  const h2 = (h + 18) % 360;
  const lines = wrap(title, 20);
  const top = 315 - (lines.length * 68) / 2 + 48;
  const text = lines.map((l, k) => `<tspan x='150' y='${top + k * 68}'>${xml(l)}</tspan>`).join("");
  const cx = 860 + ((seed * 31) % 160);
  const cy = 200 + ((seed * 17) % 220);
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='630' viewBox='0 0 1200 630'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h},22%,22%)'/><stop offset='1' stop-color='hsl(${h2},26%,34%)'/></linearGradient></defs>` +
      `<rect width='1200' height='630' fill='url(#g)'/>` +
      `<circle cx='${cx}' cy='${cy}' r='230' fill='hsl(${h2},35%,60%)' opacity='.3'/>` +
      `<circle cx='${cx + 120}' cy='${cy + 190}' r='130' fill='hsl(${h},40%,72%)' opacity='.22'/>` +
      `<rect x='${cx - 150}' y='${cy - 40}' width='260' height='170' rx='22' fill='hsl(${h},30%,92%)' opacity='.18' transform='rotate(-8 ${cx} ${cy})'/>` +
      `<text font-family='system-ui,-apple-system,Segoe UI,Roboto,sans-serif' font-size='56' font-weight='700' fill='white' letter-spacing='-1'>${text}</text>` +
      `<text x='150' y='110' font-family='system-ui,-apple-system,Segoe UI,Roboto,sans-serif' font-size='26' font-weight='600' fill='white' opacity='.75'>${xml(site)}</text>` +
      `<rect x='150' y='520' width='64' height='6' rx='3' fill='white' opacity='.6'/>` +
      `</svg>`,
  )}`;
}

/** A made-up picture for the demo's photos and video frames: a landscape with a sun. */
function videoFrame(seed: number, w: number, h: number): string {
  const hue = hueAt(seed);
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>` +
      `<defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='hsl(${hue},28%,74%)'/><stop offset='1' stop-color='hsl(${(hue + 20) % 360},35%,88%)'/></linearGradient></defs>` +
      `<rect width='100%' height='100%' fill='url(#s)'/>` +
      `<circle cx='${w * 0.68}' cy='${h * 0.42}' r='${h * 0.14}' fill='hsl(36,60%,94%)'/>` +
      `<path d='M0 ${h * 0.62} Q ${w * 0.25} ${h * 0.5} ${w * 0.5} ${h * 0.6} T ${w} ${h * 0.56} V ${h} H 0 Z' fill='hsl(${(hue + 160) % 360},16%,40%)'/>` +
      `<path d='M0 ${h * 0.76} Q ${w * 0.3} ${h * 0.68} ${w * 0.6} ${h * 0.78} T ${w} ${h * 0.74} V ${h} H 0 Z' fill='hsl(${(hue + 170) % 360},18%,27%)'/>` +
      `</svg>`,
  )}`;
}

// A one-page PDF and a text file, so the in-card previews can be tried in the browser build.
const DEMO_PDF = "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA0MjAgMjk3XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxMDQgPj4Kc3RyZWFtCkJUIC9GMSAyMiBUZiA0MCAyMjAgVGQgKERlbW8gcmVwb3J0KSBUaiAwIC0zNiBUZCAvRjEgMTIgVGYgKFRoaXMgUERGIG9wZW5zIHJpZ2h0IGluc2lkZSB0aGUgY2FyZC4pIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzk2IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDY2CiUlRU9GCg==";

export function demoLibrary(): Library {
  const D = T.demo;
  // The sample export is in Russian; its texts come from the dictionary, so the English demo reads in English.
  const base = parseExport(fixture).cards.map((c) => ({
    ...c,
    text: D.messages[c.id] ?? c.text,
    forwardedFrom: c.forwardedFrom ? D.channel : c.forwardedFrom,
  }));
  const DEMO_BLOG = "blog.example.org";
  const DEMO_TXT = `data:text/plain;charset=utf-8,${encodeURIComponent(D.textBody)}`;
  const topics = D.topics;
  const cards = Array.from({ length: 60 }, (_, i) => {
    const c = structuredClone(base[i % base.length]);
    c.id = i + 1;
    // The sample repeats; make the repeats distinct so only one pair shows up as a duplicate.
    if (i >= base.length && i !== base.length) {
      if (c.urls.length) c.urls = [`https://example.com/article-${i}`];
      if (c.media?.size) c.media = { ...c.media, size: c.media.size + i };
      else if (c.text) c.text += "\u200b".repeat(i); // invisible, but the texts no longer match
    }
    if (c.kind === "link") c.link = { url: c.urls[0], title: D.article(i), siteName: "example.com", fetchedAt: "" };
    if (c.kind === "photo") {
      c.link = undefined;
      const [w, h] = i % 2 ? [800, 1000] : [1200, 800];
      c.media = { ...c.media, path: videoFrame(i * 3, w, h), width: w, height: h, missing: false };
      // Some photos are albums of phone screenshots, to show the carousel.
      c.album = i % 18 === 2 ? [1, 2, 3, 4].map((k) => ({ path: videoFrame(i * 3 + k, 390, 844), width: 390, height: 844 })) : undefined;
      if (c.album) c.media = { ...c.media, path: videoFrame(i * 3, 390, 844), width: 390, height: 844 };
    }
    if (c.kind === "video") c.media = { ...c.media, thumb: videoFrame(i, 1280, 720), width: 1280, height: 720, missing: false };
    if (c.kind === "document") {
      const txt = i % 2 === 1;
      c.media = { ...c.media, path: txt ? DEMO_TXT : DEMO_PDF, fileName: txt ? D.textFile : "report.pdf", mime: txt ? "text/plain" : "application/pdf", missing: false };
    }
    // Some photos stay without a caption and AI name, to show the fallback titles.
    const uncaptioned = c.kind === "photo" && i % 2 === 0;
    if (uncaptioned) c.text = "";
    if (!c.autoJunk && !c.sensitive && !uncaptioned)
      c.ai = {
        title: D.card(i, c.kind),
        summary: D.summary,
        // …and a topic written in lower case, so there's a topic to tidy too.
        topic: i % 20 === 7 ? topics[i % 5].toLocaleLowerCase() : topics[i % 5],
        // A few cards carry a near-copy of a tag ("reference" next to "references"), for "Tidy up" to find.
        tags: i % 10 === 3 ? [D.tags[0], D.tags[2].slice(0, -1)] : D.tags.slice(0, (i % 3) + 1),
        action: (["read_later", "idea", "reference", "todo"] as const)[i % 4],
        priority: i % 6 === 0 ? 1 : 2,
        model: "demo",
        at: "",
      };
    // A saved Instagram reel and a YouTube video, to show the in-card player.
    if (i === 2) {
      c.kind = "link";
      c.media = undefined;
      c.album = undefined;
      c.urls = ["https://www.instagram.com/reel/C9demoReel1/"];
      c.text = c.urls[0];
      c.link = { url: c.urls[0], title: D.reelTitle, description: D.reelDescription, siteName: "Instagram", image: videoFrame(17, 720, 1280), fetchedAt: "" };
      c.ai = undefined; // not tagged yet: the heading comes from the caption
    }
    if (i === 13) {
      c.kind = "link";
      c.media = undefined;
      c.album = undefined;
      c.urls = ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"];
      c.text = c.urls[0];
      c.link = { url: c.urls[0], title: D.videoTitle, description: "Kipple Lab", siteName: "YouTube", fetchedAt: "" };
    }
    // Every site gives a preview picture here; the placeholder is for pages that don't.
    if (c.kind === "link" && c.link && !c.link.image && !c.urls[0].includes("youtube.com")) c.link.image = ogImage(i, c.ai?.title ?? c.link.title ?? "", c.link.siteName ?? "");
    // Spread over the last two months, so "Recent" has something but not everything.
    c.date = new Date(Date.now() - 60 * 864e5 + i * 864e5 + (i % 5) * 3_600_000).toISOString();
    // …except a few "read later" saved months ago, for "Still worth reading?" in "Three for today".
    if (i < 12 && i % 4 === 0) c.date = new Date(Date.now() - (200 - i * 8) * 864e5).toISOString();
    return c;
  });
  // A one-line note, like most real Saved Messages: the AI title and summary say more than the message.
  const short = structuredClone(base.find((c) => c.kind === "text" && !c.urls.length) ?? base[0]);
  Object.assign(short, { id: 61, text: D.short.text, urls: [], link: undefined, media: undefined, forwardedFrom: undefined, sensitive: false, autoJunk: false, date: new Date(Date.now() - 3_600_000).toISOString() });
  short.ai = { title: D.short.title, summary: D.short.summary, topic: D.short.topic, tags: D.short.tags, action: "todo", priority: 2, model: "claude-haiku-5-5", at: "" };
  cards.push(short);
  // Four articles from one blog still without a topic, so "Three for today" has a site to sort.
  for (const c of cards.filter((c) => c.kind === "link" && c.id > base.length + 1 && c.ai && !c.urls[0].includes("youtube")).slice(0, 4)) {
    c.urls = [`https://${DEMO_BLOG}/post-${c.id}`];
    c.link = { ...c.link!, url: c.urls[0], siteName: DEMO_BLOG };
    c.ai = { ...c.ai!, topic: "" };
  }
  cards.reverse(); // the library is kept newest first
  annotateContext(cards);
  // The first topic comes already split into AI subgroups, to show how that looks.
  const first = cards.filter((c) => c.ai?.topic === topics[0]).map((c) => c.id);
  const half = Math.ceil(first.length / 2);
  const subgroups = { [topics[0]]: { at: "", groups: D.groups.map((name, i) => ({ name, ids: first.slice(i * half, (i + 1) * half) })) } };
  return { version: 1, chatName: D.chatName, sourceDir: "demo", importedAt: new Date().toISOString(), cards, subgroups };
}
