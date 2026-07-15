import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

export interface TypstBlock { kind: "heading" | "paragraph" | "bullet" | "number" | "code"; text: string }

function cleanInline(text: string) {
  return text
    .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .trim();
}

export function toTypstBlocks(input: string): TypstBlock[] {
  const blocks: TypstBlock[] = [];
  let paragraph: string[] = [], code: string[] = [], inCode = false;
  const flushParagraph = () => {
    const text = cleanInline(paragraph.join(" "));
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };
  const flushCode = () => {
    if (code.length) blocks.push({ kind: "code", text: code.join("\n") });
    code = [];
  };
  for (const rawLine of input.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (/^```/.test(line.trim())) {
      if (inCode) flushCode(); else flushParagraph();
      inCode = !inCode; continue;
    }
    if (inCode) { code.push(rawLine); continue; }
    if (!line.trim()) { flushParagraph(); continue; }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const number = line.match(/^\s*\d+[.)、]\s+(.+)$/);
    if (heading) { flushParagraph(); blocks.push({ kind:"heading", text:cleanInline(heading[1]!) }); }
    else if (bullet) { flushParagraph(); blocks.push({ kind:"bullet", text:cleanInline(bullet[1]!) }); }
    else if (number) { flushParagraph(); blocks.push({ kind:"number", text:cleanInline(number[1]!) }); }
    else paragraph.push(line.trim());
  }
  if (inCode) flushCode();
  flushParagraph();
  return blocks.length ? blocks : [{ kind:"paragraph", text:"未生成可显示的回答。" }];
}

const TEMPLATE = `#let data = json("answer.json")
#set page(paper: "a4", margin: (x: 18mm, y: 16mm), fill: rgb("#f8fafc"))
#set text(font: ("Noto Sans CJK SC", "Noto Sans CJK", "Noto Sans"), size: 10.5pt, fill: rgb("#172033"), lang: "zh")
#set par(justify: true, leading: 0.72em)
#set heading(numbering: none)

#align(center)[
  #text(size: 15pt, weight: "bold", fill: rgb("#3157a4"))[搜索回答]
]
#line(length: 100%, stroke: 0.8pt + rgb("#b8c6e5"))
#v(8pt)

#for item in data.blocks {
  if item.kind == "heading" {
    heading(level: 2, outlined: false)[#text(item.text, weight: "bold", fill: rgb("#27447d"))]
  } else if item.kind == "bullet" {
    block(breakable: true, inset: (left: 5pt, bottom: 5pt))[
      #box(width: 14pt)[#text(fill: rgb("#3157a4"))[•]]#text(item.text)
    ]
  } else if item.kind == "number" {
    block(breakable: true, inset: (left: 5pt, bottom: 5pt))[
      #box(width: 14pt)[#text(fill: rgb("#3157a4"))[›]]#text(item.text)
    ]
  } else if item.kind == "code" {
    block(width: 100%, breakable: true, fill: rgb("#e9eef8"), radius: 4pt, inset: 8pt)[
      #raw(item.text, block: true)
    ]
    v(6pt)
  } else {
    block(breakable: true, inset: (bottom: 7pt))[#text(item.text)]
  }
}
`;

export class TypstRenderer {
  constructor(private config: Config) {}

  async render(answer: string): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
    const root = join(this.config.DATA_DIR, "renders"); await mkdir(root,{recursive:true});
    const dir = await mkdtemp(join(root,"answer-"));
    const clipped = answer.length > this.config.TYPST_MAX_CHARS ? `${answer.slice(0,this.config.TYPST_MAX_CHARS)}\n\n（回答过长，已截断）` : answer;
    await writeFile(join(dir,"answer.json"),JSON.stringify({blocks:toTypstBlocks(clipped)}));
    await writeFile(join(dir,"main.typ"),TEMPLATE);
    const proc = Bun.spawn(["typst","compile","--format","png","--ppi",String(this.config.TYPST_PPI),"main.typ","page-{0p}.png"],{
      cwd:dir, stdout:"ignore", stderr:"pipe",
    });
    const timeout = setTimeout(()=>proc.kill(),20_000);
    const exitCode = await proc.exited; clearTimeout(timeout);
    if (exitCode !== 0) {
      const error = await new Response(proc.stderr).text(); await rm(dir,{recursive:true,force:true});
      throw new Error(`Typst render failed: ${error.slice(0,1000)}`);
    }
    const names = (await readdir(dir)).filter(x=>/^page-\d+\.png$/.test(x)).sort();
    if (!names.length) { await rm(dir,{recursive:true,force:true}); throw new Error("Typst produced no PNG pages"); }
    if (names.length > this.config.TYPST_MAX_PAGES) { await rm(dir,{recursive:true,force:true}); throw new Error("Typst answer exceeded the page limit"); }
    return { paths:names.map(x=>join(dir,x)), cleanup:()=>rm(dir,{recursive:true,force:true}) };
  }
}
