import { describe, expect, test } from "bun:test";
import { extractSourceLinks, extractSources, independentSourceCount, splitText, stripSourceUrls, toTelegramHtml } from "../src/format.ts";

describe("format", () => {
  test("escapes HTML and links URLs", () => {
    expect(toTelegramHtml("<x> https://example.com/a?x=1&y=2")).toContain("&lt;x&gt;");
    expect(toTelegramHtml("https://example.com")).toContain("<a href=");
  });
  test("extracts unique sources", () => expect(extractSources("https://a.test x https://a.test")).toEqual(["https://a.test"]));
  test("counts independent source domains instead of URL count", () => {
    expect(independentSourceCount("https://a.test/1 https://www.a.test/2 https://b.test/x")).toBe(2);
  });
  test("keeps human-readable source labels", () => {
    expect(extractSourceLinks("- [Typst PNG 文档](https://typst.app/docs/reference/png/)\n- https://example.com/news")).toEqual([
      { label:"Typst PNG 文档", url:"https://typst.app/docs/reference/png/" },
      { label:"example.com/news", url:"https://example.com/news" },
    ]);
  });
  test("removes source URLs from the rendered body", () => {
    expect(stripSourceUrls("结论。\n\n参考：https://a.test/x?q=1")).toBe("结论。");
    expect(stripSourceUrls("参见 [官方文档](https://a.test/docs)。")).toBe("参见 官方文档。");
    expect(stripSourceUrls("正文 [1]\n\n## 参考来源\n- [官方文档](https://a.test/docs)")).toBe("正文 [1]");
  });
  test("splits long output", () => expect(splitText("x".repeat(100), 20).length).toBeGreaterThan(1));
});
