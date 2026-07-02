import { PROFILE_EXPORT_VERSION } from "./constants";
import { normalizeWorkHistoryItem } from "./resumeModel";

export function buildProfileExportPayload({ profile, workHistory, resumes, selectedResumeId, llmSettings }) {
  return {
    version: PROFILE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    profile,
    workHistory: workHistory.map(normalizeWorkHistoryItem),
    resumes: resumes.map(({ id, name, company, jobTitle, content, updatedAt }) => ({
      id,
      name,
      company,
      jobTitle,
      content,
      updatedAt,
    })),
    selectedResumeId,
    llmSettings: {
      provider: llmSettings.provider,
      model: llmSettings.model,
    },
  };
}
