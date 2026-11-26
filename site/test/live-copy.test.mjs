import { test } from "node:test";
import assert from "node:assert/strict";
import { inPreview, pagePath, previewSwitch, withSiteCopy } from "../src/live-copy.mjs";

test("pages are keyed by path without a trailing slash, like the agent stores them", () => {
  assert.equal(pagePath("/services/"), "/services");
  assert.equal(pagePath("/services"), "/services");
  assert.equal(pagePath("/"), "/");
});

test("?preview=1 turns Preview on with a cookie and ?preview=0 turns it off, keeping the page", () => {
  const on = previewSwitch(new URL("https://site.example/services/?preview=1&x=2"));
  assert.equal(on.location, "/services/?x=2");
  assert.match(on.cookie, /^nl_preview=1; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  const off = previewSwitch(new URL("https://site.example/?preview=0"));
  assert.equal(off.location, "/");
  assert.match(off.cookie, /Max-Age=0/);
  assert.equal(previewSwitch(new URL("https://site.example/?preview=yes")), null);
  assert.equal(inPreview(new Request("https://site.example/", { headers: { cookie: "a=b; nl_preview=1" } })), true);
  assert.equal(inPreview(new Request("https://site.example/", { headers: { cookie: "nl_preview=0" } })), false);
});

test("the switch redirects without serving the page", async () => {
  let served = false;
  const response = await withSiteCopy(new Request("https://site.example/about/?preview=1"), {}, () => { served = true; });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/about/");
  assert.equal(served, false);
});

test("files that are not pages, and sites not linked to Northlight, pass through untouched", async () => {
  const css = new Response("body{}", { headers: { "content-type": "text/css" } });
  const env = { NORTHLIGHT_CLIENT: "kestrel", SITE_COPY: { pages() { throw new Error("not for CSS"); } } };
  assert.equal(await withSiteCopy(new Request("https://site.example/styles.css"), env, () => css), css);
  const page = new Response("<title>Old</title>", { headers: { "content-type": "text/html" } });
  assert.equal(await withSiteCopy(new Request("https://site.example/"), {}, () => page), page);
});

test("a live page with no approved copy, or a copy service that fails, serves the built page", async () => {
  for (const pages of [() => ({}), () => { throw new Error("down"); }]) {
    const page = new Response("<title>Built</title>", { headers: { "content-type": "text/html; charset=utf-8" } });
    const env = { NORTHLIGHT_CLIENT: "kestrel", SITE_COPY: { pages } };
    assert.equal(await withSiteCopy(new Request("https://site.example/"), env, () => page), page);
  }
});
