import {
  getConfiguredLlmProviders,
  getModelOptionsForProvider,
  getPreferredLlmProvider,
} from "../../../../src/lib/server/llmProviders";
import { getRequestUser, unauthorizedResponse } from "../../../../src/lib/server/auth";

const PROVIDERS = new Set(["gemini", "openai", "anthropic", "xai"]);

// Lists the models the picker can offer for one provider. Never fails outright:
// when the upstream listing is unavailable the server lib answers with the
// bundled fallback options and marks the source accordingly.
// With no provider param, returns which keys are set and the preferred default
// (xAI → Anthropic → OpenAI → Google).
export async function GET(request) {
  if (!(await getRequestUser())) return unauthorizedResponse();

  const provider = new URL(request.url).searchParams.get("provider");

  if (!provider) {
    return Response.json({
      preferred: getPreferredLlmProvider(),
      configured: getConfiguredLlmProviders(),
    });
  }

  if (!PROVIDERS.has(provider)) {
    return Response.json({ error: "Unknown provider." }, { status: 400 });
  }

  const { options, source } = await getModelOptionsForProvider(provider);
  return Response.json({ options, source });
}
