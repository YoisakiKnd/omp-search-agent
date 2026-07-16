const urlPattern = /https?:\/\/[^\s<>]+/g;

export interface SourceLink { label: string; url: string }

function cleanUrl(url: string) { return url.replace(/[),.;!?]+$/, ""); }

function fallbackLabel(url: string) {
  try {
    const parsed = new URL(url);
    const label = parsed.hostname.replace(/^www\./, "") + (parsed.pathname !== "/" ? parsed.pathname.replace(/\/$/, "") : "");
    return label.length > 120 ? `${label.slice(0,117)}…` : label;
  } catch { return url; }
}

export function extractSourceLinks(text: string): SourceLink[] {
  const labels = new Map<string,string>();
  for (const match of text.matchAll(/\[([^\]\n]{1,200})]\((https?:\/\/[^)\s<>]+)\)/g)) {
    const url = cleanUrl(match[2]!);
    const label = match[1]!.replace(/[*_`~]/g, "").trim();
    if (label && !/^(来源|链接|source|link)$/i.test(label)) labels.set(url,label);
  }
  const seen = new Set<string>(), result: SourceLink[] = [];
  for (const raw of text.match(urlPattern) ?? []) {
    const url = cleanUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url); result.push({ label:labels.get(url) ?? fallbackLabel(url), url });
    if (result.length === 20) break;
  }
  return result;
}

export function extractSources(text: string): string[] {
  return extractSourceLinks(text).map(source=>source.url);
}

export function independentSourceCount(text: string): number {
  const hosts = new Set<string>();
  for (const { url } of extractSourceLinks(text)) {
    try { hosts.add(new URL(url).hostname.toLowerCase().replace(/^www\./, "")); } catch {}
  }
  return hosts.size;
}

export function stripSourceUrls(text: string): string {
  const lines = text.replaceAll("\r\n","\n").split("\n");
  const sourceHeading = lines.findIndex((line,index) =>
    /^(?:#{1,6}\s*)?(?:参考(?:来源|链接|资料)|来源|references|sources)\s*[:：]?\s*$/i.test(line.trim())
    && lines.slice(index+1).some(item=>/https?:\/\//.test(item))
  );
  const body = (sourceHeading >= 0 ? lines.slice(0,sourceHeading) : lines).join("\n");
  return body
    .replace(/\[([^\]]+)]\(https?:\/\/[^)\s<>]+\)/g, "$1")
    .replace(urlPattern, "")
    .replace(/^(?:[-*]\s*)?(?:参考(?:来源|链接|资料)?|来源)\s*[:：]?\s*$/gmi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function toTelegramHtml(text: string): string {
  let out = "", last = 0;
  for (const match of text.matchAll(urlPattern)) {
    const index = match.index!;
    const raw = match[0].replace(/[),.;!?]+$/, "");
    out += escapeHtml(text.slice(last, index));
    const safe = escapeHtml(raw).replaceAll('"', "&quot;");
    out += `<a href="${safe}">${safe}</a>`;
    last = index + raw.length;
  }
  return out + escapeHtml(text.slice(last));
}

export function splitText(text: string, limit = 3400): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : ["未生成回答。"];
}
