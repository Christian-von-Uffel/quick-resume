import { scrapePageMarkdown, LlmHttpError } from "../../../src/lib/server/llmProviders";
import { getRequestUser, unauthorizedResponse } from "../../../src/lib/server/auth";
import {
  getSubscriptionForUser,
  hasActiveAccess,
  subscriptionRequiredResponse,
} from "../../../src/lib/server/subscription";
import { recordLlmCall, normalizeRunId } from "../../../src/lib/server/llmCalls";
import { checkUsageAllowed, usageLimitResponse } from "../../../src/lib/server/quota";

// Firecrawl renders the page before returning markdown, which can take a while
// on heavy job boards.
export const maxDuration = 120;

export async function POST(request) {
  const user = await getRequestUser();
  if (!user) return unauthorizedResponse();
  const subscription = await getSubscriptionForUser(user.id);
  if (!hasActiveAccess(subscription)) {
    return subscriptionRequiredResponse();
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The request body must be JSON." }, { status: 400 });
  }

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Response.json({ error: "Enter a valid job page URL." }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Response.json({ error: "Only http(s) URLs can be scraped." }, { status: 400 });
  }

  // Firecrawl bills per page fetched, not by token; the LLM cleanup that
  // follows is a separate /api/llm call under the same run id.
  const runId = normalizeRunId(body?.runId);

  // No run quota of its own — a scrape is cheap and per-page billed. It still
  // passes through so the burst ceiling covers a script hammering the endpoint.
  const decision = await checkUsageAllowed({
    userId: user.id,
    subscription,
    feature: "job_scrape",
    runId,
  });
  if (!decision.allowed) return usageLimitResponse(decision);

  const startedAt = Date.now();

  try {
    const result = await scrapePageMarkdown(url);

    await recordLlmCall({
      userId: user.id,
      runId,
      feature: "job_scrape",
      provider: "firecrawl",
      model: "scrape",
      pages: 1,
      durationMs: Date.now() - startedAt,
      succeeded: true,
    });

    return Response.json(result);
  } catch (error) {
    await recordLlmCall({
      userId: user.id,
      runId,
      feature: "job_scrape",
      provider: "firecrawl",
      model: "scrape",
      durationMs: Date.now() - startedAt,
      succeeded: false,
    });

    return Response.json(
      { error: error instanceof Error ? error.message : "Scraping the page failed." },
      { status: error instanceof LlmHttpError ? error.status : 502 }
    );
  }
}
