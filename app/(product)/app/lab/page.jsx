import { redirect } from "next/navigation";
import { createClient } from "../../../../src/lib/supabase/server";
import {
  getSubscriptionForUser,
  hasActiveAccess,
} from "../../../../src/lib/server/subscription";
import { mapDbRowsToAppState } from "../../../../src/lib/dbProfile";
import LabLoader from "./LabLoader";

// The prompt lab: an internal, deliberately UNLINKED tool for A/B testing the
// prompts behind the four smart flows. Nothing in the product navigates here —
// you reach it by typing /app/lab. It is not a product surface, so it gets no
// marketing copy, no onboarding, and no entry in any menu.
//
// It sits under /app on purpose: the middleware matcher ("/app/:path*") already
// makes it signed-in-only, and /api/llm needs that session anyway. Being
// unlinked is not access control — the auth gate is.
//
// The lab never writes product metrics. src/lib/metrics.js only writes once
// configureMetrics() has been handed a client, and only src/App.jsx ever calls
// it — so on this route every metrics call the reused flow components make is
// already an inert no-op. Model calls still record their COST in llm_calls
// (the server route does that itself), but they carry no promptKey, so they
// land with prompt_id null and can never be mistaken for production traffic
// for a shipped prompt.

export const metadata = {
  title: "Prompt lab",
  robots: { index: false, follow: false },
};

// The lab compares prompts against the person's own saved history, because a
// prompt that looks good on invented input tells you nothing. Accept / Add in
// the clarity and expand benches write the updated description back to that
// history; generated resumes stay display-only.
async function loadLabState(supabase, userId) {
  const [profileResult, educationResult, workResult] = await Promise.all([
    supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("education").select("*").eq("user_id", userId),
    supabase.from("work_history").select("*").eq("user_id", userId),
  ]);

  return mapDbRowsToAppState({
    profile: profileResult.data,
    education: educationResult.data,
    workHistory: workResult.data,
    resumes: [],
  });
}

export default async function PromptLabPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Every model call here bills through /api/llm, which requires an active
  // subscription. Without one the lab would render fine and then fail on every
  // Run, so send those visitors to the editor's trial gate instead.
  if (!hasActiveAccess(await getSubscriptionForUser(user.id))) redirect("/app");

  const initialData = await loadLabState(supabase, user.id);
  return <LabLoader initialData={initialData} />;
}
