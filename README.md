# meta-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Meta Graph API** — Facebook Pages and linked Instagram Business accounts.

MIT licensed.

## Install

```bash
npm install -g @nasdigital/meta-mcp
```

## Configuration

```json
{
  "env": {
    "META_PAGE_ACCESS_TOKEN": "your-page-token",
    "META_PAGE_ID": "1234567890",
    "META_IG_USER_ID": "17841400000000000"
  }
}
```

`META_IG_ACCESS_TOKEN` is optional — it defaults to the Page token, which is correct when the Instagram account is linked to that Page. The ids are optional too; they just default the arguments.

A long-lived Page token can be obtained through the Graph API Explorer and then exchanged, which is far less work than a full OAuth flow for a single account.

## ⚠️ Do not reason from the token's scope list

This is the finding worth carrying away, because it is wrong in **both directions**:

| | scope list says | reality |
|---|---|---|
| Reading Page content | `pages_read_engagement` **granted** | fails, demanding `pages_read_engagement` |
| Writing a comment | `pages_manage_engagement` **absent** | works |

Verified live. Every Page read endpoint (`/{page}/feed`, `/me/feed`, and by extension `/{post}/comments`) returns:

> `(#10) This endpoint requires the 'pages_read_engagement' permission or the 'Page Public Content Access' feature`

…while `debug_token` lists that permission among the token's scopes. Granted but not effective, which points at **App Review** rather than at re-authorising.

Meanwhile a probe against `POST /{post}/comments` returned `(#100) Invalid post_id parameter` — it cleared the permission check and failed only on the deliberately fake id.

**Writing works; reading it back does not.** Trusting the scope list would have shipped the read tool and skipped the write — exactly backwards.

Two consequences here:

- there is **no read-comments tool**, because it would always fail;
- a successful `meta_create_post_comment` is your **only** confirmation, and the tool says so.

## ⚠️ Tokens go in a header, not the URL

Meta's own examples put `access_token=...` in the query string. That puts the credential in access logs, proxy logs and browser history on every request. Here they are `Authorization: Bearer` headers, and there is a test asserting no request URL contains `access_token`.

## Instagram publishing waits properly

Publishing to Instagram is two calls: create a media container, then publish it. Meta fetches and processes your media server-side, so publishing immediately is a race — and video loses it far more often than a photo.

The server this replaces published **straight away with no wait at all**. This one polls the container's `status_code`:

- publishes as soon as it reports `FINISHED`;
- **refuses to publish** one reporting `ERROR` or `EXPIRED`;
- is bounded by attempts as well as by the clock, so a fast status endpoint cannot become a request storm;
- falls back to publishing after the budget if `status_code` never appears, so a container type that does not report status is no worse off than before.

Instagram's Content Publishing API takes a **public http(s) URL** that Meta fetches, not a file upload. A local path can never work, so it is rejected at validation rather than sixty seconds later.

## Tools

| Tool | |
|---|---|
| `meta_get_page` | A Page's details. |
| `meta_create_page_post` | Post to a Page. Immediately public. |
| `meta_create_post_comment` | Comment — the link-in-first-comment pattern. |
| `meta_get_instagram_account` | The linked Instagram Business account. |
| `meta_create_instagram_post` | Publish a photo or Reel. |
| `meta_call` | Anything else, with either token. |

The Page and Instagram tokens are kept apart — they are different tokens with different reach, and using the wrong one fails in a way that reads like a missing permission. `meta_call` takes an `as` argument so you can pick.

## What is NOT covered

Meta publishes no machine-readable spec for the Graph API, and much of it is gated behind App Review in ways the scope list does not reflect. So this server does **not** claim complete coverage: it wraps what is verified working and offers `meta_call` as a documented passthrough for the rest.

## Read-only and no-destructive modes

```
MCP_READ_ONLY=1       refuse anything that changes state
MCP_NO_DESTRUCTIVE=1  allow posting, refuse the generic caller
```

## Testing

```bash
npm test                                                # 11 tests
SMOKE_ENV='{"META_PAGE_ACCESS_TOKEN":"x"}' npm run smoke    # real MCP over stdio
```

## Built on

[`@nasdigital/mcp-server-core`](https://github.com/N-Graves/mcp-server-core).

## Licence

MIT.
