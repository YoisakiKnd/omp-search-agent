import { describe, expect, test } from "bun:test";
import { extractSources, splitText, toTelegramHtml } from "../src/format.ts";

describe("format", () => {
  test("escapes HTML and links URLs", () => {
    expect(toTelegramHtml("<x> https://example.com/a?x=1&y=2")).toContain("&lt;x&gt;");
    expect(toTelegramHtml("https://example.com")).toContain("<a href=");
  });
  test("extracts unique sources", () => expect(extractSources("https://a.test x https://a.test")).toEqual(["https://a.test"]));
  test("splits long output", () => expect(splitText("x".repeat(100), 20).length).toBeGreaterThan(1));
});
