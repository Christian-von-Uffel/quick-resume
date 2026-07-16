import { redirect } from "next/navigation";
import { createClient } from "../../../src/lib/supabase/server";
import {
  getSubscriptionForUser,
  hasActiveAccess,
} from "../../../src/lib/server/subscription";
import { mapDbRowsToAppState } from "../../../src/lib/dbProfile";
import EditorLoader from "./EditorLoader";
import TrialGate from "./TrialGate";

// Loads the signed-in user's saved profile, education, work history, and resumes
// from the database. Runs under the user's session, so row-level security scopes
// every query to their own rows.
async function loadInitialAppState(supabase, userId) {
  const [profileResult, educationResult, workResult, resumeResult] = await Promise.all([
    supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("education").select("*").eq("user_id", userId),
    supabase.from("work_history").select("*").eq("user_id", userId),
    supabase.from("resumes").select("*").eq("user_id", userId),
  ]);

  return mapDbRowsToAppState({
    profile: profileResult.data,
    education: educationResult.data,
    workHistory: workResult.data,
    resumes: resumeResult.data,
  });
}

// The subscription wall. Middleware already guarantees a signed-in user here;
// this decides between the editor and the trial gate on every load, so a
// lapsed subscription locks the very next visit.
export default async function EditorPage({ searchParams }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const subscription = await getSubscriptionForUser(user.id);
  if (hasActiveAccess(subscription)) {
    const initialData = await loadInitialAppState(supabase, user.id);
    return <EditorLoader initialData={initialData} userId={user.id} />;
  }

  const params = await searchParams;
  return (
    <TrialGate
      status={subscription?.status ?? null}
      justCheckedOut={params?.checkout === "success"}
    />
  );
}
