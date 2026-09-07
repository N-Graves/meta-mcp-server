import { z } from "zod";
import {
  HttpClient,
  ToolError,
  boundedText,
  httpUrl,
  type ToolDefinition,
} from "@nasdigital/mcp-server-core";

/**
 * Instagram publishing is two calls: create a media container, then publish
 * it. Meta processes the container server-side — it fetches the image or video
 * from a URL you supply — so publishing immediately is a race, and one that
 * gets lost far more often with video than with a photo.
 *
 * The server this replaces published straight away with no wait at all. This
 * polls the container's own status_code instead, and falls back to publishing
 * after the budget if that field never appears, so a container type that does
 * not report status is no worse off than before.
 */
async function waitForContainer(
  http: HttpClient,
  containerId: string,
  budgetMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const STEP_MS = 3000;
  const deadline = Date.now() + budgetMs;
  // Bounded by attempts as well as the clock: a status endpoint that answers
  // in milliseconds would otherwise turn the budget into a request storm.
  let attemptsLeft = Math.max(1, Math.ceil(budgetMs / STEP_MS));
  let sawStatus = false;

  while (Date.now() < deadline && attemptsLeft-- > 0) {
    await sleep(Math.min(STEP_MS, Math.max(0, deadline - Date.now())));
    const res = (await http.get(`/${encodeURIComponent(containerId)}`, {
      fields: "status_code,status",
    })) as { status_code?: string; status?: string };

    if (typeof res.status_code !== "string") continue;
    sawStatus = true;

    if (res.status_code === "FINISHED") return;
    if (res.status_code === "ERROR" || res.status_code === "EXPIRED") {
      throw new ToolError(
        `Instagram could not process the media (${res.status_code})` +
          (res.status ? `: ${res.status}` : "") +
          ". Nothing was published.",
      );
    }
  }

  if (sawStatus) {
    throw new ToolError(
      "The Instagram media container was still processing when the wait budget ran out. " +
        "Nothing was published. Video takes longer than a photo — try a larger wait_seconds.",
    );
  }
}

export interface MetaClients {
  /** Authenticated with the Page access token. */
  page: HttpClient;
  /** Authenticated with the Instagram user access token. */
  instagram: HttpClient;
}

