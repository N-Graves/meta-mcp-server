import { describe, it, expect } from "vitest";
import { HttpClient } from "@nasdigitaluk/mcp-server-core";
import { buildTools, type MetaClients } from "../src/tools.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function harness(respond: (url: string, method: string, token: string) => Response) {
  const calls: { url: string; method: string; token: string }[] = [];
  const make = (token: string) =>
    new HttpClient({
      baseUrl: "https://graph.facebook.com/v25.0",
      headers: { Authorization: `Bearer ${token}` },
      fetchImpl: (async (url: string, opts: RequestInit = {}) => {
        const method = opts.method ?? "GET";
        calls.push({ url, method, token });
        return respond(url, method, token);
      }) as unknown as typeof fetch,
    });

  const clients: MetaClients = { page: make("page-token"), instagram: make("ig-token") };
  const tools = buildTools(clients, { pageId: "P1", igUserId: "IG1" }, async () => {});
  return { calls, tool: (n: string) => tools.find((t) => t.name === n)!, tools };
}

describe("credentials", () => {
  it("sends tokens in a header, never the query string", async () => {
    // Meta's own examples put access_token=... in the URL, which lands the
    // credential in access logs, proxy logs and browser history.
    const { tool, calls } = harness(() => json({ id: "P1" }));
    await tool("meta_get_page").handler({});
    expect(calls[0]!.url).not.toContain("access_token");
  });

  it("keeps the Page and Instagram tokens apart", async () => {
    // They are different tokens with different reach; using the wrong one
    // fails in a way that reads like a missing permission.
    const { tool, calls } = harness(() => json({ id: "x" }));
    await tool("meta_get_page").handler({});
    await tool("meta_get_instagram_account").handler({});
    expect(calls.map((c) => c.token)).toEqual(["page-token", "ig-token"]);
  });

  it("lets the generic caller choose which token to use", async () => {
    const { tool, calls } = harness(() => json({}));
    await tool("meta_call").handler({ path: "/me", method: "GET", as: "instagram" });
    expect(calls[0]!.token).toBe("ig-token");
  });
});

describe("Instagram publishing", () => {
  const publishFlow = (statuses: string[]) => {
    let i = 0;
    return (url: string) => {
      if (url.includes("/media_publish")) return json({ id: "ig-post-1" });
      if (url.includes("/IG1/media")) return json({ id: "container-1" });
      return json({ status_code: statuses[Math.min(i++, statuses.length - 1)] });
    };
  };

  it("waits for the container to finish before publishing", async () => {
    const { tool, calls } = harness(publishFlow(["IN_PROGRESS", "FINISHED"]));
    const res = await tool("meta_create_instagram_post").handler({
      image_url: "https://x.test/a.png",
      caption: "hi",
    });
    expect(res).toEqual({ id: "ig-post-1" });
    expect(calls.filter((c) => c.url.includes("/media_publish"))).toHaveLength(1);
  });

  it("does not publish media Instagram reports as failed", async () => {
    // The previous server published immediately with no wait at all, which is
    // a race - and one video loses far more often than a photo.
    const { tool, calls } = harness(publishFlow(["ERROR"]));
    await expect(
      tool("meta_create_instagram_post").handler({ video_url: "https://x.test/a.mp4" }),
    ).rejects.toThrow(/Nothing was published/);
    expect(calls.filter((c) => c.url.includes("/media_publish"))).toHaveLength(0);
  });

  it("publishes anyway when no status_code is ever returned", async () => {
    const { tool } = harness((url) =>
      url.includes("/media_publish") ? json({ id: "posted" }) : json({ id: "container-1" }),
    );
    await expect(
      tool("meta_create_instagram_post").handler({
        image_url: "https://x.test/a.png",
        wait_seconds: 5,
      }),
    ).resolves.toEqual({ id: "posted" });
  });

  it("insists on exactly one of image_url or video_url", () => {
    const t = harness(() => json({})).tool("meta_create_instagram_post");
    expect(t.input.safeParse({}).success).toBe(false);
    expect(
      t.input.safeParse({ image_url: "https://x.test/a.png", video_url: "https://x.test/a.mp4" })
        .success,
    ).toBe(false);
    expect(t.input.safeParse({ image_url: "https://x.test/a.png" }).success).toBe(true);
  });

  it("refuses a local file path, which Instagram can never fetch", () => {
    // The Content Publishing API takes a URL Meta fetches server-side, not an
    // upload. Better a validation error than a container that fails later.
    const t = harness(() => json({})).tool("meta_create_instagram_post");
    expect(t.input.safeParse({ image_url: "/home/me/a.png" }).success).toBe(false);
  });
});

describe("Facebook", () => {
  it("refuses to report a comment as posted when no id comes back", async () => {
    // A silently-failed comment leaves a live post with no link on it, which
    // is the entire reason the call was made.
    const { tool } = harness((url) =>
      url.includes("/comments") ? json({}) : json({ id: "post-1" }),
    );
    await expect(
      tool("meta_create_post_comment").handler({ post_id: "P1_1", message: "link" }),
    ).rejects.toThrow(/did not post[\s\S]*still live/);
  });

  it("says that a successful comment is the only confirmation available", () => {
    // Reading comments back is not possible with a standard app, so there is
    // nothing to verify against afterwards.
    const { tool } = harness(() => json({}));
    expect(tool("meta_create_post_comment").description).toMatch(/ONLY confirmation/);
  });

  it("ships no read-comments tool, because reads are gated by App Review", () => {
    // Verified live: reads fail demanding pages_read_engagement even though
    // debug_token lists it, while writes clear the permission check. A tool
    // that always fails is worse than a documented absence.
    const { tools } = harness(() => json({}));
    expect(tools.map((t) => t.name)).not.toContain("meta_get_post_comments");
    expect(tools).toHaveLength(6);
  });
});
