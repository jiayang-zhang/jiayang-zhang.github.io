import { dashboardConfig } from "../../../shared/config";
import { htmlToText } from "../clinical/text";
import { fetchText } from "../lib/http";

// Optional supplementary source: company press-release feeds listed in
// configuration. Only the text the feed itself carries is used; linked pages
// are never fetched, so nothing is scraped.

export interface FeedItem {
  title: string;
  link: string;
  /** YYYY-MM-DD, or null when the feed gives no usable date. */
  date: string | null;
  text: string;
}

export interface NewsProvider {
  fetchFeed(url: string): Promise<FeedItem[]>;
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return null;
  return m[1]!.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

/** Parses RSS 2.0 and Atom. Malformed items are skipped rather than failing the feed. */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = tag(block, "title");
    const link = tag(block, "link") || block.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] || null;
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    const rawDate = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated");
    const parsed = rawDate ? new Date(rawDate) : null;
    const body = tag(block, "content:encoded") ?? tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content") ?? "";
    items.push({
      title: htmlToText(title),
      link: link.trim(),
      date: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null,
      text: `${htmlToText(title)}\n\n${htmlToText(htmlToText(body))}`,
    });
  }
  return items;
}

export function createNewsProvider(deps: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): NewsProvider {
  const { timeoutMs, retries, backoffBaseMs } = dashboardConfig.network;
  return {
    async fetchFeed(url) {
      return parseFeed(await fetchText(url, { timeoutMs, retries, backoffBaseMs, ...deps }));
    },
  };
}
