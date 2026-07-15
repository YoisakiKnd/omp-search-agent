import { describe, expect, test } from "bun:test";
import { extractSources, splitText, stripSourceUrls, toTelegramHtml } from "../src/format.ts";

describe("format", () => {
  test("escapes HTML and links URLs", () => {
    expect(toTelegramHtml("<x> https://example.com/a?x=1&y=2")).toContain("&lt;x&gt;");
    expect(toTelegramHtml("https://example.com")).toContain("<a href=");
  });
  test("extracts unique sources", () => expect(extractSources("https://a.test x https://a.test")).toEqual(["https://a.test"]));
  test("removes source URLs from the rendered body", () => {
    expect(stripSourceUrls("结论。\n\n参考：https://a.test/x?q=1")).toBe("结论。\n\n参考：");
    expect(stripSourceUrls("参见 [官方文档](https://a.test/docs)。")).toBe("参见 官方文档。");
  });
  test("splits long output", () => expect(splitText("x".repeat(100), 20).length).toBeGreaterThan(1));
});
