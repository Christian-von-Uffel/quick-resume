import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import {
  PAGE_W,
  PAGE_H,
  DEFAULT_PAD,
  FONT,
  LH_MIN,
  LH_MAX,
  LH_DEFAULT,
  FS_MAX_DEFAULT,
  LLM_PROVIDERS,
  FALLBACK_MODEL_OPTIONS,
  CONTACT_FIELDS,
  DEFAULT_VISIBLE_CONTACT_FIELDS,
  MONTH_SELECT_OPTIONS,
  EMPTY_POSITION_DRAFT,
  DELETE_ACCOUNT_CONFIRM_PHRASE,
} from "./lib/constants";
import { readFileAsText, readFileAsBase64, downloadJsonFile } from "./lib/fileUtils";
import {
  sortWorkHistory,
  sortEducation,
  sortResumes,
  normalizeWorkMonth,
  normalizeWorkYear,
  normalizeWorkHistoryItem,
  normalizeEducationItem,
  normalizeProfile,
  normalizeResumeList,
  normalizeStoredList,
  createResume,
  createWorkHistoryItem,
  createEducationItem,
  getUniqueResumeName,
  titleResume,
  titleGeneratedResume,
  mergeEducation,
  getVisibleContactLine,
  buildResumeExportName,
  INITIAL_WORK_HISTORY,
  splitDescriptionIntoDetails,
  normalizeDetailForComparison,
} from "./lib/resumeModel";
import { createClient } from "./lib/supabase/client";
import { syncAppStateToDb, deleteUserData } from "./lib/syncProfile";
import {
  getDefaultModelForProvider,
  fetchProviderModelOptions,
  fetchPreferredLlmProvider,
  normalizeLlmSettings,
  callLlm,
  callLlmForJson,
  callMistralOcr,
  scrapeJobPage,
} from "./lib/llm";
import { parseMarkdown, measureBlocks, layoutBlocks, findOptimalFit } from "./lib/markdownLayout";
import {
  GENERATE_STEPS,
  buildJobAnalysisPrompt,
  validateJobAnalysis,
  selectRankedEvidence,
  validateSelectedResumeEvidence,
  ensureRequiredRolesSelected,
  composeResume,
  extractJobDescription,
  extractCleanedJobDescription,
  collapseBlankLines,
} from "./lib/generateResume";
import { summarizeCoverage, getRoleInterval, formatMonthSpan } from "./lib/workHistoryTimeline";
import {
  detectPositionConflicts,
  applyDuplicateMerge,
  applyBoundaryFix,
  collectConflictKeys,
  mergeImportedWorkHistory,
} from "./lib/positionReview";
import { WorkHistoryTimeline } from "./components/WorkHistoryTimeline";
import { PositionReviewPrompt, PositionReviewDialog } from "./components/PositionReview";
import { AccountSection } from "./components/AccountSection";
import { ExperienceReview } from "./components/ExperienceReview";
import { EnrichExperience } from "./components/EnrichExperience";
import { PipelineSteps } from "./components/PipelineSteps";
import Onboarding from "./components/Onboarding";
import { importResume, coerceImportedProfile, needsMistralOcr, resolveImportMimeType } from "./lib/importResume";
import {
  buildMissingExperienceReviewPrompt,
  validateMissingExperienceReview,
  MISSING_EXPERIENCE_KIND_LABELS,
  MISSING_EXPERIENCE_STEPS,
  formatExperienceElaboration,
  cleanFormattedDetail,
} from "./lib/reviewExperience";
import {
  buildClarityReviewPrompt,
  buildClaritySuggestionPrompt,
  cleanSuggestedSentence,
  replaceSentence,
} from "./lib/clarifyExperience";
import {
  buildOpeningQuestionsPrompt,
  validateOpeningQuestions,
  buildFollowupQuestionsPrompt,
  validateFollowupQuestions,
  buildComposePrompt,
  validateComposedBullets,
  MAX_QA_ROUNDS,
  appendDetailToDescription,
  isSparseDescription,
} from "./lib/enrichExperience";
import { buildProfileExportPayload } from "./lib/exportProfile";
import { parseProfileExportFile } from "./lib/importProfile";
import { printResumePage } from "./lib/exportPdf";

// How long to wait after the last edit before pushing changes to the database.
const SYNC_DEBOUNCE_MS = 1000;

/* ── Component ─────────────────────────────────────────────── */

