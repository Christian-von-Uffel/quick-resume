import { scrapePageMarkdown, LlmHttpError } from "../../../src/lib/server/llmProviders";
import { getRequestUser, unauthorizedResponse } from "../../../src/lib/server/auth";
import {
  getSubscriptionForUser,
  hasActiveAccess,
  subscriptionRequiredResponse,
} from "../../../src/lib/server/subscription";

// Firecrawl renders the page before returning markdown, which can take a while
// on heavy job boards.
export const maxDuration = 120;

export async function POST(request) {
  const user = await getRequestUser();
  if (!user) return unauthorizedResponse();
  if (!hasActiveAccess(await getSubscriptionForUser(user.id))) {
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

  try {
    const result = await scrapePageMarkdown(url);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Scraping the page failed." },
      { status: error instanceof LlmHttpError ? error.status : 502 }
    );
  }
}