export function buildTools(
  clients: MetaClients,
  defaults: { pageId?: string; igUserId?: string } = {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): ToolDefinition<any>[] {
  const need = (given: string | undefined, fallback: string | undefined, env: string) => {
    const id = given ?? fallback;
    if (!id) throw new ToolError(`No id supplied and ${env} is not set.`);
    return encodeURIComponent(id);
  };

  return [
    {
      name: "meta_get_page",
      description: "A Facebook Page's own details.",
      action: "read",
      input: z.object({
        page_id: z.string().optional(),
        fields: z.string().optional().describe("Comma-separated. Defaults to id,name,fan_count."),
      }),
      handler: ({ page_id, fields }) =>
        clients.page.get(`/${need(page_id, defaults.pageId, "META_PAGE_ID")}`, {
          fields: fields ?? "id,name,fan_count",
        }),
    },

    {
      name: "meta_create_page_post",
      description:
        "Post to a Facebook Page. Immediately public — there is no draft state here, and the " +
        "only undo is deleting it.",
      action: "write",
      input: z.object({
        message: boundedText(60_000).describe("Post text."),
        link: httpUrl.optional().describe("A link to attach."),
        page_id: z.string().optional(),
      }),
      handler: ({ message, link, page_id }) =>
        clients.page.post(
          `/${need(page_id, defaults.pageId, "META_PAGE_ID")}/feed`,
          undefined,
          { message, ...(link ? { link } : {}) },
        ),
    },

    {
      name: "meta_create_post_comment",
      description:
        "Comment on a Page post — how you put an outbound link in the first comment rather " +
        "than the post body.\n\n" +
        "⚠️ A successful call here is your ONLY confirmation. Reading comments back is not " +
        "possible with a standard app (see the README), so if this succeeds, believe it; " +
        "there is nothing to verify against.",
      action: "write",
      input: z.object({
        post_id: z.string().min(1),
        message: boundedText(8000),
      }),
      handler: async ({ post_id, message }) => {
        const res = (await clients.page.post(
          `/${encodeURIComponent(post_id)}/comments`,
          undefined,
          { message },
        )) as { id?: string };
        if (!res?.id) {
          // A silently-failed comment leaves a live post with no link on it,
          // which is the whole point of the call.
          throw new ToolError(
            "Facebook returned no comment id, so the comment did not post. The post itself " +
              "is unaffected and still live.",
          );
        }
        return res;
      },
    },

    {
      name: "meta_get_instagram_account",
      description: "The linked Instagram Business account.",
      action: "read",
      input: z.object({
        ig_user_id: z.string().optional(),
        fields: z.string().optional(),
      }),
      handler: ({ ig_user_id, fields }) =>
        clients.instagram.get(`/${need(ig_user_id, defaults.igUserId, "META_IG_USER_ID")}`, {
          fields: fields ?? "id,username,name,followers_count",
        }),
    },

    {
      name: "meta_create_instagram_post",
      description:
        "Publish to Instagram. Immediately public, no draft state.\n\n" +
        "Instagram's Content Publishing API does not accept a direct file upload: the media " +
        "must be at a publicly reachable http(s) URL that Meta fetches server-side. A local " +
        "path can never work.",
      action: "write",
      input: z
        .object({
          caption: boundedText(2200).optional(),
          image_url: httpUrl.optional().describe("Public http(s) URL to a photo."),
          video_url: httpUrl.optional().describe("Public http(s) URL to a video. Posted as a Reel."),
          ig_user_id: z.string().optional(),
          wait_seconds: z
            .number()
            .int()
            .min(5)
            .max(300)
            .optional()
            .describe("Processing budget. Default 30 for a photo, 120 for video."),
        })
        .refine((v) => Boolean(v.image_url) !== Boolean(v.video_url), {
          message: "Supply exactly one of image_url or video_url.",
        }),
      handler: async ({ caption, image_url, video_url, ig_user_id, wait_seconds }) => {
        const id = need(ig_user_id, defaults.igUserId, "META_IG_USER_ID");
        const container = (await clients.instagram.post(`/${id}/media`, undefined, {
          ...(caption ? { caption } : {}),
          ...(image_url ? { image_url } : {}),
          ...(video_url ? { video_url, media_type: "REELS" } : {}),
        })) as { id?: string };

        if (!container.id) {
          throw new ToolError(
            "Instagram returned no media container id, so there is nothing to publish. " +
              "Nothing was posted.",
          );
        }

        await waitForContainer(
          clients.instagram,
          container.id,
          (wait_seconds ?? (video_url ? 120 : 30)) * 1000,
          sleep,
        );

        return clients.instagram.post(`/${id}/media_publish`, undefined, {
          creation_id: container.id,
        });
      },
    },

    {
      name: "meta_call",
      description:
        "Call any Graph API endpoint directly, with the Page token by default. Meta publishes " +
        "no machine-readable spec for the Graph API, so this server does not claim a complete " +
        "catalogue — this is how you reach the rest of it. Paths are relative to the Graph " +
        "host and version.",
      action: "destructive",
      input: z.object({
        path: z
          .string()
          .min(1)
          .refine((p) => p.startsWith("/"), "Path must start with /")
          .describe("e.g. /me/accounts"),
        method: z.enum(["GET", "POST", "DELETE"]).optional().default("GET"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        as: z
          .enum(["page", "instagram"])
          .optional()
          .default("page")
          .describe("Which token to use. They are different tokens with different reach."),
      }),
      handler: ({ path, method, query, as }) =>
        clients[as === "instagram" ? "instagram" : "page"].request(path, {
          method,
          query: query ?? {},
        }),
    },
  ];
}
