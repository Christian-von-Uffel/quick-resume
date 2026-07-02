import {
  normalizeResumeList,
  sortWorkHistory,
  normalizeStoredList,
  normalizeWorkHistoryItem,
  normalizeProfile,
} from "./resumeModel";
import { normalizeLlmSettings } from "./llm";

export function parseProfileExportFile(raw) {
  let parsed = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("The file is not valid JSON.");
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("The file is not a valid One Resume export.");
  }

  const resumes = normalizeResumeList(parsed.resumes);
  const workHistory = sortWorkHistory(
    normalizeStoredList(parsed.workHistory, []).map(normalizeWorkHistoryItem)
  );
  const profile = normalizeProfile(parsed.profile);
  const selectedResume =
    resumes.find((resume) => resume.id === parsed.selectedResumeId) ?? resumes[0];
  const importedLlm = normalizeLlmSettings(parsed.llmSettings);

  return {
    profile,
    workHistory,
    resumes,
    selectedResumeId: selectedResume.id,
    markdown: selectedResume.content,
    llmSettings: importedLlm,
  };
}
