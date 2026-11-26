import { describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents";
import { reviewPage } from "../agents/iris";
import { CLIENTS } from "../clients";
import type { ToolContext } from "../src/contracts";
import { TOOLS } from "../tools";

describe("Kestrel's website manager", () => {
  const client = CLIENTS.find(c => c.id === "kestrel")!;
  const services = new URL("/services/", String(client.agentSettings!.iris.site)).href;
  it("assigns one agent with website and SEO tools", () => {
    expect(client.agents).toEqual(["iris"]);
    const agent = AGENTS["iris"];
    expect(agent.name).toBe("Iris");
    expect(agent.tools).toEqual(["my_setup", "current_time", "review_site_page", "page_audit", "submit_seo_copy", "post_seo_report"]);
    for (const name of agent.tools) expect(client.permissions).toContain(TOOLS[name].permission);
    expect(client.connections?.filter(c => c.access === "write").every(c => c.id === "kestrel_preview_github")).toBe(true);
  });
  it("reads the visible title, headings, description and canonical URL with one decoding pass", async () => {
    const html = `<title>Services | Kestrel&#39;s &amp; Sons &amp;amp;</title>
      <meta name="description" content="Brakes &amp; tyres &#x2019; &amp;amp;">
      <link rel="canonical" href="https://shop.example/services/?a=1&amp;b=2">
      <h1>Brakes &amp; <em>Tyres</em> &copy;</h1><h1>&am<span>p;</span></h1>`;
    const context = { settings: { site: "https://shop.example" }, connection: () => ({
      fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
    }) } as unknown as ToolContext;
    const result = await reviewPage.execute(context, {});
    expect(result.data).toMatchObject({
      title: "Services | Kestrel's & Sons &amp;", description: "Brakes & tyres \u2019 &amp;",
      canonical: "https://shop.example/services/?a=1&b=2", h1: ["Brakes & Tyres \u00a9", "&amp;"],
    });
  });
  it("reads the reviewed page and blocks URLs outside Kestrel's site", async () => {
    const fetch = vi.fn(async () => new Response('<title>Brake service</title><meta name="description" content="Brake repair"><link rel="canonical" href="' + services + '"><h1>Brake <em>service</em></h1>', { headers: { "content-type": "text/html" } }));
    const context = { settings: client.agentSettings!["iris"], connection: () => ({ fetch }) } as unknown as ToolContext;
    const result = await reviewPage.execute(context, { path: "/services/" });
    expect(fetch).toHaveBeenCalledWith(services);
    expect(result.data).toMatchObject({ title: "Brake service", description: "Brake repair", canonical: services, h1: ["Brake service"], h1Count: 1 });
    await expect(reviewPage.execute(context, { path: "//example.com/" })).rejects.toThrow("configured website");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
