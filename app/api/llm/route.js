import { callProvider, LlmHttpError } from "../../../src/lib/server/llmProviders";
import { getRequestUser, unauthorizedResponse } from "../../../src/lib/server/auth";
import {
  getSubscriptionForUser,
  hasActiveAccess,
  subscriptionRequiredResponse,
} from "../../../src/lib/server/subscription";
import { recordLlmCall, normalizeRunId } from "../../../src/lib/server/llmCalls";
import {
  checkUsageAllowed,
  normalizeFeature,
  usageLimitResponse,
} from "../../../src/lib/server/quota";

// Non-streaming generations on large models can legitimately run past a
// minute; without this, hosted deploys kill the function mid-generation.
export const maxDuration = 180;

const PROVIDERS = new Set(["gemini", "openai", "anthropic", "xai"]);

function normalizeFile(file) {
  if (!file || typeof file !== "object") return null;
  const { name, mimeType, base64 } = file;
  if (typeof mimeType !== "string" || typeof base64 !== "string" || !base64) return null;
  return { name: typeof name === "string" ? name : "upload", mimeType, base64 };
}

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

  const provider = PROVIDERS.has(body?.provider) ? body.provider : null;
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";

  if (!provider || !model || !prompt.trim()) {
    return Response.json(
      { error: "provider, model, and prompt are required." },
      { status: 400 }
    );
  }

  const wasRepair = body?.purpose === "repair";
  const runId = normalizeRunId(body?.runId);
  const feature = normalizeFeature(body?.feature);
  const attributePrompt =
    typeof body?.attributePrompt === "string" && body.attributePrompt.trim()
      ? body.attributePrompt
      : prompt;

  // Usage check before the provider call, so a call over the limit costs
  // nothing. Later calls of an already-counted run are waved through inside
  // checkUsageAllowed — a half-generated resume must not be stranded.
  const decision = await checkUsageAllowed({
    userId: user.id,
    subscription,
    feature,
    runId,
  });
  if (!decision.allowed) return usageLimitResponse(decision);

  const startedAt = Date.now();

  try {
    const { text, usage } = await callProvider({
      provider,
      model,
      prompt,
      file: normalizeFile(body.file),
    });

    const promptId = await recordLlmCall({
      userId: user.id,
      prompt: attributePrompt,
      runId,
      feature,
      wasRepair,
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: Date.now() - startedAt,
      succeeded: true,
    });

    return Response.json({ text, promptId });
  } catch (error) {
    // Awaited like the success path: the function may be frozen the moment it
    // responds, and a failed call still burned tokens and counts toward burst.
    await recordLlmCall({
      userId: user.id,
      prompt: attributePrompt,
      runId,
      feature,
      wasRepair,
      provider,
      model,
      durationMs: Date.now() - startedAt,
      succeeded: false,
    });

    return Response.json(
      { error: error instanceof Error ? error.message : "The model call failed." },
      { status: error instanceof LlmHttpError ? error.status : 502 }
    );
  }
}
