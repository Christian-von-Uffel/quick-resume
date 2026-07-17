import { runMistralOcr, LlmHttpError } from "../../../src/lib/server/llmProviders";
import { getRequestUser, unauthorizedResponse } from "../../../src/lib/server/auth";
import {
  getSubscriptionForUser,
  hasActiveAccess,
  subscriptionRequiredResponse,
} from "../../../src/lib/server/subscription";
import { recordLlmCall } from "../../../src/lib/server/llmCalls";

// OCR on a long document can take a while; match the generation route's ceiling.
export const maxDuration = 180;

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

  const file = body?.file;
  if (
    !file ||
    typeof file !== "object" ||
    typeof file.mimeType !== "string" ||
    typeof file.base64 !== "string" ||
    !file.base64
  ) {
    return Response.json({ error: "file with mimeType and base64 is required." }, { status: 400 });
  }

  // OCR is a leg of the import run, not a run of its own: it shares the run id
  // so both legs roll up as one import. No prompt is involved.
  const runId = body?.runId ?? null;
  const startedAt = Date.now();

  try {
    const { text, pagesProcessed } = await runMistralOcr({
      name: typeof file.name === "string" ? file.name : "upload",
      mimeType: file.mimeType,
      base64: file.base64,
    });

    // Mistral bills OCR per page, not per token, so `pages` carries the cost.
    recordLlmCall({
      userId: user.id,
      runId,
      provider: "mistral",
      model: "ocr",
      pages: pagesProcessed,
      durationMs: Date.now() - startedAt,
      succeeded: true,
    });

    return Response.json({ text });
  } catch (error) {
    recordLlmCall({
      userId: user.id,
      runId,
      provider: "mistral",
      model: "ocr",
      durationMs: Date.now() - startedAt,
      succeeded: false,
    });

    return Response.json(
      { error: error instanceof Error ? error.message : "OCR failed." },
      { status: error instanceof LlmHttpError ? error.status : 502 }
    );
  }
}
