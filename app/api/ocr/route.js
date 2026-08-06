import { runMistralOcr, LlmHttpError } from "../../../src/lib/server/llmProviders";
import { getRequestUser, unauthorizedResponse } from "../../../src/lib/server/auth";
import {
  getSubscriptionForUser,
  hasActiveAccess,
  subscriptionRequiredResponse,
} from "../../../src/lib/server/subscription";
import { recordLlmCall, normalizeRunId } from "../../../src/lib/server/llmCalls";
import { checkUsageAllowed, usageLimitResponse } from "../../../src/lib/server/quota";

// OCR on a long document can take a while; match the generation route's ceiling.
export const maxDuration = 180;

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
  const runId = normalizeRunId(body?.runId);

  // Counted as the import it belongs to. Sharing the run id with the extraction
  // leg means an import costs one unit of allowance, not two.
  const decision = await checkUsageAllowed({
    userId: user.id,
    subscription,
    feature: "resume_import",
    runId,
  });
  if (!decision.allowed) return usageLimitResponse(decision);

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
      feature: "resume_import",
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
      feature: "resume_import",
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
