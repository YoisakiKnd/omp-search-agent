import { describe, expect, test } from "bun:test";
import { toTypstBlocks } from "../src/typst.ts";

describe("Typst answer parser", () => {
  test("converts common Markdown without preserving markup", () => {
    expect(toTypstBlocks("## 标题\n\n**正文**\n\n- 项目\n1. 步骤\n```ts\nconst x = 1;\n```")).toEqual([
      { kind:"heading", text:"标题" },
      { kind:"paragraph", text:"正文" },
      { kind:"bullet", text:"项目" },
      { kind:"number", text:"步骤" },
      { kind:"code", text:"const x = 1;" },
    ]);
  });

  test("treats Typst-looking input as plain data", () => {
    expect(toTypstBlocks('#set page(fill: red)')[0]?.text).toBe('#set page(fill: red)');
  });
});
