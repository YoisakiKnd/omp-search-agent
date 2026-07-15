const urlPattern = /https?:\/\/[^\s<>]+/g;

export function extractSources(text: string): string[] {
  return [...new Set(text.match(urlPattern)?.map(x => x.replace(/[),.;!?]+$/, "")) ?? [])].slice(0, 20);
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
