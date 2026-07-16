import { callProvider, LlmHttpError } from "../../../src/lib/server/llmProviders";
import { getRequestUser, unauthorizedResponse } from "../../../src/lib/server/auth";
import {
  getSubscriptionForUser,
  hasActiveAccess,
  subscriptionRequiredResponse,
} from "../../../src/lib/server/subscription";

// Non-streaming generations on large models can legitimately run past a
// minute; without this, hosted deploys kill the function mid-generation.
export const maxDuration = 180;

const PROVIDERS = new Set(["gemini", "openai", "anthropic", "xai"]);

// A prompt attachment forwarded to the provider. Only shape is validated here;
// the provider rejects unsupported media types itself.
function normalizeFile(file) {
  if (!file || typeof file !== "object") return null;
  const { name, mimeType, base64 } = file;
  if (typeof mimeType !== "string" || typeof base64 !== "string" || !base64) return null;
  return { name: typeof name === "string" ? name : "upload", mimeType, base64 };
}

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

  const provider = PROVIDERS.has(body?.provider) ? body.provider : null;
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";

  if (!provider || !model || !prompt.trim()) {
    return Response.json(
      { error: "provider, model, and prompt are required." },
      { status: 400 }
    );
  }

  try {
    const text = await callProvider({ provider, model, prompt, file: normalizeFile(body.file) });
    return Response.json({ text });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The model call failed." },
      { status: error instanceof LlmHttpError ? error.status : 502 }
    );
  }
}