export default function App({ initialData = null, userId = null }) {
  // The database is the single source of truth for resume data: the server loads
  // it into `initialData` on sign-in, and every edit is synced back (see below).
  const [initialState] = useState(() => initialData ?? {});
  const [initialResumes] = useState(() => normalizeResumeList(initialState.resumes));
  const initialSelectedResume = initialResumes.find((resume) => resume.id === initialState.selectedResumeId) ?? initialResumes[0];
  const [resumes, setResumes] = useState(initialResumes);
  const [selectedResumeId, setSelectedResumeId] = useState(initialSelectedResume.id);
  const [markdown, setMarkdown] = useState(initialSelectedResume.content);
  const [profile, setProfile] = useState(() => normalizeProfile(initialState.profile));
  const [workHistory, setWorkHistory] = useState(() =>
    sortWorkHistory(
      normalizeStoredList(initialState.workHistory, INITIAL_WORK_HISTORY).map(normalizeWorkHistoryItem)
    )
  );
  // Provider/model choice isn't persisted; it resets to the default each load.
  const [llmSettings, setLlmSettings] = useState(() => normalizeLlmSettings());
  const [modelOptionsByProvider, setModelOptionsByProvider] = useState(FALLBACK_MODEL_OPTIONS);
  const [modelOptionsStatus, setModelOptionsStatus] = useState({
    gemini: "idle",
    openai: "idle",
    anthropic: "idle",
    xai: "idle",
  });
  const [workHistorySaveToast, setWorkHistorySaveToast] = useState("");
  const [workHistorySearch, setWorkHistorySearch] = useState("");
  const [highlightedWorkId, setHighlightedWorkId] = useState(null);
  // Which position's inline clarity review is open (null = none).
  const [reviewingWorkId, setReviewingWorkId] = useState(null);
  // Which position's inline "Expand experience" enrichment panel is open (null = none).
  const [enrichingWorkId, setEnrichingWorkId] = useState(null);
  // Which position is pending a delete confirmation (null = no modal open).
  const [deleteConfirmWorkId, setDeleteConfirmWorkId] = useState(null);
  // Whether the opt-in duplicate/overlap review dialog is open.
  const [isPositionReviewOpen, setIsPositionReviewOpen] = useState(false);
  // Delete-account dialog: open state plus the typed confirmation phrase that
  // has to match DELETE_ACCOUNT_CONFIRM_PHRASE before the button arms.
  const [isDeleteAccountOpen, setIsDeleteAccountOpen] = useState(false);
  const [deleteAccountConfirmText, setDeleteAccountConfirmText] = useState("");
  const [profileDataToast, setProfileDataToast] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [generateStatus, setGenerateStatus] = useState("");
  // Whether generateStatus holds a failure (styled as an error) rather than
  // progress, so a failed run can't be mistaken for one that's still working.
  const [generateFailed, setGenerateFailed] = useState(false);
  // Index into GENERATE_STEPS while a generation runs (-1 = idle). Kept on
  // failure so the step list can show WHERE the run died.
  const [generateStepIndex, setGenerateStepIndex] = useState(-1);
  const [generationSourceType, setGenerationSourceType] = useState("text"); // "text" or "url"
  const [scrapeUrl, setScrapeUrl] = useState("");
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState("");
  const [scrapeSuccess, setScrapeSuccess] = useState("");
  const [generationInstructions, setGenerationInstructions] = useState("");
  const [missingExperienceStatus, setMissingExperienceStatus] = useState("");
  // Whether missingExperienceStatus holds a failure (styled as an error) rather
  // than progress, so a failed review can't be mistaken for one still working.
  const [missingExperienceFailed, setMissingExperienceFailed] = useState(false);
  // Index into MISSING_EXPERIENCE_STEPS while a review runs (-1 = idle). Kept
  // on failure so the step list can show WHERE the run died.
  const [missingExperienceStepIndex, setMissingExperienceStepIndex] = useState(-1);
  const [missingExperienceDetails, setMissingExperienceDetails] = useState([]);
  const [confirmedMissingExperienceSkills, setConfirmedMissingExperienceSkills] = useState([]);
  const [dismissedMissingExperienceSkills, setDismissedMissingExperienceSkills] = useState([]);
  const [missingExperiencePositionFilters, setMissingExperiencePositionFilters] = useState({});
  const [missingExperienceSelectedPositions, setMissingExperienceSelectedPositions] = useState({});
  // Raw answers keyed by skill, then by work-history id: { [skill]: { [workId]: text } }
  const [missingExperienceElaborations, setMissingExperienceElaborations] = useState({});
  const [isSavingMissingExperience, setIsSavingMissingExperience] = useState(false);
  const [missingExperienceSaveToast, setMissingExperienceSaveToast] = useState("");
  // Which detail's skill triggered the "add a missing position" modal (null = closed)
  const [addPositionForSkill, setAddPositionForSkill] = useState(null);
  const [newPositionDraft, setNewPositionDraft] = useState(EMPTY_POSITION_DRAFT);
  const [isImporting, setIsImporting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isFindingMissingExperience, setIsFindingMissingExperience] = useState(false);
  const [fontSize, setFontSize] = useState(11);
  const [padding, setPadding] = useState(DEFAULT_PAD);
  const [ready, setReady] = useState(false);
  const [lineHeightMult, setLineHeightMult] = useState(LH_DEFAULT);
  const [maxFontSize, setMaxFontSize] = useState(FS_MAX_DEFAULT);
  const [sectionSpacing, setSectionSpacing] = useState(18);
  const [itemSpacing, setItemSpacing] = useState(10);
  const [separatorSpacing, setSeparatorSpacing] = useState(16);
  const [autoFit, setAutoFit] = useState(true);
  const [pageScale, setPageScale] = useState(1);
  const [activeMainTab, setActiveMainTab] = useState("workHistory");
  const [activeResumeTab, setActiveResumeTab] = useState("preview");
  const [isResumeMenuOpen, setIsResumeMenuOpen] = useState(false);
  const [isFitSidebarOpen, setIsFitSidebarOpen] = useState(false);
  const [isCreateResumeOpen, setIsCreateResumeOpen] = useState(false);
  const [resumeCompanyDraft, setResumeCompanyDraft] = useState("");
  const [resumeJobTitleDraft, setResumeJobTitleDraft] = useState("");
  // Theme isn't persisted; it starts light on each load.
  const [theme, setTheme] = useState("light");
  const pageRef = useRef(null);
  const previewRef = useRef(null);
  const resumeMenuRef = useRef(null);
  const workHistorySaveToastTimeoutRef = useRef(null);
  const workHistorySaveToastDebounceRef = useRef(null);
  const profileDataToastTimeoutRef = useRef(null);
  const missingExperienceSaveToastTimeoutRef = useRef(null);
  // Cloud-sync bookkeeping: the Supabase client, the last snapshot written, and
  // guards so saves never overlap or fire during account deletion.
  const supabaseClientRef = useRef(null);
  const syncInitializedRef = useRef(false);
  const lastSyncedRef = useRef(null);
  const savingRef = useRef(false);
  const pendingSyncRef = useRef(null);
  const syncDisabledRef = useRef(false);

  const getSupabaseClient = () => {
    if (!supabaseClientRef.current) {
      supabaseClientRef.current = createClient();
    }
    return supabaseClientRef.current;
  };

  // ── First-run onboarding ─────────────────────────────────────────────────
  // Show the welcome flow to brand-new users the first time they reach the
  // editor. "Brand-new" = an empty account (initialData is null) that hasn't
  // completed it yet. Completion is remembered per-device via localStorage and,
  // once the profiles.onboarding_completed_at column exists, once-ever across
  // devices via a best-effort DB write. Both persistence paths are safe no-ops
  // if unavailable, so the feature works before the migration is applied.
  const onboardingKey = userId ? `1resume:onboarded:${userId}` : null;
  const [showOnboarding, setShowOnboarding] = useState(() => {
    if (initialData != null || !onboardingKey) return false;
    try {
      return !window.localStorage.getItem(onboardingKey);
    } catch {
      return true;
    }
  });

  // If this user already completed onboarding on another device, honor that
  // (best-effort; a missing column is ignored so this is safe pre-migration).
  useEffect(() => {
    if (!showOnboarding || !userId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await getSupabaseClient()
          .from("profiles")
          .select("onboarding_completed_at")
          .eq("user_id", userId)
          .maybeSingle();
        if (!cancelled && !error && data?.onboarding_completed_at) {
          setShowOnboarding(false);
          if (onboardingKey) {
            try {
              window.localStorage.setItem(onboardingKey, "1");
            } catch {
              /* storage unavailable — ignore */
            }
          }
        }
      } catch {
        /* column may not exist yet — ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
    // getSupabaseClient is a stable ref-backed getter; intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOnboarding, userId, onboardingKey]);

  const completeOnboarding = useCallback(() => {
    setShowOnboarding(false);
    if (onboardingKey) {
      try {
        window.localStorage.setItem(onboardingKey, "1");
      } catch {
        /* storage unavailable — ignore */
      }
    }
    if (userId) {
      // Best-effort; harmless if the column hasn't been migrated in yet.
      getSupabaseClient()
        .from("profiles")
        .update({ onboarding_completed_at: new Date().toISOString() })
        .eq("user_id", userId)
        .then(
          () => {},
          () => {}
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, onboardingKey]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const sortedWorkHistory = useMemo(() => sortWorkHistory(workHistory), [workHistory]);

  // Suspected duplicate/overlapping/dually-held positions, minus the pairs the
  // person already confirmed as intentional (profile.conflictAcks). Reviewing
  // them is optional: a quiet prompt above the timeline opens the dialog.
  const workConflicts = useMemo(
    () => detectPositionConflicts(workHistory, { ackKeys: profile.conflictAcks ?? [] }),
    [workHistory, profile.conflictAcks]
  );

  // Plain-language reasons an action is gated, surfaced as inline hints + tooltips
  // so users know what to fix instead of facing a silently disabled button. Each
  // is "" when the action is ready (or merely busy, which the button label shows).
  const hasJobDescription = generationInstructions.trim().length > 0;
  const generateDisabledReason = !hasJobDescription
    ? "Paste a job description above to generate a resume."
    : "";
  const findMissingDisabledReason =
    sortedWorkHistory.length === 0
      ? "Add work history first, then paste a job description above."
      : !hasJobDescription
        ? "Paste a job description above to compare it against your work history."
        : "";
  const scrapeDisabledReason = !scrapeUrl.trim() ? "Enter a job page URL to scrape it." : "";

  // Most recent first (same order as the timeline).
  const visibleWorkHistory = useMemo(() => {
    const normalized = workHistorySearch.trim().toLowerCase();
    if (!normalized) return sortedWorkHistory;
    return sortedWorkHistory.filter((item) => {
      const searchableText = [item.position, item.company].filter(Boolean).join(" ").toLowerCase();
      return searchableText.includes(normalized);
    });
  }, [sortedWorkHistory, workHistorySearch]);
  const sortedEducation = useMemo(
    () => sortEducation(profile.education ?? []),
    [profile.education]
  );
  const activeModelOptions = useMemo(
    () => modelOptionsByProvider[llmSettings.provider] ?? FALLBACK_MODEL_OPTIONS[llmSettings.provider] ?? [],
    [llmSettings.provider, modelOptionsByProvider]
  );
  const activeModelOptionsStatus = modelOptionsStatus[llmSettings.provider] ?? "idle";

  const contentW = PAGE_W - padding * 2;
  const maxH = PAGE_H - padding * 2;

  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  const sortedResumes = useMemo(() => sortResumes(resumes), [resumes]);
  const selectedResume = useMemo(
    () => sortedResumes.find((resume) => resume.id === selectedResumeId) ?? sortedResumes[0],
    [sortedResumes, selectedResumeId]
  );
  const visibleMissingExperienceDetails = useMemo(
    () =>
      missingExperienceDetails.filter(
        (detail) => !dismissedMissingExperienceSkills.includes(detail.skill)
      ),
    [dismissedMissingExperienceSkills, missingExperienceDetails]
  );
  const totalSelectedMissingExperiencePositions = useMemo(
    () =>
      visibleMissingExperienceDetails.reduce(
        (total, detail) =>
          confirmedMissingExperienceSkills.includes(detail.skill)
            ? total + (missingExperienceSelectedPositions[detail.skill]?.length ?? 0)
            : total,
        0
      ),
    [
      visibleMissingExperienceDetails,
      confirmedMissingExperienceSkills,
      missingExperienceSelectedPositions,
    ]
  );
  const workHistoryByPositionCompany = useMemo(
    () =>
      [...workHistory].sort((a, b) => {
        const positionCompare = (a.position || "").localeCompare(b.position || "", undefined, {
          sensitivity: "base",
        });
        if (positionCompare !== 0) return positionCompare;

        return (a.company || "").localeCompare(b.company || "", undefined, {
          sensitivity: "base",
        });
      }),
    [workHistory]
  );

  useEffect(() => {
    document.fonts.ready.then(() => setReady(true));
    if (document.fonts.status === "loaded") setReady(true);
  }, []);

  useEffect(() => {
    const fallback = sortedResumes[0] ?? createResume();

    if (selectedResume?.id === selectedResumeId) return;

    if (!resumes.length) {
      setResumes([fallback]);
    }
    setSelectedResumeId(fallback.id);
    setMarkdown(fallback.content);
  }, [resumes, sortedResumes, selectedResume, selectedResumeId]);

  // Persist every resume-data change to the database, debounced. There's no
  // localStorage copy anymore — the database is the source of truth.
  useEffect(() => {
    async function saveSnapshot(pending) {
      if (syncDisabledRef.current) return;
      // Never run two saves at once; keep only the latest edit queued.
      if (savingRef.current) {
        pendingSyncRef.current = pending;
        return;
      }
      savingRef.current = true;
      try {
        await syncAppStateToDb(getSupabaseClient(), userId, pending);
      } catch (error) {
        // Force a retry on the next edit, and let the user know it didn't save.
        lastSyncedRef.current = null;
        showProfileDataToast("Couldn't save your changes. They'll retry on your next edit.");
        console.error("Cloud sync failed:", error);
      } finally {
        savingRef.current = false;
        const queued = pendingSyncRef.current;
        pendingSyncRef.current = null;
        if (queued) saveSnapshot(queued);
      }
    }

    const snapshot = { profile, workHistory, resumes, selectedResumeId };
    const serialized = JSON.stringify(snapshot);

    // The freshly-loaded state already matches the database; don't write it back.
    if (!syncInitializedRef.current) {
      syncInitializedRef.current = true;
      lastSyncedRef.current = serialized;
      return;
    }
    if (!userId || serialized === lastSyncedRef.current) return;

    const timer = setTimeout(() => {
      lastSyncedRef.current = serialized;
      saveSnapshot(snapshot);
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [resumes, selectedResumeId, profile, workHistory, userId]);

  // The server owns the provider keys, so every provider's model list is
  // fetchable from first load — one pass on mount is all it takes. Also pick
  // the first provider that has a key (xAI → Anthropic → OpenAI → Google) so
  // the default isn't Gemini when only another key is configured.
  useEffect(() => {
    let cancelled = false;

    async function applyPreferredProvider() {
      try {
        const { preferred } = await fetchPreferredLlmProvider();
        if (cancelled || !preferred) return;
        setLlmSettings((current) => {
          // Only replace the bundled startup default so a fast manual change wins.
          if (current.provider !== "gemini") return current;
          return normalizeLlmSettings({
            provider: preferred,
            model: getDefaultModelForProvider(preferred),
          });
        });
      } catch {
        // Keep the bundled default; generation will surface a missing-key error.
      }
    }

    async function loadProviderModels(provider) {
      setModelOptionsStatus((current) => ({ ...current, [provider]: "loading" }));

      try {
        const { options, source } = await fetchProviderModelOptions(provider);
        if (cancelled) return;

        if (!options.length) {
          setModelOptionsStatus((current) => ({ ...current, [provider]: "error" }));
          return;
        }

        setModelOptionsByProvider((current) => ({ ...current, [provider]: options }));
        // "idle" renders as "Showing default models." — accurate when the
        // server answered with its bundled fallback instead of a live listing.
        setModelOptionsStatus((current) => ({
          ...current,
          [provider]: source === "live" ? "ready" : "idle",
        }));
      } catch {
        if (!cancelled) {
          setModelOptionsStatus((current) => ({ ...current, [provider]: "error" }));
        }
      }
    }

    applyPreferredProvider();
    for (const [provider] of LLM_PROVIDERS) loadProviderModels(provider);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeModelOptions.length) return;

    const validIds = activeModelOptions.map(([id]) => id);
    if (validIds.includes(llmSettings.model)) return;

    setLlmSettings((current) => ({
      ...current,
      model: getDefaultModelForProvider(current.provider, modelOptionsByProvider),
    }));
  }, [activeModelOptions, llmSettings.model, llmSettings.provider, modelOptionsByProvider]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const sx = width / PAGE_W;
      const sy = height / PAGE_H;
      setPageScale(Math.min(sx, sy, 1));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!isResumeMenuOpen) return;

    const handleClickOutside = (event) => {
      if (!resumeMenuRef.current?.contains(event.target)) {
        setIsResumeMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isResumeMenuOpen]);

  useEffect(() => () => {
    if (workHistorySaveToastTimeoutRef.current) {
      clearTimeout(workHistorySaveToastTimeoutRef.current);
    }
    if (workHistorySaveToastDebounceRef.current) {
      clearTimeout(workHistorySaveToastDebounceRef.current);
    }
    if (profileDataToastTimeoutRef.current) {
      clearTimeout(profileDataToastTimeoutRef.current);
    }
    if (missingExperienceSaveToastTimeoutRef.current) {
      clearTimeout(missingExperienceSaveToastTimeoutRef.current);
    }
  }, []);

  const { measuredHeight, measureTime } = useMemo(() => {
    if (!ready) return { measuredHeight: 0, measureTime: 0 };
    const t0 = performance.now();
    const h = measureBlocks(blocks, fontSize, contentW, lineHeightMult, sectionSpacing, itemSpacing, separatorSpacing);
    return {
      measuredHeight: Math.round(h),
      measureTime: +(performance.now() - t0).toFixed(2),
    };
  }, [blocks, fontSize, contentW, lineHeightMult, sectionSpacing, itemSpacing, separatorSpacing, ready]);

  const positioned = useMemo(() => {
    if (!ready) return [];
    return layoutBlocks(blocks, fontSize, contentW, padding, lineHeightMult, sectionSpacing, itemSpacing, separatorSpacing);
  }, [blocks, fontSize, contentW, padding, lineHeightMult, sectionSpacing, itemSpacing, separatorSpacing, ready]);

  useEffect(() => {
    if (!ready || !autoFit) return;
    const { fontSize: optFs, lineHeightMult: optLh } = findOptimalFit(blocks, contentW, maxH, 6, 24, sectionSpacing, itemSpacing, separatorSpacing);
    const capped = Math.min(optFs, maxFontSize);
    setFontSize(capped);
    setLineHeightMult(optLh);
  }, [blocks, padding, autoFit, ready, contentW, maxH, maxFontSize, sectionSpacing, itemSpacing, separatorSpacing]);

  const handleSlider = (e) => {
    setAutoFit(false);
    setFontSize(parseFloat(e.target.value));
  };

  const handleLineHeightSlider = (e) => {
    setAutoFit(false);
    setLineHeightMult(parseFloat(e.target.value));
  };

  const handleMarkdownChange = (e) => {
    const nextMarkdown = e.target.value;
    updateSelectedResumeMarkdown(nextMarkdown);
  };

  const handleGenerationInstructionsChange = (value) => {
    setGenerationInstructions(value);
    setMissingExperienceDetails([]);
    setConfirmedMissingExperienceSkills([]);
    setDismissedMissingExperienceSkills([]);
    setMissingExperiencePositionFilters({});
    setMissingExperienceSelectedPositions({});
    setMissingExperienceElaborations({});
    setMissingExperienceSaveToast("");
    setMissingExperienceStatus("");
    setMissingExperienceFailed(false);
    setMissingExperienceStepIndex(-1);
  };

  const updateSelectedResumeMarkdown = (nextMarkdown, nextName) => {
    setMarkdown(nextMarkdown);
    setResumes((current) =>
      current.map((resume) =>
        resume.id === selectedResumeId
          ? {
              ...resume,
              content: nextMarkdown,
              updatedAt: new Date().toISOString(),
              ...(nextName ? { name: nextName } : {}),
            }
          : resume
      )
    );
  };

  const updateProfileField = (field, value) => {
    setProfile((current) => ({ ...current, [field]: value }));
  };

  const toggleVisibleContactField = (field) => {
    setProfile((current) => {
      const visibleFields = current.visibleContactFields ?? DEFAULT_VISIBLE_CONTACT_FIELDS;
      return {
        ...current,
        visibleContactFields: visibleFields.includes(field)
          ? visibleFields.filter((item) => item !== field)
          : [...visibleFields, field],
      };
    });
  };

  const updateLlmSetting = (field, value) => {
    setLlmSettings((current) => {
      if (field === "provider") {
        return {
          ...current,
          provider: value,
          model: getDefaultModelForProvider(value, modelOptionsByProvider),
        };
      }

      return { ...current, [field]: value };
    });
  };

  const showProfileDataToast = (message) => {
    setProfileDataToast(message);

    if (profileDataToastTimeoutRef.current) {
      clearTimeout(profileDataToastTimeoutRef.current);
    }

    profileDataToastTimeoutRef.current = setTimeout(() => {
      setProfileDataToast("");
      profileDataToastTimeoutRef.current = null;
    }, 3000);
  };

  const handleExportProfileData = () => {
    const payload = buildProfileExportPayload({
      profile,
      workHistory,
      resumes,
      selectedResumeId,
      llmSettings,
    });
    const date = new Date().toISOString().slice(0, 10);
    downloadJsonFile(payload, `quick-resume-export-${date}.json`);
    showProfileDataToast("Profile data exported.");
  };

  const handleImportProfileData = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await readFileAsText(file);
      const imported = parseProfileExportFile(text);

      setProfile(imported.profile);
      setWorkHistory(imported.workHistory);
      setResumes(imported.resumes);
      setSelectedResumeId(imported.selectedResumeId);
      setMarkdown(imported.markdown);
      setLlmSettings(imported.llmSettings);
      showProfileDataToast("Profile data imported.");
    } catch (error) {
      showProfileDataToast(error instanceof Error ? error.message : "Import failed.");
    } finally {
      event.target.value = "";
    }
  };

  const handleOpenDeleteAccount = () => {
    setDeleteAccountConfirmText("");
    setIsDeleteAccountOpen(true);
  };

  const handleConfirmDeleteAccount = async (e) => {
    e.preventDefault();
    if (deleteAccountConfirmText.trim() !== DELETE_ACCOUNT_CONFIRM_PHRASE) return;

    // Stop autosave from racing the deletion, wipe the account's data from the
    // database, sign out, and leave for the marketing site.
    syncDisabledRef.current = true;
    try {
      const supabase = getSupabaseClient();
      await deleteUserData(supabase, userId);
      await supabase.auth.signOut();
    } catch (error) {
      console.error("Account deletion failed:", error);
    }
    window.location.assign("/");
  };

  const handleSelectResume = (resumeId) => {
    const resume = resumes.find((item) => item.id === resumeId);
    if (!resume) return;

    setSelectedResumeId(resume.id);
    setMarkdown(resume.content);
    setIsResumeMenuOpen(false);
  };

  const handleDeleteResume = (resumeId) => {
    const remaining = resumes.filter((resume) => resume.id !== resumeId);
    const nextResumes = remaining.length > 0 ? remaining : [createResume()];
    const nextSelected =
      resumeId === selectedResumeId ? sortResumes(nextResumes)[0] : selectedResume;

    setResumes(nextResumes);
    setSelectedResumeId(nextSelected.id);
    setMarkdown(nextSelected.content);
  };

  const handleOpenCreateResume = () => {
    setResumeCompanyDraft("");
    setResumeJobTitleDraft("");
    setIsResumeMenuOpen(false);
    setIsCreateResumeOpen(true);
  };

  const handleCreateResume = (e) => {
    e.preventDefault();

    if (!resumeCompanyDraft.trim() && !resumeJobTitleDraft.trim()) return;

    const resume = createResume(resumeCompanyDraft, resumeJobTitleDraft);
    setResumes((current) => [
      ...current,
      { ...resume, name: getUniqueResumeName(resume.name, current) },
    ]);
    setSelectedResumeId(resume.id);
    setMarkdown(resume.content);
    setResumeCompanyDraft("");
    setResumeJobTitleDraft("");
    setIsCreateResumeOpen(false);
  };

  const handleAddWorkHistory = () => {
    setWorkHistory((current) => [...current, createWorkHistoryItem()]);
  };

  // Jump from the timeline popup to a specific position's edit card. Clears any
  // active search so the target is visible, then scrolls to and highlights it.
  const handleFocusWorkHistoryRole = useCallback((workId) => {
    setActiveMainTab("workHistory");
    setWorkHistorySearch("");
    setHighlightedWorkId(workId);
  }, []);

  // Add a position from a timeline gap, pre-filled with the gap's dates so the
  // new role lands right where the hole is, then jump to it.
  const handleAddPositionForGap = useCallback((prefill) => {
    const item = createWorkHistoryItem(prefill ?? {});
    setWorkHistory((current) => sortWorkHistory([...current, item]));
    setActiveMainTab("workHistory");
    setWorkHistorySearch("");
    setHighlightedWorkId(item.id);
  }, []);

  useEffect(() => {
    if (!highlightedWorkId) return;
    const el = document.getElementById(`work-card-${highlightedWorkId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const timeout = setTimeout(() => setHighlightedWorkId(null), 1800);
    return () => clearTimeout(timeout);
  }, [highlightedWorkId]);

  const handleToggleWorkPresent = (workId, isPresent) => {
    setWorkHistory((current) =>
      current.map((item) =>
        item.id === workId
          ? normalizeWorkHistoryItem({
              ...item,
              endMonth: isPresent ? "" : item.endMonth,
              endYear: isPresent ? "present" : "",
            })
          : item
      )
    );
    if (!isPresent) {
      requestAnimationFrame(() => {
        document.getElementById(`work-end-year-${workId}`)?.focus();
      });
    }
  };

  const handleUpdateWorkHistory = (workId, field, value) => {
    let nextValue = value;
    if (field === "startMonth" || field === "endMonth") {
      nextValue = normalizeWorkMonth(value);
    } else if (field === "startYear" || field === "endYear") {
      nextValue = normalizeWorkYear(value);
    }

    setWorkHistory((current) =>
      current.map((item) =>
        item.id === workId
          ? normalizeWorkHistoryItem({ ...item, [field]: nextValue })
          : item
      )
    );

    if (field === "description") {
      if (workHistorySaveToastDebounceRef.current) {
        clearTimeout(workHistorySaveToastDebounceRef.current);
      }

      workHistorySaveToastDebounceRef.current = setTimeout(() => {
        setWorkHistorySaveToast("Work history saved.");

        if (workHistorySaveToastTimeoutRef.current) {
          clearTimeout(workHistorySaveToastTimeoutRef.current);
        }

        workHistorySaveToastTimeoutRef.current = setTimeout(() => {
          setWorkHistorySaveToast("");
          workHistorySaveToastTimeoutRef.current = null;
        }, 3000);
        workHistorySaveToastDebounceRef.current = null;
      }, 600);
    }
  };

  const handleDeleteWorkHistory = (workId) => {
    setWorkHistory((current) => current.filter((item) => item.id !== workId));
    setReviewingWorkId((current) => (current === workId ? null : current));
    setEnrichingWorkId((current) => (current === workId ? null : current));
    setDeleteConfirmWorkId((current) => (current === workId ? null : current));
  };

  const handleConfirmDeleteWorkHistory = () => {
    if (deleteConfirmWorkId) handleDeleteWorkHistory(deleteConfirmWorkId);
    setDeleteConfirmWorkId(null);
  };

  const showPositionReviewToast = useCallback((message) => {
    setWorkHistorySaveToast(message);
    if (workHistorySaveToastTimeoutRef.current) {
      clearTimeout(workHistorySaveToastTimeoutRef.current);
    }
    workHistorySaveToastTimeoutRef.current = setTimeout(() => {
      setWorkHistorySaveToast("");
      workHistorySaveToastTimeoutRef.current = null;
    }, 3000);
  }, []);

  // "Keep both" / "dates are correct" records the finding's content-signature
  // key on the profile (pruning keys that no longer match anything) so a
  // confirmed pair or a dismissed date warning stays quiet until its dates change.
  const handleKeepBothPositions = useCallback(
    (conflict) => {
      const liveKeys = collectConflictKeys(workHistory);
      setProfile((current) => {
        const kept = (current.conflictAcks ?? []).filter((key) => liveKeys.has(key));
        return { ...current, conflictAcks: [...new Set([...kept, conflict.id])] };
      });
      showPositionReviewToast(
        conflict.b ? "Got it — both positions stay." : "Got it — dates left as is."
      );
    },
    [workHistory, showPositionReviewToast]
  );

  // Merge a duplicate pair using the dates the person picked in the dialog.
  const handleMergePositions = useCallback(
    (conflict, picks) => {
      setWorkHistory((current) => applyDuplicateMerge(current, conflict, picks));
      showPositionReviewToast("Merged into one position.");
    },
    [showPositionReviewToast]
  );

  // Apply a one-click boundary fix to an overlapping pair.
  const handleFixPositionDates = useCallback(
    (conflict, fix) => {
      setWorkHistory((current) => applyBoundaryFix(current, fix));
      showPositionReviewToast("Dates updated.");
    },
    [showPositionReviewToast]
  );

  // The clarity review and enrichment panels share the space under a position's
  // description, so opening one closes the other.
  const handleToggleExperienceReview = (workId) => {
    setReviewingWorkId((current) => (current === workId ? null : workId));
    setEnrichingWorkId(null);
  };

  const handleToggleEnrichExperience = (workId) => {
    setEnrichingWorkId((current) => (current === workId ? null : workId));
    setReviewingWorkId(null);
  };

  // Ask the model which sentences in a position's description are hard to read.
  // Validation (and the step indicator for it) lives in ExperienceReview so the
  // prepare stage can advance after this call returns.
  const handleReviewSentences = useCallback(
    async ({ position, description }) => {
      return callLlmForJson(
        llmSettings,
        buildClarityReviewPrompt({ position, description }),
        null
      );
    },
    [llmSettings]
  );

  // Turn a flagged sentence plus the person's clarification (and any confirmed
  // skills, tools, or collaborators) into a clearer rewrite.
  const handleProposeSentenceRewrite = useCallback(
    async ({ position, sentence, clarification, skills }) => {
      const text = await callLlm(
        llmSettings,
        buildClaritySuggestionPrompt({ position, sentence, clarification, skills }),
        null
      );
      return cleanSuggestedSentence(text);
    },
    [llmSettings]
  );

  // Swap an accepted rewrite into the stored description and confirm with a toast.
  const handleReplaceSentenceInWork = useCallback((workId, original, replacement) => {
    let didReplace = false;
    setWorkHistory((current) =>
      sortWorkHistory(
        current.map((item) => {
          if (item.id !== workId) return item;
          const { description, replaced } = replaceSentence(item.description, original, replacement);
          if (!replaced) return item;
          didReplace = true;
          return normalizeWorkHistoryItem({ ...item, description });
        })
      )
    );

    setWorkHistorySaveToast(didReplace ? "Sentence updated." : "Could not find that sentence to replace.");
    if (workHistorySaveToastTimeoutRef.current) {
      clearTimeout(workHistorySaveToastTimeoutRef.current);
    }
    workHistorySaveToastTimeoutRef.current = setTimeout(() => {
      setWorkHistorySaveToast("");
      workHistorySaveToastTimeoutRef.current = null;
    }, 3000);
  }, []);

  // Ask the model for the first few dead-simple questions about what this person
  // actually does day to day. Grounded in the role, not job-posting boilerplate.
  const handleLoadOpeningQuestions = useCallback(
    async ({ position, company, description, tenureLabel }) => {
      const parsed = await callLlmForJson(
        llmSettings,
        buildOpeningQuestionsPrompt({ position, company, description, tenure: tenureLabel }),
        null
      );
      return validateOpeningQuestions(parsed);
    },
    [llmSettings]
  );

  // Ask the next questions that branch off what the person has answered so far,
  // or get back an "enough" signal that we know enough to write it up.
  const handleLoadFollowupQuestions = useCallback(
    async ({ position, company, description, tenureLabel, transcript, round }) => {
      const parsed = await callLlmForJson(
        llmSettings,
        buildFollowupQuestionsPrompt({
          position,
          company,
          description,
          tenure: tenureLabel,
          transcript,
          round,
          maxRounds: MAX_QA_ROUNDS,
        }),
        null
      );
      return validateFollowupQuestions(parsed, { round });
    },
    [llmSettings]
  );

  // Turn the whole Q&A transcript into 1-3 plainspoken resume bullets.
  const handleComposeEnrichedBullets = useCallback(
    async ({ position, company, description, tenureLabel, transcript }) => {
      const parsed = await callLlmForJson(
        llmSettings,
        buildComposePrompt({ position, company, description, tenure: tenureLabel, transcript }),
        null
      );
      return validateComposedBullets(parsed);
    },
    [llmSettings]
  );

  // Append an accepted bullet to the stored description and confirm with a toast.
  const handleAppendDetailToWork = useCallback((workId, bullet) => {
    let didAppend = false;
    setWorkHistory((current) =>
      sortWorkHistory(
        current.map((item) => {
          if (item.id !== workId) return item;
          const { description, appended } = appendDetailToDescription(item.description, bullet);
          if (!appended) return item;
          didAppend = true;
          return normalizeWorkHistoryItem({ ...item, description });
        })
      )
    );

    setWorkHistorySaveToast(
      didAppend ? "Detail added to the description." : "That detail is already in the description."
    );
    if (workHistorySaveToastTimeoutRef.current) {
      clearTimeout(workHistorySaveToastTimeoutRef.current);
    }
    workHistorySaveToastTimeoutRef.current = setTimeout(() => {
      setWorkHistorySaveToast("");
      workHistorySaveToastTimeoutRef.current = null;
    }, 3000);
  }, []);

  const handleAddEducation = () => {
    setProfile((current) => ({
      ...current,
      education: [...(current.education ?? []), createEducationItem()],
    }));
  };

  const handleUpdateEducation = (eduId, field, value) => {
    const nextValue = field === "year" ? normalizeWorkYear(value) : value;
    setProfile((current) => ({
      ...current,
      education: (current.education ?? []).map((item) =>
        item.id === eduId
          ? normalizeEducationItem({ ...item, [field]: nextValue })
          : item
      ),
    }));
  };

  const handleDeleteEducation = (eduId) => {
    setProfile((current) => ({
      ...current,
      education: (current.education ?? []).filter((item) => item.id !== eduId),
    }));
  };

  const handleScrapeJobPage = async () => {
    if (!scrapeUrl.trim()) return;
    setIsScraping(true);
    setScrapeError("");
    setScrapeSuccess("");

    try {
      // 1. Fetch raw markdown and metadata via the server's Firecrawl proxy
      const scraped = await scrapeJobPage(scrapeUrl.trim());

      // 2. Select the cheapest model depending on the active provider
      const provider = llmSettings.provider;
      let cheapestModel = "";
      if (provider === "openai") {
        cheapestModel = "gpt-5.4-nano";
      } else if (provider === "anthropic") {
        cheapestModel = "claude-haiku-4-5";
      } else if (provider === "xai") {
        cheapestModel = "grok-4.3";
      } else {
        cheapestModel = "gemini-3.1-flash-lite";
      }

      const cleanLlmSettings = {
        ...llmSettings,
        model: cheapestModel,
      };

      // 3. Clean up raw content using the cheapest model
      setScrapeSuccess("Scraped raw text. Cleaning up job description with AI...");

      const cleanPrompt = extractJobDescription({
        title: scraped.title,
        metaDescription: scraped.description,
        rawText: scraped.markdown,
      });

      const cleanedLlmResponse = await callLlm(cleanLlmSettings, cleanPrompt, null);
      const cleanedText = extractCleanedJobDescription(cleanedLlmResponse);

      handleGenerationInstructionsChange(cleanedText);
      setScrapeSuccess("Job description successfully scraped and cleaned!");
      setTimeout(() => {
        setGenerationSourceType("text");
        setScrapeSuccess("");
      }, 1500);

    } catch (error) {
      setScrapeError(error instanceof Error ? error.message : "An error occurred while scraping the page.");
    } finally {
      setIsScraping(false);
    }
  };

  const handleFindMissingExperienceDetails = async () => {
    const jobDescription = generationInstructions.trim();
    if (!jobDescription) {
      setMissingExperienceStatus("Paste a job description first.");
      return;
    }
    if (!workHistory.length) {
      setMissingExperienceStatus("Add work history first so there is something to compare against.");
      return;
    }

    setIsFindingMissingExperience(true);
    setMissingExperienceFailed(false);
    setMissingExperienceStatus("");
    setMissingExperienceStepIndex(0);

    try {
      // Step 1: one LLM call reads the whole posting and compares it against
      // the stored work history, returning gap questions.
      const parsed = await callLlmForJson(
        llmSettings,
        buildMissingExperienceReviewPrompt({ workHistory, jobDescription }),
        null
      );

      // Step 2: validate the questions and connect each to the stored roles it names.
      setMissingExperienceStepIndex(1);
      const details = validateMissingExperienceReview(parsed, workHistory);
      setMissingExperienceDetails(details);
      setConfirmedMissingExperienceSkills([]);
      setDismissedMissingExperienceSkills([]);
      setMissingExperiencePositionFilters({});
      setMissingExperienceSelectedPositions({});
      setMissingExperienceElaborations({});
      setMissingExperienceSaveToast("");
      setMissingExperienceStepIndex(-1);
      setMissingExperienceStatus(
        details.length
          ? `Found ${details.length} way${details.length === 1 ? "" : "s"} to address experience this job asks for.`
          : "Your work history already covers what this job description asks for."
      );
    } catch (error) {
      // Leave missingExperienceStepIndex where it was so the step list shows
      // which stage of the review failed.
      setMissingExperienceFailed(true);
      setMissingExperienceStatus(error instanceof Error ? error.message : "Could not find missing details.");
    } finally {
      setIsFindingMissingExperience(false);
    }
  };

  const handleDismissMissingExperienceDetail = (skill) => {
    setDismissedMissingExperienceSkills((current) =>
      current.includes(skill) ? current : [...current, skill]
    );
    setConfirmedMissingExperienceSkills((current) => current.filter((item) => item !== skill));
    setMissingExperienceSelectedPositions((current) => {
      const { [skill]: _removed, ...remaining } = current;
      return remaining;
    });
    setMissingExperienceElaborations((current) => {
      const { [skill]: _removed, ...remaining } = current;
      return remaining;
    });
  };

  const handleConfirmMissingExperienceDetail = (skill) => {
    setConfirmedMissingExperienceSkills((current) =>
      current.includes(skill) ? current : [...current, skill]
    );
  };

  const handleMissingExperienceElaborationChange = (skill, workId, value) => {
    setMissingExperienceElaborations((current) => ({
      ...current,
      [skill]: {
        ...(current[skill] ?? {}),
        [workId]: value,
      },
    }));
  };

  const handleOpenAddPosition = (skill) => {
    setNewPositionDraft(EMPTY_POSITION_DRAFT);
    setAddPositionForSkill(skill);
  };

  const handleCloseAddPosition = () => {
    setAddPositionForSkill(null);
    setNewPositionDraft(EMPTY_POSITION_DRAFT);
  };

  const handleNewPositionDraftChange = (field, value) => {
    setNewPositionDraft((current) => ({ ...current, [field]: value }));
  };

  const handleNewPositionPresentToggle = (isPresent) => {
    setNewPositionDraft((current) => ({
      ...current,
      endMonth: isPresent ? "" : current.endMonth,
      endYear: isPresent ? "present" : "",
    }));
  };

  const handleAddMissingPosition = (e) => {
    e.preventDefault();
    const skill = addPositionForSkill;
    if (!skill) return;

    const position = newPositionDraft.position.trim();
    const company = newPositionDraft.company.trim();
    if (!position && !company) return;

    const item = createWorkHistoryItem({
      position,
      company,
      startMonth: newPositionDraft.startMonth,
      startYear: newPositionDraft.startYear,
      endMonth: newPositionDraft.endMonth,
      endYear: newPositionDraft.endYear,
    });

    setWorkHistory((current) => sortWorkHistory([...current, item]));
    // Auto-select the new role for this question and clear the search so it stays visible,
    // letting the user pop straight back to filling in the answer that prompted it.
    setMissingExperienceSelectedPositions((current) => ({
      ...current,
      [skill]: [...(current[skill] ?? []), item.id],
    }));
    setMissingExperiencePositionFilters((current) => ({ ...current, [skill]: "" }));
    handleCloseAddPosition();
  };

  const handleMissingExperiencePositionFilterChange = (skill, value) => {
    setMissingExperiencePositionFilters((current) => ({
      ...current,
      [skill]: value,
    }));
  };

  const handleToggleMissingExperiencePosition = (skill, workId) => {
    setMissingExperienceSelectedPositions((current) => {
      const selected = current[skill] ?? [];
      const nextSelected = selected.includes(workId)
        ? selected.filter((id) => id !== workId)
        : [...selected, workId];

      return {
        ...current,
        [skill]: nextSelected,
      };
    });
  };

  const showMissingExperienceSaveToast = (message) => {
    setMissingExperienceSaveToast(message);

    if (missingExperienceSaveToastTimeoutRef.current) {
      clearTimeout(missingExperienceSaveToastTimeoutRef.current);
    }

    missingExperienceSaveToastTimeoutRef.current = setTimeout(() => {
      setMissingExperienceSaveToast("");
      missingExperienceSaveToastTimeoutRef.current = null;
    }, 4000);
  };

  const handleSaveMissingExperienceDetails = async () => {
    const confirmedDetails = visibleMissingExperienceDetails.filter((detail) =>
      confirmedMissingExperienceSkills.includes(detail.skill)
    );

    // One task per (question, selected position). The typed answer, if any, gets
    // rewritten by the model; otherwise we fall back to the generic detail.
    const tasks = [];
    for (const detail of confirmedDetails) {
      const selectedWorkIds = missingExperienceSelectedPositions[detail.skill] ?? [];
      for (const workId of selectedWorkIds) {
        tasks.push({
          detail,
          workId,
          answer: (missingExperienceElaborations[detail.skill]?.[workId] ?? "").trim(),
        });
      }
    }

    if (tasks.length === 0) {
      setMissingExperienceStatus("Pick at least one position for a question before saving.");
      return;
    }

    setIsSavingMissingExperience(true);
    setMissingExperienceStatus("");

    try {
      const resolved = await Promise.all(
        tasks.map(async (task) => {
          const fallback = task.detail.plainspokenDetail.replace(/^[-•]\s*/, "").trim();
          if (!task.answer) {
            return { workId: task.workId, line: fallback };
          }
          const text = await callLlm(
            llmSettings,
            formatExperienceElaboration({ question: task.detail.question, answer: task.answer }),
            null
          );
          return { workId: task.workId, line: cleanFormattedDetail(text) || fallback };
        })
      );

      const linesByWorkId = new Map();
      for (const { workId, line } of resolved) {
        if (!line) continue;
        const existing = linesByWorkId.get(workId) ?? [];
        existing.push(line);
        linesByWorkId.set(workId, existing);
      }

      let savedCount = 0;
      const nextWorkHistory = sortWorkHistory(
        workHistory.map((item) => {
          const newLines = linesByWorkId.get(item.id);
          if (!newLines || newLines.length === 0) return item;

          // Shared with the enrichment flow: matches the description's existing
          // bullet-marker style and skips duplicates (ignoring markers and case).
          let description = item.description;
          let added = 0;
          for (const line of newLines) {
            const result = appendDetailToDescription(description, line);
            if (!result.appended) continue;
            description = result.description;
            added += 1;
          }
          if (added === 0) return item;

          savedCount += added;
          return normalizeWorkHistoryItem({ ...item, description });
        })
      );

      setWorkHistory(nextWorkHistory);

      // Drop the questions we just saved so they leave the list (and the whole
      // section disappears once every question has been handled).
      const savedSkills = new Set(
        confirmedDetails
          .filter((detail) => (missingExperienceSelectedPositions[detail.skill] ?? []).length > 0)
          .map((detail) => detail.skill)
      );
      setDismissedMissingExperienceSkills((current) => {
        const additions = [...savedSkills].filter((skill) => !current.includes(skill));
        return additions.length ? [...current, ...additions] : current;
      });
      setConfirmedMissingExperienceSkills((current) =>
        current.filter((skill) => !savedSkills.has(skill))
      );
      setMissingExperienceSelectedPositions((current) => {
        const next = { ...current };
        for (const skill of savedSkills) delete next[skill];
        return next;
      });
      setMissingExperienceElaborations((current) => {
        const next = { ...current };
        for (const skill of savedSkills) delete next[skill];
        return next;
      });

      const positionLabel = savedCount === 1 ? "position" : "positions";
      showMissingExperienceSaveToast(
        savedCount > 0
          ? `Saved to ${savedCount} ${positionLabel}.`
          : "Those details were already saved."
      );
    } catch (error) {
      setMissingExperienceStatus(
        error instanceof Error ? error.message : "Could not save those experience details."
      );
    } finally {
      setIsSavingMissingExperience(false);
    }
  };

  const handleImportResume = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportStatus("Reading resume file...");

    try {
      const base64 = await readFileAsBase64(file);
      const importFile = {
        name: file.name,
        mimeType: resolveImportMimeType(file),
        base64,
      };

      // Word/PowerPoint/OpenDocument files can't be sent to the chat providers
      // directly; Mistral OCR turns them into markdown first, and the selected
      // model then extracts from that text instead of the file.
      let ocrText = null;
      if (needsMistralOcr(file)) {
        setImportStatus("Converting the file to text with Mistral OCR...");
        ocrText = await callMistralOcr(importFile);
      }

      setImportStatus("Asking the model to extract profile and work history...");
      const imported = await callLlmForJson(llmSettings, importResume(ocrText), ocrText ? null : importFile);
      const importedProfile = coerceImportedProfile(imported.profile);
      const importedHistory = normalizeStoredList(imported.workHistory, []).map(normalizeWorkHistoryItem);

      setProfile((current) => {
        const nextProfile = {
          ...current,
          ...Object.fromEntries(
            Object.entries(importedProfile)
              .filter(([key, value]) => key !== "education" && value)
          ),
        };
        if (Array.isArray(importedProfile.education)) {
          nextProfile.education = mergeEducation(current.education ?? [], importedProfile.education);
        }
        return nextProfile;
      });
      // Entries matching an existing position's title + company + dates (typo-
      // tolerant) fold in automatically instead of piling up as duplicates.
      setWorkHistory((current) => mergeImportedWorkHistory(current, importedHistory).merged);
      const { mergedCount } = mergeImportedWorkHistory(workHistory, importedHistory);
      const mergedNote =
        mergedCount > 0
          ? ` ${mergedCount} duplicate${mergedCount === 1 ? " was" : "s were"} merged automatically.`
          : "";
      setImportStatus(
        `Imported ${importedHistory.length} role${importedHistory.length === 1 ? "" : "s"} from ${file.name}.${mergedNote}`
      );
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsImporting(false);
      event.target.value = "";
    }
  };

  const handleGenerateMarkdown = async () => {
    setIsGenerating(true);
    setGenerateFailed(false);
    setGenerateStatus("");
    setGenerateStepIndex(0);

    try {
      // Step 1: read the job description once — the company/position for the
      // saved resume's title plus the key responsibilities and requirements
      // that the later steps rank bullets against and frame the summary with.
      const jobAnalysis = validateJobAnalysis(
        await callLlmForJson(llmSettings, buildJobAnalysisPrompt(generationInstructions), null)
      );
      const resumeTitle = titleGeneratedResume(jobAnalysis.company, jobAnalysis.position);

      // Deterministic, non-LLM rule for which roles must appear so the resume
      // shows continuous, current employment and covers recent gaps.
      const coverage = summarizeCoverage(workHistory);

      // Step 2: choose roles and bullets, each role's bullets ordered
      // most-applicable-first for this specific job.
      setGenerateStepIndex(1);
      const selectionJson = await callLlmForJson(
        llmSettings,
        selectRankedEvidence({ profile, workHistory, jobAnalysis, instructions: generationInstructions, coverage }),
        null
      );
      const selectedEvidence = ensureRequiredRolesSelected(
        validateSelectedResumeEvidence(selectionJson, profile),
        coverage,
        workHistory
      );

      // Step 3: compose the markdown from the pre-ranked evidence.
      setGenerateStepIndex(2);
      const text = await callLlm(
        llmSettings,
        composeResume({
          profile,
          selectedEvidence,
          jobAnalysis,
          instructions: generationInstructions,
          coverage,
        }),
        null
      );
      const nextMarkdown = text.replace(/^```(?:markdown)?\s*/i, "").replace(/```$/i, "").trim();
      // Save each generation as its own resume so existing resumes are never overwritten.
      const generatedResume = {
        ...createResume(jobAnalysis.company, jobAnalysis.position),
        name: resumeTitle,
        content: nextMarkdown,
        updatedAt: new Date().toISOString(),
      };
      setResumes((current) => [
        ...current,
        { ...generatedResume, name: getUniqueResumeName(generatedResume.name, current) },
      ]);
      setSelectedResumeId(generatedResume.id);
      setMarkdown(nextMarkdown);
      setGenerateStepIndex(-1);
      setGenerateStatus("Generated a new resume.");
      setActiveMainTab("resume");
      setActiveResumeTab("editor");
    } catch (error) {
      // Leave generateStepIndex where it was so the step list shows which
      // stage of the pipeline failed.
      setGenerateFailed(true);
      setGenerateStatus(error instanceof Error ? error.message : "Generation failed.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExportPdf = useCallback(() => {
    printResumePage(
      pageRef.current,
      buildResumeExportName({
        fullName: profile.name,
        markdown,
        company: selectedResume?.company,
        jobTitle: selectedResume?.jobTitle,
        updatedAt: selectedResume?.updatedAt,
      })
    );
  }, [markdown, profile.name, selectedResume]);

  const fits = measuredHeight <= maxH;
  const pct = Math.min((measuredHeight / maxH) * 100, 100);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {showOnboarding && <Onboarding onComplete={completeOnboarding} />}
      <header className="shrink-0 border-b border-neutral-800 bg-neutral-950 px-4 py-3 text-neutral-50">
        <div className="flex flex-wrap items-center gap-2">
          {[
            ["workHistory", "Work history"],
            ["education", "Education"],
            ["profile", "Profile"],
            ["ai", "Generate Resume"],
            ["resume", "View Resumes"],
            ["settings", "Settings"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveMainTab(key)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                activeMainTab === key
                  ? "border-neutral-600 bg-neutral-800 text-neutral-50"
                  : "border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-50"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className="ml-auto rounded-lg border border-neutral-700 p-2 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? (
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M10 2a.75.75 0 01.75.75v1a.75.75 0 01-1.5 0v-1A.75.75 0 0110 2zM10 15a.75.75 0 01.75.75v1a.75.75 0 01-1.5 0v-1A.75.75 0 0110 15zM10 6a4 4 0 100 8 4 4 0 000-8zM15.657 5.404a.75.75 0 10-1.06-1.06l-.708.707a.75.75 0 001.06 1.06l.708-.707zM6.11 14.895a.75.75 0 10-1.06-1.06l-.708.707a.75.75 0 001.06 1.06l.708-.707zM18 10a.75.75 0 01-.75.75h-1a.75.75 0 010-1.5h1A.75.75 0 0118 10zM5 10a.75.75 0 01-.75.75h-1a.75.75 0 010-1.5h1A.75.75 0 015 10zM14.596 15.657a.75.75 0 001.06-1.06l-.707-.708a.75.75 0 00-1.06 1.06l.707.708zM5.105 6.11a.75.75 0 001.06-1.06l-.707-.708a.75.75 0 00-1.06 1.06l.707.708z"
                  clipRule="evenodd"
                />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 116.647 1.921a.75.75 0 01.808.083z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col sm:flex-row bg-neutral-900 text-neutral-50 min-h-0 overflow-hidden">
        {/* ── Mobile tab bar ─────────────────────────── */}
        {activeMainTab === "resume" && (
          <div className="flex gap-2 px-4 py-2 sm:hidden border-b border-neutral-800 shrink-0">
            {[["editor", "Editor"], ["preview", "Preview"]].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveResumeTab(key)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium uppercase tracking-widest transition-colors ${
                  activeResumeTab === key
                    ? "border-neutral-600 bg-neutral-800 text-neutral-50"
                    : "border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* ── Markdown editor ─────────────────────────── */}
        <div className={`relative flex-1 min-w-0 self-stretch border-r border-neutral-800 flex-col ${activeMainTab === "resume" && activeResumeTab === "editor" ? "flex" : "hidden"} ${activeMainTab === "resume" ? "sm:flex" : "sm:hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Markdown
            </p>
          </div>
          <textarea
            value={markdown}
            onChange={handleMarkdownChange}
            spellCheck={false}
            className="flex-1 bg-transparent text-neutral-300 text-sm font-mono leading-relaxed p-4 resize-none outline-none ring-0 focus:outline-none focus:ring-0 border-none placeholder-neutral-600 pagefit-scrollbar"
            style={{ caretColor: "currentColor" }}
          />
        </div>

        {/* ── Profile ─────────────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "profile" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Profile
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Contact details and the basic info shown on generated resumes.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pagefit-scrollbar">
            <div className="mx-auto max-w-3xl space-y-5">
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Contact info
                </h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {[
                    ["name", "Name", "Your name"],
                    ["headline", "Headline", "Product engineer"],
                    ["location", "Location", "City, ST"],
                    ["email", "Email", "you@example.com"],
                    ["phone", "Phone", "(555) 123-4567"],
                    ["linkedin", "LinkedIn", "linkedin.com/in/you"],
                    ["github", "GitHub", "github.com/you"],
                    ["website", "Website", "your-site.com"],
                  ].map(([field, label, placeholder]) => (
                    <label key={field} className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        {label}
                      </span>
                      <input
                        type="text"
                        value={profile[field] ?? ""}
                        onChange={(e) => updateProfileField(field, e.target.value)}
                        placeholder={placeholder}
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Show on every generated resume
                </h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {CONTACT_FIELDS.map(([field, label]) => (
                    <label key={field} className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-300">
                      <input
                        type="checkbox"
                        checked={(profile.visibleContactFields ?? []).includes(field)}
                        onChange={() => toggleVisibleContactField(field)}
                        className="rounded border-neutral-600 bg-neutral-900 text-amber-400 focus:ring-amber-400"
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
                  <p className="text-xs uppercase tracking-widest text-neutral-500">
                    Contact line preview
                  </p>
                  <p className="mt-1 text-sm text-neutral-300">
                    {getVisibleContactLine(profile) || "Select fields and add details to build a contact line."}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Work history ────────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "workHistory" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Work History
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                Reusable roles available to every generated resume.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20">
                <input
                  type="file"
                  accept="application/pdf,image/*,.doc,.docx,.ppt,.pptx,.odt,.odp"
                  onChange={handleImportResume}
                  disabled={isImporting}
                  className="sr-only"
                />
                {isImporting ? "Importing..." : "Import Resume"}
              </label>
              <button
                type="button"
                onClick={handleAddWorkHistory}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
              >
                Add Position
              </button>
            </div>
          </div>

          {sortedWorkHistory.length > 0 && (
            <div className="px-4 py-3 border-b border-neutral-800 space-y-3">
              <PositionReviewPrompt
                conflicts={workConflicts}
                onOpen={() => setIsPositionReviewOpen(true)}
              />
              <WorkHistoryTimeline
                workHistory={sortedWorkHistory}
                onSelectRole={handleFocusWorkHistoryRole}
                onAddPosition={handleAddPositionForGap}
              />
              <input
                type="text"
                value={workHistorySearch}
                onChange={(e) => setWorkHistorySearch(e.target.value)}
                placeholder="Search positions or companies"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
              />
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 space-y-4 pagefit-scrollbar">
            {importStatus && (
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4 text-sm text-neutral-400">
                {importStatus}
              </div>
            )}
            {sortedWorkHistory.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-700 p-4 text-sm text-neutral-500">
                Add every role you want available for this resume.
              </div>
            ) : visibleWorkHistory.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-700 p-4 text-sm text-neutral-500">
                No positions match that search.
              </div>
            ) : (
              visibleWorkHistory.map((item) => {
                const interval = getRoleInterval(item);
                const tenureLabel = interval.dated
                  ? formatMonthSpan(interval.end - interval.start + 1)
                  : "";
                const sparse = isSparseDescription(item.description);

                return (
                <div
                  key={item.id}
                  id={`work-card-${item.id}`}
                  className={`rounded-xl border bg-neutral-950/40 p-4 transition-shadow duration-500 ${
                    highlightedWorkId === item.id
                      ? "border-blue-500 ring-2 ring-blue-500/60"
                      : "border-neutral-800"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleExperienceReview(item.id)}
                        disabled={!item.description.trim()}
                        title={
                          item.description.trim()
                            ? "Ask the model to flag hard-to-read sentences"
                            : "Add a description first to review it."
                        }
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          reviewingWorkId === item.id
                            ? "border-blue-500 bg-blue-500/20 text-blue-700 dark:text-blue-200"
                            : "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20"
                        }`}
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                          <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
                        </svg>
                        {reviewingWorkId === item.id ? "Reviewing for clarity" : "Review for clarity"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleEnrichExperience(item.id)}
                        disabled={!item.position.trim()}
                        title={
                          !item.position.trim()
                            ? "Add a position title first so we know what this job usually involves."
                            : sparse
                              ? "This entry looks light — answer a few quick questions to surface experience you haven't written down yet."
                              : "Answer a few quick questions to surface experience you haven't written down yet."
                        }
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          enrichingWorkId === item.id
                            ? "border-violet-500 bg-violet-500/20 text-violet-700 dark:text-violet-200"
                            : "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300 hover:bg-violet-500/20"
                        }`}
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                          <path fillRule="evenodd" d="M15.98 1.804a1 1 0 0 0-1.96 0l-.24 1.192a1 1 0 0 1-.784.785l-1.192.238a1 1 0 0 0 0 1.962l1.192.238a1 1 0 0 1 .785.785l.238 1.192a1 1 0 0 0 1.962 0l.238-1.192a1 1 0 0 1 .785-.785l1.192-.238a1 1 0 0 0 0-1.962l-1.192-.238a1 1 0 0 1-.785-.785l-.238-1.192ZM6.949 5.684a1 1 0 0 0-1.898 0l-.683 2.051a1 1 0 0 1-.633.633l-2.051.683a1 1 0 0 0 0 1.898l2.051.684a1 1 0 0 1 .633.632l.683 2.051a1 1 0 0 0 1.898 0l.683-2.051a1 1 0 0 1 .633-.633l2.051-.683a1 1 0 0 0 0-1.898l-2.051-.683a1 1 0 0 1-.633-.633L6.95 5.684ZM13.949 13.684a1 1 0 0 0-1.898 0l-.184.551a1 1 0 0 1-.632.633l-.551.183a1 1 0 0 0 0 1.898l.551.183a1 1 0 0 1 .633.633l.183.551a1 1 0 0 0 1.898 0l.184-.551a1 1 0 0 1 .632-.633l.551-.183a1 1 0 0 0 0-1.898l-.551-.184a1 1 0 0 1-.633-.632l-.183-.551Z" clipRule="evenodd" />
                        </svg>
                        {enrichingWorkId === item.id ? "Expanding experience" : "Expand experience"}
                        {sparse && enrichingWorkId !== item.id && item.position.trim() && (
                          <span
                            className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmWorkId(item.id)}
                      className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>

                  <div className="space-y-3">
                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Position
                      </span>
                      <input
                        type="text"
                        value={item.position}
                        onChange={(e) => handleUpdateWorkHistory(item.id, "position", e.target.value)}
                        placeholder="Marketing Manager"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Company
                      </span>
                      <input
                        type="text"
                        value={item.company}
                        onChange={(e) => handleUpdateWorkHistory(item.id, "company", e.target.value)}
                        placeholder="Company name"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="block text-xs text-neutral-500 mb-1">
                          Start Month
                        </span>
                        <select
                          value={normalizeWorkMonth(item.startMonth)}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "startMonth", e.target.value)}
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                        >
                          <option value="">No month</option>
                          {MONTH_SELECT_OPTIONS.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="block">
                        <span className="block text-xs text-neutral-500 mb-1">
                          Start Year
                        </span>
                        <input
                          type="text"
                          value={item.startYear ?? ""}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "startYear", e.target.value)}
                          placeholder="2022"
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                        />
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="block text-xs text-neutral-500 mb-1">
                          End Month
                        </span>
                        <select
                          value={item.endYear === "present" ? "" : normalizeWorkMonth(item.endMonth)}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "endMonth", e.target.value)}
                          disabled={item.endYear === "present"}
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <option value="">No month</option>
                          {MONTH_SELECT_OPTIONS.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="block">
                        <span className="block text-xs text-neutral-500 mb-1">
                          End Year
                        </span>
                        <input
                          id={`work-end-year-${item.id}`}
                          type="text"
                          value={item.endYear === "present" ? "" : item.endYear ?? ""}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "endYear", e.target.value)}
                          disabled={item.endYear === "present"}
                          placeholder={item.endYear === "present" ? "Present" : "2024"}
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </label>
                    </div>

                    <label className="flex items-center gap-2 text-sm text-neutral-300">
                      <input
                        type="checkbox"
                        checked={item.endYear === "present"}
                        onChange={(e) => handleToggleWorkPresent(item.id, e.target.checked)}
                        className="rounded border-neutral-600 bg-neutral-900 text-amber-400 focus:ring-amber-400"
                      />
                      Present — I currently work here
                    </label>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Description
                      </span>
                      <textarea
                        value={item.description}
                        onChange={(e) => handleUpdateWorkHistory(item.id, "description", e.target.value)}
                        placeholder="Describe the responsibilities, accomplishments, and results from this role."
                        rows={4}
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 resize-none pagefit-scrollbar"
                      />
                    </label>

                    {reviewingWorkId === item.id && (
                      <ExperienceReview
                        key={item.id}
                        position={item.position}
                        description={item.description}
                        reviewSentences={handleReviewSentences}
                        proposeRewrite={handleProposeSentenceRewrite}
                        onAcceptSentence={(original, replacement) =>
                          handleReplaceSentenceInWork(item.id, original, replacement)
                        }
                        onClose={() => setReviewingWorkId(null)}
                      />
                    )}

                    {enrichingWorkId === item.id && (
                      <EnrichExperience
                        key={item.id}
                        position={item.position}
                        company={item.company}
                        description={item.description}
                        tenureLabel={tenureLabel}
                        loadOpening={handleLoadOpeningQuestions}
                        loadFollowups={handleLoadFollowupQuestions}
                        composeBullets={handleComposeEnrichedBullets}
                        onAcceptBullet={(bullet) => handleAppendDetailToWork(item.id, bullet)}
                        onClose={() => setEnrichingWorkId(null)}
                      />
                    )}
                  </div>
                </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── Education ───────────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "education" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Education
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                Degrees and certifications available to every generated resume.
              </p>
            </div>
            <button
              type="button"
              onClick={handleAddEducation}
              className="shrink-0 rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
            >
              Add Education
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 pagefit-scrollbar">
            {sortedEducation.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-700 p-4 text-sm text-neutral-500">
                Add any degrees or certifications you want available for your resumes.
              </div>
            ) : (
              sortedEducation.map((item) => (
                <div key={item.id} className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                  <div className="flex justify-end mb-3">
                    <button
                      type="button"
                      onClick={() => handleDeleteEducation(item.id)}
                      className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>

                  <div className="space-y-3">
                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        School
                      </span>
                      <input
                        type="text"
                        value={item.school}
                        onChange={(e) => handleUpdateEducation(item.id, "school", e.target.value)}
                        placeholder="University of California, Berkeley"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Degree or Certificate
                      </span>
                      <input
                        type="text"
                        value={item.degree}
                        onChange={(e) => handleUpdateEducation(item.id, "degree", e.target.value)}
                        placeholder="B.S. in Computer Science"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Year
                      </span>
                      <input
                        type="text"
                        value={item.year ?? ""}
                        onChange={(e) => handleUpdateEducation(item.id, "year", e.target.value)}
                        placeholder="2020"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Description
                      </span>
                      <textarea
                        value={item.description}
                        onChange={(e) => handleUpdateEducation(item.id, "description", e.target.value)}
                        placeholder="Honors, GPA, relevant coursework, or activities (optional)."
                        rows={3}
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 resize-none pagefit-scrollbar"
                      />
                    </label>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Generate resume ─────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "ai" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Generate Resume
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Generate a resume from your profile, work history, and the target role.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pagefit-scrollbar">
            <div className="mx-auto max-w-3xl space-y-5">
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-neutral-200">
                      Job description
                    </h2>
                    <p className="mt-1 text-xs text-neutral-500">
                      The saved resume title is extracted from this description as company, position, and generation date.
                    </p>
                  </div>
                  <div className="flex gap-1 p-0.5 bg-neutral-900 rounded-lg w-fit shrink-0 border border-neutral-800">
                    <button
                      type="button"
                      onClick={() => setGenerationSourceType("text")}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                        generationSourceType === "text"
                          ? "bg-neutral-800 text-neutral-100 border border-neutral-700/50 shadow-sm"
                          : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      Paste Text
                    </button>
                    <button
                      type="button"
                      onClick={() => setGenerationSourceType("url")}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                        generationSourceType === "url"
                          ? "bg-neutral-800 text-neutral-100 border border-neutral-700/50 shadow-sm"
                          : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      Scrape URL
                    </button>
                  </div>
                </div>

                {generationSourceType === "text" ? (
                  <label className="mt-4 block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Job description
                    </span>
                    <textarea
                      value={generationInstructions}
                      onChange={(e) => handleGenerationInstructionsChange(e.target.value)}
                      onPaste={(e) => {
                        const pasted = e.clipboardData.getData("text");
                        if (!pasted) return;
                        e.preventDefault();
                        const cleaned = collapseBlankLines(pasted);
                        const target = e.target;
                        const { selectionStart, selectionEnd, value } = target;
                        const nextValue =
                          value.slice(0, selectionStart) + cleaned + value.slice(selectionEnd);
                        const nextCursor = selectionStart + cleaned.length;
                        flushSync(() => handleGenerationInstructionsChange(nextValue));
                        target.setSelectionRange(nextCursor, nextCursor);
                      }}
                      placeholder="Paste a job description or notes about the role you want to target."
                      rows={7}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 resize-none pagefit-scrollbar"
                    />
                  </label>
                ) : (
                  <div className="mt-4 space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex-1">
                        <label className="block">
                          <span className="block text-xs text-neutral-500 mb-1">
                            Job Page URL
                          </span>
                          <input
                            type="url"
                            value={scrapeUrl}
                            onChange={(e) => setScrapeUrl(e.target.value)}
                            placeholder="https://example.com/careers/software-engineer..."
                            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                          />
                        </label>
                      </div>
                      <div className="shrink-0">
                        <button
                          type="button"
                          onClick={handleScrapeJobPage}
                          disabled={isScraping || !scrapeUrl.trim()}
                          title={scrapeDisabledReason || undefined}
                          className="w-full sm:w-auto rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:text-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 h-[38px] flex items-center justify-center gap-1.5"
                        >
                          {isScraping ? (
                            <>
                              <svg className="animate-spin h-4 w-4 text-neutral-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                              <span>Scraping...</span>
                            </>
                          ) : (
                            <span>Scrape Page</span>
                          )}
                        </button>
                      </div>
                    </div>

                    {!isScraping && scrapeDisabledReason && (
                      <p className="text-xs text-neutral-500">{scrapeDisabledReason}</p>
                    )}

                    {scrapeError && (
                      <p className="text-xs text-red-400 font-medium">
                        {scrapeError}
                      </p>
                    )}

                    {scrapeSuccess && (
                      <p className="text-xs text-emerald-400 font-medium">
                        {scrapeSuccess}
                      </p>
                    )}

                  </div>
                )}
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Address missing experience
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Reads everything this job asks for — responsibilities, leadership, stakeholders, ways of working, tools — and finds where your existing roles can say more. Each question connects a gap to the role where it probably happened.
                </p>
                <button
                  type="button"
                  onClick={handleFindMissingExperienceDetails}
                  disabled={isFindingMissingExperience || !generationInstructions.trim() || sortedWorkHistory.length === 0}
                  title={findMissingDisabledReason || undefined}
                  className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isFindingMissingExperience ? "Reviewing the job description..." : "Address missing experience"}
                </button>
                {!isFindingMissingExperience && findMissingDisabledReason && (
                  <p className="mt-2 text-xs text-neutral-500">{findMissingDisabledReason}</p>
                )}
                <PipelineSteps
                  steps={MISSING_EXPERIENCE_STEPS}
                  stepIndex={missingExperienceStepIndex}
                  failed={missingExperienceFailed}
                />
                {missingExperienceStatus && (
                  <p
                    role="status"
                    className={`mt-3 text-sm ${missingExperienceFailed ? "text-red-400 font-medium" : "text-neutral-400"}`}
                  >
                    {missingExperienceStatus}
                  </p>
                )}
                {missingExperienceSaveToast && (
                  <div role="status" className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-100">
                    {missingExperienceSaveToast}
                  </div>
                )}
                {visibleMissingExperienceDetails.length > 0 && (
                  <div className="mt-4 space-y-3">
                    {visibleMissingExperienceDetails.map((detail) => (
                      <div key={detail.skill} className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
                        {(() => {
                          const hasConfirmedExperience = confirmedMissingExperienceSkills.includes(detail.skill);

                          return (
                            <>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <span className="inline-block rounded-full border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                              {MISSING_EXPERIENCE_KIND_LABELS[detail.kind] ?? "Experience"}
                            </span>
                            <p className="mt-1.5 text-sm font-medium text-neutral-200">
                              {detail.question}
                            </p>
                            {detail.whyItMatters && (
                              <p className="mt-1 text-xs text-neutral-500">
                                {detail.whyItMatters}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              onClick={() => handleConfirmMissingExperienceDetail(detail.skill)}
                              disabled={hasConfirmedExperience}
                              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                                hasConfirmedExperience
                                  ? "cursor-default border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-200"
                                  : "border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                              }`}
                            >
                              Yes
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDismissMissingExperienceDetail(detail.skill)}
                              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                            >
                              No
                            </button>
                          </div>
                        </div>
                        {hasConfirmedExperience && (
                          <div className="mt-3">
                            <p className="text-xs text-neutral-500">
                              Which positions should this be added to? Select a role to add an example from it.
                            </p>
                            {(() => {
                              const positionFilter = missingExperiencePositionFilters[detail.skill] ?? "";
                              const normalizedPositionFilter = positionFilter.trim().toLowerCase();
                              // The review names the roles where this gap probably happened;
                              // surface those first so the person starts from the likely memory.
                              const suggestedWhyByWorkId = new Map(
                                (detail.likelyRoles ?? []).map((role) => [role.workId, role.why])
                              );
                              const filteredWorkHistory = workHistoryByPositionCompany
                                .filter((item) => {
                                  const searchableText = [item.position, item.company].filter(Boolean).join(" ").toLowerCase();
                                  return !normalizedPositionFilter || searchableText.includes(normalizedPositionFilter);
                                })
                                .sort(
                                  (a, b) =>
                                    Number(suggestedWhyByWorkId.has(b.id)) - Number(suggestedWhyByWorkId.has(a.id))
                                );
                              const selectedWorkIdSet = new Set(missingExperienceSelectedPositions[detail.skill] ?? []);
                              const detailText = normalizeDetailForComparison(detail.plainspokenDetail);

                              return (
                                <>
                                  <input
                                    type="text"
                                    value={positionFilter}
                                    onChange={(e) => handleMissingExperiencePositionFilterChange(detail.skill, e.target.value)}
                                    placeholder="Search positions or companies"
                                    className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                                  />
                                  <div className="mt-2 max-h-96 overflow-y-auto rounded-lg border border-neutral-800 pagefit-scrollbar">
                                    {filteredWorkHistory.length === 0 ? (
                                      <p className="px-3 py-2 text-sm text-neutral-500">
                                        No positions match that search.
                                      </p>
                                    ) : (
                                      filteredWorkHistory.map((item) => {
                                        const hasDetail = splitDescriptionIntoDetails(item.description).some(
                                          (line) => normalizeDetailForComparison(line) === detailText
                                        );
                                        const isSelected = selectedWorkIdSet.has(item.id);
                                        const roleLabel = [item.position, item.company].filter(Boolean).join(" at ") || "Untitled role";
                                        const elaboration = missingExperienceElaborations[detail.skill]?.[item.id] ?? "";

                                        return (
                                          <div key={item.id} className="border-b border-neutral-800 last:border-b-0">
                                            <button
                                              type="button"
                                              onClick={() => handleToggleMissingExperiencePosition(detail.skill, item.id)}
                                              disabled={hasDetail}
                                              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                                                hasDetail
                                                  ? "cursor-default bg-amber-500/10 text-amber-800 dark:text-amber-100"
                                                  : isSelected
                                                    ? "bg-amber-500/10 text-amber-800 dark:text-amber-100 hover:bg-amber-500/20"
                                                  : "bg-neutral-950 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                                              }`}
                                            >
                                              <input
                                                type="checkbox"
                                                checked={hasDetail || isSelected}
                                                readOnly
                                                className="rounded border-neutral-600 bg-neutral-900 text-amber-400 focus:ring-amber-400"
                                              />
                                              <span>{roleLabel}</span>
                                              {suggestedWhyByWorkId.has(item.id) && (
                                                <span
                                                  title={suggestedWhyByWorkId.get(item.id) || undefined}
                                                  className="ml-auto shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300"
                                                >
                                                  Suggested
                                                </span>
                                              )}
                                            </button>
                                            {isSelected && !hasDetail && (
                                              <div className="border-t border-neutral-800/60 bg-neutral-950 px-3 py-3">
                                                <textarea
                                                  value={elaboration}
                                                  onChange={(e) => handleMissingExperienceElaborationChange(detail.skill, item.id, e.target.value)}
                                                  rows={3}
                                                  placeholder={detail.answerPlaceholder}
                                                  className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                                                />
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => handleOpenAddPosition(detail.skill)}
                                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-amber-700 dark:text-amber-300 transition-colors hover:bg-neutral-800"
                                    >
                                      <span className="text-base leading-none">+</span>
                                      <span>Add a position that&apos;s missing</span>
                                    </button>
                                  </div>
                                </>
                              );
                            })()}
                          </div>
                        )}
                            </>
                          );
                        })()}
                      </div>
                    ))}
                    <div className="flex items-center gap-3 pt-1">
                      <button
                        type="button"
                        onClick={handleSaveMissingExperienceDetails}
                        disabled={isSavingMissingExperience || totalSelectedMissingExperiencePositions === 0}
                        className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSavingMissingExperience
                          ? "Saving..."
                          : totalSelectedMissingExperiencePositions > 0
                            ? `Save experience details (${totalSelectedMissingExperiencePositions})`
                            : "Save experience details"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Generate resume
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  {sortedWorkHistory.length === 0
                    ? "Add work history first so the generator has real experience to choose from."
                    : !generationInstructions.trim()
                      ? "Paste the job description above so the generator can tailor the resume to it."
                      : "Uses your profile, global work history, model settings, and the job description above."}
                </p>
                {sortedWorkHistory.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setActiveMainTab("workHistory")}
                    className="mt-4 rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Add work history
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleGenerateMarkdown}
                    disabled={isGenerating || !generationInstructions.trim()}
                    title={generateDisabledReason || undefined}
                    className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isGenerating ? "Generating..." : "Generate resume"}
                  </button>
                )}
                <PipelineSteps
                  steps={GENERATE_STEPS}
                  stepIndex={generateStepIndex}
                  failed={generateFailed}
                />
                {generateStatus && (
                  <p
                    role="status"
                    className={`mt-3 text-sm ${generateFailed ? "text-red-400 font-medium" : "text-neutral-400"}`}
                  >
                    {generateStatus}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Settings ────────────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "settings" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Settings
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Model provider and model choice for imports and generation.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pagefit-scrollbar">
            <div className="mx-auto max-w-3xl space-y-5">
              <AccountSection />

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Model settings
                </h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Provider
                    </span>
                    <select
                      value={llmSettings.provider}
                      onChange={(e) => updateLlmSetting("provider", e.target.value)}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    >
                      {LLM_PROVIDERS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Model
                    </span>
                    <select
                      value={llmSettings.model}
                      onChange={(e) => updateLlmSetting("model", e.target.value)}
                      disabled={activeModelOptionsStatus === "loading"}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500 disabled:cursor-wait disabled:opacity-60"
                    >
                      {activeModelOptions.map(([model, label]) => (
                        <option key={model} value={model}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-neutral-600">
                      {activeModelOptionsStatus === "loading"
                        ? "Loading latest models..."
                        : activeModelOptionsStatus === "ready"
                          ? "Loaded from provider."
                          : activeModelOptionsStatus === "error"
                            ? "Could not load models. Showing defaults."
                            : "Showing default models."}
                    </p>
                  </label>
                </div>
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Export profile
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Download your profile, work history, resumes as markdown, and model preferences to use on another device.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleExportProfileData}
                    className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Export profile data
                  </button>
                  <label className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50">
                    <input
                      type="file"
                      accept="application/json,.json"
                      onChange={handleImportProfileData}
                      className="sr-only"
                    />
                    Import profile data
                  </label>
                </div>
              </div>

              <div className="rounded-xl border border-red-500/30 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-red-600 dark:text-red-300">
                  Delete account
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Permanently removes everything stored on this device: your profile, work history, resumes, and settings. This can&rsquo;t be undone.
                </p>
                <button
                  type="button"
                  onClick={handleOpenDeleteAccount}
                  className="mt-4 rounded-lg border border-red-500/50 bg-red-500/15 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/25 dark:text-red-300"
                >
                  Delete account…
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── A4 Page ─────────────────────────────────── */}
        <div className={`flex-1 min-w-0 flex-col overflow-hidden p-4 sm:p-8 ${activeMainTab === "resume" && activeResumeTab === "preview" ? "flex" : "hidden"} ${activeMainTab === "resume" ? "sm:flex" : "sm:hidden"}`}>
          <div ref={resumeMenuRef} className="relative z-20 mx-auto mb-4 w-full max-w-[620px] shrink-0">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsResumeMenuOpen((open) => !open)}
                className="min-w-0 flex-1 px-3 py-2 text-sm font-medium border border-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-800 hover:text-neutral-50 transition-colors flex items-center justify-between gap-2"
              >
                <span className="truncate text-left">
                  {selectedResume?.name ?? "Select resume"}
                </span>
                <svg
                  className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform ${isResumeMenuOpen ? "rotate-180" : ""}`}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => selectedResume && handleDeleteResume(selectedResume.id)}
                className="shrink-0 rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-red-300"
                aria-label={selectedResume ? `Delete ${selectedResume.name}` : "Delete selected resume"}
              >
                Delete
              </button>
            </div>

            {isResumeMenuOpen && (
              <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl shadow-black/40">
                <div className="max-h-56 overflow-y-auto p-1 pagefit-scrollbar">
                  {sortedResumes.map((resume) => (
                    <div
                      key={resume.id}
                      className={`group flex items-center gap-1 rounded-lg ${
                        resume.id === selectedResumeId
                          ? "bg-neutral-800 text-neutral-50"
                          : "text-neutral-300 hover:bg-neutral-900 hover:text-neutral-50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectResume(resume.id)}
                        className="min-w-0 flex-1 px-3 py-2 text-left text-sm"
                      >
                        <span className="block truncate">
                          {resume.name}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>

                <div className="border-t border-neutral-800 p-3">
                  <button
                    type="button"
                    onClick={handleOpenCreateResume}
                    className="w-full rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Create new resume
                  </button>
                </div>
              </div>
            )}
          </div>

          <div ref={previewRef} className="flex-1 min-h-0 min-w-0 flex items-center justify-center overflow-hidden">
            <div
              ref={pageRef}
              data-pagefit-page
              className="relative bg-white shadow-2xl shadow-black/50 shrink-0"
              style={{
                width: PAGE_W,
                height: PAGE_H,
                overflow: "hidden",
                transform: `scale(${pageScale})`,
                transformOrigin: "center center",
              }}
            >
              {positioned.map((item, i) => {
                if (item.type === "hr") {
                  return (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        left: padding,
                        right: padding,
                        top: item.y,
                        height: 1,
                        backgroundColor: "#ddd",
                      }}
                    />
                  );
                }
                return (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: item.x,
                      top: item.y,
                      fontSize: item.fontSize,
                      fontWeight: item.fontWeight,
                      fontFamily: FONT,
                      lineHeight: `${item.lineHeight}px`,
                      color: item.color,
                      whiteSpace: "pre",
                    }}
                  >
                    {item.text}
                  </div>
                );
              })}

              <div
                data-margin-guide
                className="absolute pointer-events-none"
                style={{
                  top: padding,
                  left: padding,
                  right: padding,
                  bottom: padding,
                  border: "1px dashed rgba(0,0,0,0.12)",
                }}
              />

              {!fits && (
                <div
                  data-overflow
                  className="absolute bottom-0 left-0 right-0 pointer-events-none"
                  style={{
                    height: 48,
                    background: "linear-gradient(transparent, rgba(248,113,113,0.18))",
                    borderBottom: "2px solid rgb(248,113,113)",
                  }}
                />
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={handleExportPdf}
            className="mx-auto mt-4 w-full max-w-[620px] shrink-0 px-3 py-2 text-sm font-medium bg-neutral-50 text-neutral-900 rounded-lg hover:bg-neutral-200 transition-colors"
          >
            Export as PDF
          </button>

        </div>

        {/* ── Collapsible fit sidebar ─────────────────── */}
        {activeMainTab === "resume" && isFitSidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/40 sm:hidden"
            onClick={() => setIsFitSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
        <div
          className={`shrink-0 self-stretch overflow-hidden border-l border-neutral-800 bg-neutral-950 transition-[width] duration-200 ease-out ${
            activeMainTab !== "resume"
              ? "hidden"
              : isFitSidebarOpen
                ? "fixed inset-y-0 right-0 z-50 w-72 sm:static sm:z-auto"
                : "w-10"
          }`}
        >
          {isFitSidebarOpen ? (
          <div className="flex h-full w-72 flex-col gap-4 overflow-y-auto px-5 py-4 pagefit-scrollbar">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-neutral-500">
                Page fit
              </p>
              <button
                type="button"
                onClick={() => setIsFitSidebarOpen(false)}
                className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                aria-label="Close page fit settings"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                </svg>
              </button>
            </div>

          {/* Auto-fit toggle */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Auto-fit
            </p>
            <button
              onClick={() => setAutoFit(!autoFit)}
              className={`w-10 h-5 rounded-full transition-colors relative ${
                autoFit ? "bg-emerald-500" : "bg-neutral-700"
              }`}
            >
              <div
                className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                style={{ left: 2, transform: autoFit ? "translateX(20px)" : "translateX(0)" }}
              />
            </button>
          </div>

          {/* Max Font Size */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Max Font Size
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={8}
                max={24}
                step={0.5}
                value={maxFontSize}
                onChange={(e) => setMaxFontSize(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-16 text-right">
                {maxFontSize}px
              </span>
            </div>
          </div>

          {/* Font scale */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Font Scale
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={6}
                max={24}
                step={0.01}
                value={fontSize}
                onChange={handleSlider}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-16 text-right">
                {((fontSize / 16) * 100).toFixed(1)}%
              </span>
            </div>
          </div>

          {/* Line Spacing */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Line Spacing
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={LH_MIN}
                max={LH_MAX}
                step={0.001}
                value={lineHeightMult}
                onChange={handleLineHeightSlider}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {lineHeightMult.toFixed(2)}x
              </span>
            </div>
          </div>

          {/* Margin */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Page Margin
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={16}
                max={80}
                step={1}
                value={padding}
                onChange={(e) => setPadding(parseInt(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {padding}px
              </span>
            </div>
          </div>

          {/* Section Spacing */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Section Spacing
              </p>
              <span className="relative group/tip">
                <span className="w-3.5 h-3.5 rounded-full border border-neutral-600 text-neutral-500 text-[9px] font-medium flex items-center justify-center cursor-default">i</span>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 text-xs text-neutral-300 bg-neutral-800 border border-neutral-700 rounded-md w-48 opacity-0 pointer-events-none group-hover/tip:opacity-100 transition-opacity">Gap before section headers like Experience, Education, and Skills.</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={48}
                step={1}
                value={sectionSpacing}
                onChange={(e) => setSectionSpacing(parseInt(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {sectionSpacing}px
              </span>
            </div>
          </div>

          {/* Item Spacing */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Item Spacing
              </p>
              <span className="relative group/tip">
                <span className="w-3.5 h-3.5 rounded-full border border-neutral-600 text-neutral-500 text-[9px] font-medium flex items-center justify-center cursor-default">i</span>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 text-xs text-neutral-300 bg-neutral-800 border border-neutral-700 rounded-md w-48 opacity-0 pointer-events-none group-hover/tip:opacity-100 transition-opacity">Gap between entries within a section, like between different jobs or degrees.</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={30}
                step={1}
                value={itemSpacing}
                onChange={(e) => setItemSpacing(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {itemSpacing}px
              </span>
            </div>
          </div>

          {/* Separator Spacing */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Separator Spacing
              </p>
              <span className="relative group/tip">
                <span className="w-3.5 h-3.5 rounded-full border border-neutral-600 text-neutral-500 text-[9px] font-medium flex items-center justify-center cursor-default">i</span>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 text-xs text-neutral-300 bg-neutral-800 border border-neutral-700 rounded-md w-48 opacity-0 pointer-events-none group-hover/tip:opacity-100 transition-opacity">Padding above and below the horizontal rule divider.</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={30}
                step={1}
                value={separatorSpacing}
                onChange={(e) => setSeparatorSpacing(parseInt(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {separatorSpacing}px
              </span>
            </div>
          </div>

          {/* Page fit */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Page Fit
            </p>
            <div className="h-1.5 bg-neutral-800 rounded-full overflow-hidden mb-2">
              <div
                className="h-full rounded-full transition-all duration-100"
                style={{
                  width: `${pct}%`,
                  backgroundColor: fits ? "rgb(52, 211, 153)" : "rgb(248, 113, 113)",
                }}
              />
            </div>
            <div className="flex items-baseline justify-between text-xs">
              <span className={`font-medium ${fits ? "text-emerald-400" : "text-red-400"}`}>
                {fits ? "Fits on 1 page" : `Overflow +${measuredHeight - maxH}px`}
              </span>
              <span className="text-neutral-600 font-mono tabular-nums">
                {measuredHeight}/{maxH}px · {measureTime}ms
              </span>
            </div>
          </div>
          </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsFitSidebarOpen(true)}
              className="flex h-full w-10 flex-col items-center justify-start pt-4 text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-300"
              aria-label="Open page fit settings"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M3 4.5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3 5.5a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm2 5.5a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              </svg>
            </button>
          )}
        </div>
      </main>

      {(workHistorySaveToast || profileDataToast) && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-emerald-500/30 bg-neutral-900 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-200 shadow-lg"
        >
          {workHistorySaveToast || profileDataToast}
        </div>
      )}

      {isPositionReviewOpen && (
        <PositionReviewDialog
          conflicts={workConflicts}
          onClose={() => setIsPositionReviewOpen(false)}
          onApplyMerge={handleMergePositions}
          onApplyFix={handleFixPositionDates}
          onKeepBoth={handleKeepBothPositions}
          onEditRole={(roleId) => {
            setIsPositionReviewOpen(false);
            handleFocusWorkHistoryRole(roleId);
          }}
        />
      )}

      {deleteConfirmWorkId !== null && (() => {
        const pendingDeletion = workHistory.find((item) => item.id === deleteConfirmWorkId);
        const roleLabel = [pendingDeletion?.position, pendingDeletion?.company]
          .filter(Boolean)
          .join(" at ");
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setDeleteConfirmWorkId(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-2xl border border-neutral-700 bg-neutral-950 p-5 shadow-2xl shadow-black/50"
            >
              <h2 className="text-lg font-semibold text-neutral-50">
                Delete this position?
              </h2>
              <p className="mt-1 text-sm text-neutral-400">
                {roleLabel
                  ? `“${roleLabel}” will be removed from your work history. This can’t be undone.`
                  : "This position will be removed from your work history. This can’t be undone."}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  autoFocus
                  onClick={() => setDeleteConfirmWorkId(null)}
                  className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                >
                  No, keep it
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDeleteWorkHistory}
                  className="rounded-lg border border-red-500/50 bg-red-500/15 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/25 dark:text-red-300"
                >
                  Yes, delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {isDeleteAccountOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setIsDeleteAccountOpen(false)}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleConfirmDeleteAccount}
            className="w-full max-w-sm rounded-2xl border border-neutral-700 bg-neutral-950 p-5 shadow-2xl shadow-black/50"
          >
            <h2 id="delete-account-title" className="text-lg font-semibold text-neutral-50">
              Delete account?
            </h2>
            <p className="mt-1 text-sm text-neutral-400">
              This permanently deletes everything One Resume stores on this device — your profile, work history, resumes, and settings. This can&rsquo;t be undone.
            </p>

            <label htmlFor="delete-account-confirm" className="mt-4 block text-xs text-neutral-500">
              Type <span className="font-semibold text-neutral-200">{DELETE_ACCOUNT_CONFIRM_PHRASE}</span> to confirm
            </label>
            <input
              id="delete-account-confirm"
              type="text"
              value={deleteAccountConfirmText}
              onChange={(e) => setDeleteAccountConfirmText(e.target.value)}
              placeholder={DELETE_ACCOUNT_CONFIRM_PHRASE}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-red-500/60"
            />

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsDeleteAccountOpen(false)}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={deleteAccountConfirmText.trim() !== DELETE_ACCOUNT_CONFIRM_PHRASE}
                className="rounded-lg border border-red-500/50 bg-red-500/15 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300"
              >
                Delete account
              </button>
            </div>
          </form>
        </div>
      )}

      {isCreateResumeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={handleCreateResume}
            className="w-full max-w-sm rounded-2xl border border-neutral-700 bg-neutral-950 p-5 shadow-2xl shadow-black/50"
          >
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-neutral-50">
                Create new resume
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                Name the resume from the company and role you are applying for.
              </p>
            </div>

            <label htmlFor="resume-company" className="block text-xs text-neutral-500 uppercase tracking-widest mb-2">
              Company
            </label>
            <input
              id="resume-company"
              type="text"
              value={resumeCompanyDraft}
              onChange={(e) => setResumeCompanyDraft(e.target.value)}
              placeholder="Acme Co"
              autoFocus
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
            />

            <label htmlFor="resume-job-title" className="mt-4 block text-xs text-neutral-500 uppercase tracking-widest mb-2">
              Job title
            </label>
            <input
              id="resume-job-title"
              type="text"
              value={resumeJobTitleDraft}
              onChange={(e) => setResumeJobTitleDraft(e.target.value)}
              placeholder="Operations Manager"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
            />

            {(resumeCompanyDraft.trim() || resumeJobTitleDraft.trim()) && (
              <p className="mt-3 text-xs text-neutral-500">
                Resume title: {titleResume(resumeCompanyDraft, resumeJobTitleDraft)}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsCreateResumeOpen(false)}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-neutral-200 px-3 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!resumeCompanyDraft.trim() && !resumeJobTitleDraft.trim()}
              >
                Create resume
              </button>
            </div>
          </form>
        </div>
      )}

      {addPositionForSkill !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={handleAddMissingPosition}
            className="w-full max-w-md rounded-2xl border border-neutral-700 bg-neutral-950 p-5 shadow-2xl shadow-black/50"
          >
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-neutral-50">
                Add a missing position
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                Add the role now, then pop back to fill in the detail that reminded you of it.
              </p>
            </div>

            <label className="block">
              <span className="block text-xs text-neutral-500 mb-1">Position</span>
              <input
                type="text"
                value={newPositionDraft.position}
                onChange={(e) => handleNewPositionDraftChange("position", e.target.value)}
                placeholder="Marketing Manager"
                autoFocus
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
              />
            </label>

            <label className="mt-4 block">
              <span className="block text-xs text-neutral-500 mb-1">Company</span>
              <input
                type="text"
                value={newPositionDraft.company}
                onChange={(e) => handleNewPositionDraftChange("company", e.target.value)}
                placeholder="Company name"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
              />
            </label>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-neutral-500 mb-1">Start Month</span>
                <select
                  value={normalizeWorkMonth(newPositionDraft.startMonth)}
                  onChange={(e) => handleNewPositionDraftChange("startMonth", e.target.value)}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                >
                  <option value="">No month</option>
                  {MONTH_SELECT_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-neutral-500 mb-1">Start Year</span>
                <input
                  type="text"
                  value={newPositionDraft.startYear}
                  onChange={(e) => handleNewPositionDraftChange("startYear", e.target.value)}
                  placeholder="2022"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                />
              </label>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-neutral-500 mb-1">End Month</span>
                <select
                  value={newPositionDraft.endYear === "present" ? "" : normalizeWorkMonth(newPositionDraft.endMonth)}
                  onChange={(e) => handleNewPositionDraftChange("endMonth", e.target.value)}
                  disabled={newPositionDraft.endYear === "present"}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <option value="">No month</option>
                  {MONTH_SELECT_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-neutral-500 mb-1">End Year</span>
                <input
                  type="text"
                  value={newPositionDraft.endYear === "present" ? "" : newPositionDraft.endYear}
                  onChange={(e) => handleNewPositionDraftChange("endYear", e.target.value)}
                  disabled={newPositionDraft.endYear === "present"}
                  placeholder={newPositionDraft.endYear === "present" ? "Present" : "2024"}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
                />
              </label>
            </div>

            <label className="mt-3 flex items-center gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={newPositionDraft.endYear === "present"}
                onChange={(e) => handleNewPositionPresentToggle(e.target.checked)}
                className="rounded border-neutral-600 bg-neutral-900 text-amber-400 focus:ring-amber-400"
              />
              Present — I currently work here
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCloseAddPosition}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newPositionDraft.position.trim() && !newPositionDraft.company.trim()}
                className="rounded-lg bg-neutral-200 px-3 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add position
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
