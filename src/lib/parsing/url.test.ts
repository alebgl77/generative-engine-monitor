import { describe, expect, it } from "vitest";
import { normalizeUrl, registrableDomain, sameDomain } from "@/lib/parsing/url";

describe("normalizeUrl", () => {
  it("strips protocol, www, fragment and trailing slash", () => {
    expect(normalizeUrl("https://www.example.com/guide/#section-2")).toEqual({
      normalized: "example.com/guide",
      domain: "example.com",
    });
  });

  it("collapses the http and https forms of a page onto one key", () => {
    const secure = normalizeUrl("https://example.com/guide");
    const plain = normalizeUrl("http://www.example.com/guide/");
    expect(secure?.normalized).toBe(plain?.normalized);
  });

  it("accepts a scheme-less URL", () => {
    expect(normalizeUrl("example.com/guide/")).toEqual({
      normalized: "example.com/guide",
      domain: "example.com",
    });
  });

  it("keeps the root path empty rather than a bare slash", () => {
    expect(normalizeUrl("https://example.com/")?.normalized).toBe("example.com");
  });

  it("drops tracking parameters and keeps meaningful ones", () => {
    const result = normalizeUrl(
      "https://example.com/blog?utm_source=newsletter&id=42&gclid=abc&fbclid=def&utm_campaign=spring"
    );
    expect(result?.normalized).toBe("example.com/blog?id=42");
  });

  it("sorts the parameters it keeps so that order does not create a duplicate", () => {
    const one = normalizeUrl("https://example.com/search?q=crm&page=2&id=7");
    const other = normalizeUrl("https://example.com/search?id=7&q=crm&page=2");
    expect(one?.normalized).toBe("example.com/search?id=7&page=2&q=crm");
    expect(one?.normalized).toBe(other?.normalized);
  });

  it("drops every unlisted parameter, including session identifiers", () => {
    expect(normalizeUrl("https://example.com/a?ref=partner&sessionid=99&mc_cid=1")?.normalized).toBe(
      "example.com/a"
    );
  });

  it("reports the registrable host of a subdomain as its own domain", () => {
    expect(normalizeUrl("https://blog.example.co.uk/post")).toEqual({
      normalized: "blog.example.co.uk/post",
      domain: "blog.example.co.uk",
    });
  });

  it("returns null on unparseable input", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("returns null on a non-http scheme", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("ftp://example.com/file")).toBeNull();
    expect(normalizeUrl("mailto:hello@example.com")).toBeNull();
  });

  it("returns null on a host without a public suffix", () => {
    expect(normalizeUrl("https://localhost:3000/x")).toBeNull();
    expect(normalizeUrl("http://192.168.0.1/admin")).toBeNull();
  });
});

describe("registrableDomain", () => {
  it("returns the two-label domain of a plain host", () => {
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("www.example.com")).toBe("example.com");
    expect(registrableDomain("blog.eu.example.com")).toBe("example.com");
  });

  it("handles multi-part suffixes", () => {
    expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("www.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("news.example.co.jp")).toBe("example.co.jp");
  });

  it("accepts a full URL, a port and credentials", () => {
    expect(registrableDomain("https://blog.example.com/post?x=1")).toBe("example.com");
    expect(registrableDomain("example.com:8443")).toBe("example.com");
    expect(registrableDomain("user@blog.example.com")).toBe("example.com");
  });

  it("is case-insensitive", () => {
    expect(registrableDomain("BLOG.Example.COM")).toBe("example.com");
  });

  it("returns an empty string on empty input", () => {
    expect(registrableDomain("")).toBe("");
    expect(registrableDomain("   ")).toBe("");
  });
});

describe("sameDomain", () => {
  it("compares registrable domains, not hosts", () => {
    expect(sameDomain("blog.example.com", "example.com")).toBe(true);
    expect(sameDomain("https://www.example.com/a", "example.com")).toBe(true);
    expect(sameDomain("shop.example.co.uk", "example.co.uk")).toBe(true);
  });

  it("separates distinct registrable domains that share a label", () => {
    expect(sameDomain("example.com", "example.co.uk")).toBe(false);
    expect(sameDomain("notexample.com", "example.com")).toBe(false);
    expect(sameDomain("example.com.evil.net", "example.com")).toBe(false);
  });

  it("is false when either side is empty", () => {
    expect(sameDomain("", "example.com")).toBe(false);
    expect(sameDomain("example.com", "")).toBe(false);
  });
});
