#!/usr/bin/env node
/**
 * meta-mcp-server — a Model Context Protocol server for the Meta Graph API:
 * Facebook Pages and linked Instagram Business accounts.
 *
 * Configuration:
 *   META_PAGE_ACCESS_TOKEN  required. A Page access token.
 *   META_IG_ACCESS_TOKEN    optional. Defaults to the Page token, which is
 *                           correct when the Instagram account is linked to
 *                           that Page.
 *   META_PAGE_ID            optional. Defaults the page_id argument.
 *   META_IG_USER_ID         optional. Defaults the ig_user_id argument.
 *   META_GRAPH_VERSION      optional. Defaults to v25.0.
 *   META_BASE_URL           optional. Defaults to https://graph.facebook.com
 *   MCP_READ_ONLY=1         refuse anything that changes state.
 *   MCP_NO_DESTRUCTIVE=1    allow posting, refuse the generic caller.
 *
 * ⚠️  Tokens go in an Authorization header, not the query string. Meta's own
 *     examples put access_token=... in every URL, which lands the credential
 *     in access logs, proxy logs and browser history.
 *
 * ⚠️  Do not reason from the token's scope list. Verified live: reads fail
 *     demanding pages_read_engagement while debug_token lists it as granted,
 *     and writes succeed on pages_manage_engagement which is absent from the
 *     list. See the README - trusting the list gets it backwards in both
 *     directions.
 */

import { authorizerFromEnv, requireEnv, runServer, HttpClient } from "@nasdigital/mcp-server-core";
import { buildTools } from "./tools.js";

const VERSION = "1.0.0";

async function main() {
  const pageToken = requireEnv("META_PAGE_ACCESS_TOKEN");
  const igToken = process.env.META_IG_ACCESS_TOKEN || pageToken;
  const graphVersion = process.env.META_GRAPH_VERSION || "v25.0";
  const baseUrl = `${(process.env.META_BASE_URL || "https://graph.facebook.com").replace(/\/+$/, "")}/${graphVersion}`;

  const clientFor = (token: string) =>
    new HttpClient({
      baseUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": `meta-mcp-server/${VERSION}`,
      },
      timeoutMs: 30_000,
    });

  const tools = buildTools(
    { page: clientFor(pageToken), instagram: clientFor(igToken) },
    { pageId: process.env.META_PAGE_ID, igUserId: process.env.META_IG_USER_ID },
  );

  await runServer({
    name: "meta-mcp-server",
    version: VERSION,
    authorizer: authorizerFromEnv(),
    tools,
  });

  console.error(
    `Meta Graph API ${graphVersion}: ${tools.length} tools` +
      (process.env.META_IG_ACCESS_TOKEN ? " (separate Instagram token)" : " (one token for both)") +
      ".",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
