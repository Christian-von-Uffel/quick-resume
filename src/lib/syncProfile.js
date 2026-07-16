// Writes the editor's state back to Supabase. Runs in the browser under the
// signed-in user's session, so row-level security scopes every write to their
// own rows. Mirrors scripts/load-profile-to-db.mjs: each table's rows for the
// user are replaced so the database always matches the app state.

import { buildDbWritePayload } from "./dbProfile";
import { DEFAULT_VISIBLE_CONTACT_FIELDS } from "./constants";

function throwIfError(result, label) {
  if (result?.error) {
    throw new Error(`${label}: ${result.error.message ?? "request failed"}`);
  }
  return result;
}

export async function syncAppStateToDb(supabase, userId, appState) {
  const { profileRow, educationRows, workRows, resumeRows, selectedResumeId } =
    buildDbWritePayload(appState, userId);

  throwIfError(
    await supabase.from("profiles").upsert(profileRow, { onConflict: "user_id" }),
    "profiles upsert"
  );

  throwIfError(await supabase.from("education").delete().eq("user_id", userId), "education clear");
  if (educationRows.length > 0) {
    throwIfError(await supabase.from("education").insert(educationRows), "education insert");
  }

  throwIfError(await supabase.from("work_history").delete().eq("user_id", userId), "work_history clear");
  if (workRows.length > 0) {
    throwIfError(await supabase.from("work_history").insert(workRows), "work_history insert");
  }

  // Break the selected-resume FK before deleting resumes, then restore it.
  throwIfError(
    await supabase.from("profiles").update({ selected_resume_id: null }).eq("user_id", userId),
    "selection clear"
  );
  throwIfError(await supabase.from("resumes").delete().eq("user_id", userId), "resumes clear");
  if (resumeRows.length > 0) {
    throwIfError(await supabase.from("resumes").insert(resumeRows), "resumes insert");
  }
  if (selectedResumeId) {
    throwIfError(
      await supabase.from("profiles").update({ selected_resume_id: selectedResumeId }).eq("user_id", userId),
      "selection set"
    );
  }
}

// Wipes the user's resume data. The profiles row is reset rather than deleted,
// since nothing recreates it for an existing account.
export async function deleteUserData(supabase, userId) {
  throwIfError(
    await supabase.from("profiles").update({ selected_resume_id: null }).eq("user_id", userId),
    "selection clear"
  );
  throwIfError(await supabase.from("resumes").delete().eq("user_id", userId), "resumes clear");
  throwIfError(await supabase.from("education").delete().eq("user_id", userId), "education clear");
  throwIfError(await supabase.from("work_history").delete().eq("user_id", userId), "work_history clear");
  throwIfError(
    await supabase
      .from("profiles")
      .update({
        name: "",
        headline: "",
        location: "",
        email: "",
        phone: "",
        linkedin: "",
        github: "",
        website: "",
        visible_contact_fields: DEFAULT_VISIBLE_CONTACT_FIELDS,
        conflict_acks: [],
      })
      .eq("user_id", userId),
    "profile reset"
  );
}
