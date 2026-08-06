import { redirect } from "next/navigation";
import { createClient } from "../../../../src/lib/supabase/server";
import {
  getSubscriptionForUser,
  hasActiveAccess,
} from "../../../../src/lib/server/subscription";
import { mapDbRowsToAppState } from "../../../../src/lib/dbProfile";
import { loadLabPromptLibrary } from "../../../../src/lib/server/promptLab";
import LabLoader from "./LabLoader";

// The prompt lab: an internal, deliberately UNLINKED tool for A/B testing the
// prompts behind the four smart flows. Nothing in the product navigates here —
// you reach it by typing /app/lab.
//
// Prompt bodies live in public.prompts (id, prompt, created_at). Lab load
// syncs the current production templates into that table and lists recent
// rows for the picker. Every Run B / Use this prompt also ensure_prompt's.

export const metadata = {
  title: "Prompt lab",
  robots: { index: false, follow: false },
};

async function loadLabState(supabase, userId) {
  const [profileResult, educationResult, workResult, promptLibrary] = await Promise.all([
    supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("education").select("*").eq("user_id", userId),
    supabase.from("work_history").select("*").eq("user_id", userId),
    loadLabPromptLibrary(supabase),
  ]);

  return {
    ...mapDbRowsToAppState({
      profile: profileResult.data,
      education: educationResult.data,
      workHistory: workResult.data,
      resumes: [],
    }),
    promptLibrary,
  };
}

export default async function PromptLabPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Paid only, and deliberately NOT open to trials. The lab's compare path runs
  // the full generation pipeline, and its calls are metered as 'lab' so prompt
  // testing doesn't eat the operator's own resume allowance. Letting a trial in
  // here would therefore be an unlimited-generation bypass of the trial cap.
  const subscription = await getSubscriptionForUser(user.id);
  if (!hasActiveAccess(subscription) || subscription.status !== "active") redirect("/app");

  const initialData = await loadLabState(supabase, user.id);
  return <LabLoader initialData={initialData} />;
}
