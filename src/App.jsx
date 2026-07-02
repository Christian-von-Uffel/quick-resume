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
} from "./lib/constants";
import { readFileAsText, readFileAsBase64, downloadJsonFile } from "./lib/fileUtils";
import {
  sortWorkHistory,
  sortEducation,
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
  mergeWorkHistory,
  mergeEducation,
  getVisibleContactLine,
  buildResumeExportName,
  INITIAL_WORK_HISTORY,
} from "./lib/resumeModel";
import { loadStoredAppState, saveStoredAppState } from "./lib/storage";
import {
  getDefaultModelForProvider,
  fetchProviderModelOptions,
  sanitizeApiKey,
  applyApiKeyDrafts,
  normalizeLlmSettings,
  callLlm,
  callLlmForJson,
} from "./lib/llm";
import { parseMarkdown, measureBlocks, layoutBlocks, findOptimalFit } from "./lib/markdownLayout";
import {
  buildJobTargetPrompt,
  validateExtractedJobTarget,
  selectBestFittingExperience,
  validateSelectedResumeEvidence,
  ensureRequiredRolesSelected,
  generateResume,
  extractJobDescription,
  extractCleanedJobDescription,
  collapseBlankLines,
} from "./lib/generateResume";
import { summarizeCoverage } from "./lib/workHistoryTimeline";
import { WorkHistoryTimeline } from "./components/WorkHistoryTimeline";
import { importResume, coerceImportedProfile } from "./lib/importResume";
import {
  findMissingExperience,
  validateMissingExperienceDetails,
  formatExperienceElaboration,
  cleanFormattedDetail,
} from "./lib/reviewExperience";
import { buildProfileExportPayload } from "./lib/exportProfile";
import { parseProfileExportFile } from "./lib/importProfile";
import { printResumePage } from "./lib/exportPdf";

/* ── Component ─────────────────────────────────────────────── */
export default function App() {
  const [storedAppState] = useState(loadStoredAppState);
  const [initialResumes] = useState(() => normalizeResumeList(storedAppState.resumes));
  const initialSelectedResume = initialResumes.find((resume) => resume.id === storedAppState.selectedResumeId) ?? initialResumes[0];
  const [resumes, setResumes] = useState(initialResumes);
  const [selectedResumeId, setSelectedResumeId] = useState(initialSelectedResume.id);
  const [markdown, setMarkdown] = useState(initialSelectedResume.content);
  const [profile, setProfile] = useState(() => normalizeProfile(storedAppState.profile));
  const [workHistory, setWorkHistory] = useState(() =>
    sortWorkHistory(
      normalizeStoredList(storedAppState.workHistory, INITIAL_WORK_HISTORY).map(normalizeWorkHistoryItem)
    )
  );
  const [llmSettings, setLlmSettings] = useState(() => normalizeLlmSettings(storedAppState.llmSettings));
  const [apiKeyDrafts, setApiKeyDrafts] = useState(() => {
    const settings = normalizeLlmSettings(storedAppState.llmSettings);
    return {
      gemini: settings.geminiApiKey,
      openai: settings.openaiApiKey,
      anthropic: settings.anthropicApiKey,
      firecrawl: settings.firecrawlApiKey ?? "",
    };
  });
  const [modelOptionsByProvider, setModelOptionsByProvider] = useState(FALLBACK_MODEL_OPTIONS);
  const [modelOptionsStatus, setModelOptionsStatus] = useState({
    gemini: "idle",
    openai: "idle",
    anthropic: "idle",
  });
  const [apiKeySaveToast, setApiKeySaveToast] = useState("");
  const [workHistorySaveToast, setWorkHistorySaveToast] = useState("");
  const [workHistorySearch, setWorkHistorySearch] = useState("");
  const [highlightedWorkId, setHighlightedWorkId] = useState(null);
  const [profileDataToast, setProfileDataToast] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [generateStatus, setGenerateStatus] = useState("");
  const [generationSourceType, setGenerationSourceType] = useState("text"); // "text" or "url"
  const [scrapeUrl, setScrapeUrl] = useState("");
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState("");
  const [scrapeSuccess, setScrapeSuccess] = useState("");
  const [generationInstructions, setGenerationInstructions] = useState("");
  const [missingExperienceStatus, setMissingExperienceStatus] = useState("");
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
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return window.localStorage.getItem("theme") === "dark" ? "dark" : "light";
  });
  const pageRef = useRef(null);
  const previewRef = useRef(null);
  const resumeMenuRef = useRef(null);
  const apiKeySaveToastTimeoutRef = useRef(null);
  const workHistorySaveToastTimeoutRef = useRef(null);
  const workHistorySaveToastDebounceRef = useRef(null);
  const profileDataToastTimeoutRef = useRef(null);
  const missingExperienceSaveToastTimeoutRef = useRef(null);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  const sortedWorkHistory = useMemo(() => sortWorkHistory(workHistory), [workHistory]);
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
  const selectedResume = useMemo(
    () => resumes.find((resume) => resume.id === selectedResumeId) ?? resumes[0],
    [resumes, selectedResumeId]
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
    const fallback = resumes[0] ?? createResume();

    if (selectedResume?.id === selectedResumeId) return;

    if (!resumes.length) {
      setResumes([fallback]);
    }
    setSelectedResumeId(fallback.id);
    setMarkdown(fallback.content);
  }, [resumes, selectedResume, selectedResumeId]);

  useEffect(() => {
    saveStoredAppState({
      resumes,
      selectedResumeId,
      profile,
      workHistory,
      llmSettings,
    });
  }, [resumes, selectedResumeId, profile, workHistory, llmSettings]);

  useEffect(() => {
    let cancelled = false;

    async function loadProviderModels(provider, apiKey) {
      if (!apiKey.trim()) {
        if (cancelled) return;
        setModelOptionsByProvider((current) => ({
          ...current,
          [provider]: FALLBACK_MODEL_OPTIONS[provider] ?? [],
        }));
        setModelOptionsStatus((current) => ({ ...current, [provider]: "idle" }));
        return;
      }

      setModelOptionsStatus((current) => ({ ...current, [provider]: "loading" }));

      try {
        const options = await fetchProviderModelOptions(provider, apiKey);
        if (cancelled) return;

        if (!options.length) {
          setModelOptionsStatus((current) => ({ ...current, [provider]: "error" }));
          return;
        }

        setModelOptionsByProvider((current) => ({ ...current, [provider]: options }));
        setModelOptionsStatus((current) => ({ ...current, [provider]: "ready" }));
      } catch {
        if (!cancelled) {
          setModelOptionsStatus((current) => ({ ...current, [provider]: "error" }));
        }
      }
    }

    loadProviderModels("gemini", llmSettings.geminiApiKey);
    loadProviderModels("openai", llmSettings.openaiApiKey);
    loadProviderModels("anthropic", llmSettings.anthropicApiKey);

    return () => {
      cancelled = true;
    };
  }, [llmSettings.geminiApiKey, llmSettings.openaiApiKey, llmSettings.anthropicApiKey]);

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
    if (apiKeySaveToastTimeoutRef.current) {
      clearTimeout(apiKeySaveToastTimeoutRef.current);
    }
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
      setLlmSettings((current) => ({
        ...imported.llmSettings,
        geminiApiKey: current.geminiApiKey,
        openaiApiKey: current.openaiApiKey,
        anthropicApiKey: current.anthropicApiKey,
        firecrawlApiKey: current.firecrawlApiKey,
        rememberApiKey: true,
      }));
      showProfileDataToast("Profile data imported.");
    } catch (error) {
      showProfileDataToast(error instanceof Error ? error.message : "Import failed.");
    } finally {
      event.target.value = "";
    }
  };

  const handleSaveApiKeys = () => {
    setLlmSettings((current) => applyApiKeyDrafts(current, apiKeyDrafts));

    setApiKeySaveToast("API keys saved to this device.");

    if (apiKeySaveToastTimeoutRef.current) {
      clearTimeout(apiKeySaveToastTimeoutRef.current);
    }

    apiKeySaveToastTimeoutRef.current = setTimeout(() => {
      setApiKeySaveToast("");
      apiKeySaveToastTimeoutRef.current = null;
    }, 3000);
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
    const nextSelected = resumeId === selectedResumeId ? nextResumes[0] : selectedResume;

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

  const handleUpdateWorkHistory = (workId, field, value) => {
    let nextValue = value;
    if (field === "startMonth" || field === "endMonth") {
      nextValue = normalizeWorkMonth(value);
    } else if (field === "startYear" || field === "endYear") {
      nextValue = normalizeWorkYear(value);
    }

    setWorkHistory((current) =>
      sortWorkHistory(
        current.map((item) =>
          item.id === workId
            ? normalizeWorkHistoryItem({ ...item, [field]: nextValue })
            : item
        )
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
  };

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

    let firecrawlKey = sanitizeApiKey(apiKeyDrafts.firecrawl) || sanitizeApiKey(llmSettings.firecrawlApiKey);
    if (!firecrawlKey && sanitizeApiKey(apiKeyDrafts.firecrawl)) {
      firecrawlKey = sanitizeApiKey(apiKeyDrafts.firecrawl);
      setLlmSettings((current) => applyApiKeyDrafts(current, apiKeyDrafts));
    }

    if (!firecrawlKey) {
      setScrapeError("Please enter and save a Firecrawl API key first.");
      setIsScraping(false);
      return;
    }

    try {
      // 1. Fetch raw markdown and metadata from Firecrawl
      const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${firecrawlKey}`,
        },
        body: JSON.stringify({
          url: scrapeUrl.trim(),
          formats: ["markdown"],
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Scrape failed with status ${response.status}`);
      }

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || "Scrape was unsuccessful.");
      }

      const scrapedText = result.data?.markdown;
      if (!scrapedText) {
        throw new Error("No markdown content was returned from the page.");
      }

      const pageTitle = result.data?.metadata?.title || "";
      const pageDescription = result.data?.metadata?.description || "";

      // 2. Select the cheapest model depending on the active provider
      const provider = llmSettings.provider;
      let cheapestModel = "";
      if (provider === "openai") {
        cheapestModel = "gpt-5.4-nano";
      } else if (provider === "anthropic") {
        cheapestModel = "claude-haiku-4-5";
      } else {
        cheapestModel = "gemini-3.1-flash-lite";
      }

      // Prepare LLM settings with cheapest model
      const settingsWithDraftKeys = applyApiKeyDrafts(llmSettings, apiKeyDrafts);
      const cleanLlmSettings = {
        ...settingsWithDraftKeys,
        model: cheapestModel,
      };

      // 3. Clean up raw content using the cheapest model
      setScrapeSuccess("Scraped raw text. Cleaning up job description with AI...");
      
      const cleanPrompt = extractJobDescription({
        title: pageTitle,
        metaDescription: pageDescription,
        rawText: scrapedText,
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
    setMissingExperienceStatus("Looking for job requirements that are missing from your work history...");

    try {
      const parsed = await callLlmForJson(
        applyApiKeyDrafts(llmSettings, apiKeyDrafts),
        findMissingExperience({ workHistory, jobDescription }),
        null
      );
      const details = validateMissingExperienceDetails(parsed);
      setMissingExperienceDetails(details);
      setConfirmedMissingExperienceSkills([]);
      setDismissedMissingExperienceSkills([]);
      setMissingExperiencePositionFilters({});
      setMissingExperienceSelectedPositions({});
      setMissingExperienceElaborations({});
      setMissingExperienceSaveToast("");
      setMissingExperienceStatus(
        details.length
          ? `Found ${details.length} detail${details.length === 1 ? "" : "s"} to check.`
          : "No obvious missing work experience details found."
      );
    } catch (error) {
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
      const settings = applyApiKeyDrafts(llmSettings, apiKeyDrafts);
      const resolved = await Promise.all(
        tasks.map(async (task) => {
          const fallback = task.detail.plainspokenDetail.replace(/^[-•]\s*/, "").trim();
          if (!task.answer) {
            return { workId: task.workId, line: fallback };
          }
          const text = await callLlm(
            settings,
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

          const existing = item.description.split("\n").map((line) => line.trim()).filter(Boolean);
          const existingLower = new Set(existing.map((line) => line.toLowerCase()));
          const additions = [];
          for (const line of newLines) {
            const key = line.toLowerCase();
            if (existingLower.has(key)) continue;
            existingLower.add(key);
            additions.push(line);
          }
          if (additions.length === 0) return item;

          savedCount += additions.length;
          return normalizeWorkHistoryItem({
            ...item,
            description: [...existing, ...additions].join("\n"),
          });
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
      setImportStatus("Asking the model to extract profile and work history...");
      const imported = await callLlmForJson(applyApiKeyDrafts(llmSettings, apiKeyDrafts), importResume(), {
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        base64,
      });
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
      setWorkHistory((current) => mergeWorkHistory(current, importedHistory));
      setImportStatus(`Imported ${importedHistory.length} role${importedHistory.length === 1 ? "" : "s"} from ${file.name}.`);
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsImporting(false);
      event.target.value = "";
    }
  };

  const handleGenerateMarkdown = async () => {
    setIsGenerating(true);
    setGenerateStatus("Extracting resume title details...");

    try {
      const settingsWithDraftKeys = applyApiKeyDrafts(llmSettings, apiKeyDrafts);
      const targetJson = await callLlmForJson(
        settingsWithDraftKeys,
        buildJobTargetPrompt(generationInstructions),
        null
      );
      const extractedTarget = validateExtractedJobTarget(targetJson);
      const resumeTitle = titleGeneratedResume(extractedTarget.company, extractedTarget.position);

      // Deterministic, non-LLM rule for which roles must appear so the resume
      // shows continuous, current employment and covers recent gaps.
      const coverage = summarizeCoverage(workHistory);

      setGenerateStatus("Selecting aligned work history...");
      const selectionJson = await callLlmForJson(
        settingsWithDraftKeys,
        selectBestFittingExperience({ profile, workHistory, instructions: generationInstructions, coverage }),
        null
      );
      const selectedEvidence = ensureRequiredRolesSelected(
        validateSelectedResumeEvidence(selectionJson),
        coverage,
        workHistory
      );

      setGenerateStatus("Generating resume from selected evidence...");
      const text = await callLlm(
        settingsWithDraftKeys,
        generateResume({
          profile,
          selectedEvidence,
          instructions: generationInstructions,
          jobTitle: extractedTarget.position,
          coverage,
        }),
        null
      );
      const nextMarkdown = text.replace(/^```(?:markdown)?\s*/i, "").replace(/```$/i, "").trim();
      // Save each generation as its own resume so existing resumes are never overwritten.
      const generatedResume = {
        ...createResume(extractedTarget.company, extractedTarget.position),
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
      setGenerateStatus("Generated a new resume.");
      setActiveMainTab("resume");
      setActiveResumeTab("editor");
    } catch (error) {
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
            style={{ caretColor: "#fff" }}
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
                  accept="application/pdf,image/*"
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
              visibleWorkHistory.map((item) => (
                <div
                  key={item.id}
                  id={`work-card-${item.id}`}
                  className={`rounded-xl border bg-neutral-950/40 p-4 transition-shadow duration-500 ${
                    highlightedWorkId === item.id
                      ? "border-blue-500 ring-2 ring-blue-500/60"
                      : "border-neutral-800"
                  }`}
                >
                  <div className="flex justify-end mb-3">
                    <button
                      type="button"
                      onClick={() => handleDeleteWorkHistory(item.id)}
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
                          value={normalizeWorkMonth(item.endMonth)}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "endMonth", e.target.value)}
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
                          End Year
                        </span>
                        <input
                          type="text"
                          value={item.endYear ?? ""}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "endYear", e.target.value)}
                          placeholder="2024 or present"
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                        />
                      </label>
                    </div>

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
                  </div>
                </div>
              ))
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

                    {/* Firecrawl API Key Box (if not yet saved) */}
                    {!(apiKeyDrafts.firecrawl?.trim() || llmSettings.firecrawlApiKey?.trim()) && (
                      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
                        <div className="flex items-start gap-2.5">
                          <div className="text-neutral-500 shrink-0 mt-0.5">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
                            </svg>
                          </div>
                          <div className="flex-1">
                            <p className="text-xs text-neutral-400">
                              A Firecrawl API key is required to scrape job descriptions. Get one for free at <a href="https://firecrawl.dev" target="_blank" rel="noopener noreferrer" className="underline hover:text-neutral-200">firecrawl.dev</a>.
                            </p>
                            <div className="mt-2 flex gap-2">
                              <input
                                type="password"
                                value={apiKeyDrafts.firecrawl ?? ""}
                                onChange={(e) => setApiKeyDrafts((current) => ({ ...current, firecrawl: e.target.value }))}
                                placeholder="fc-..."
                                className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                              />
                              <button
                                type="button"
                                onClick={handleSaveApiKeys}
                                className="rounded-md border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-neutral-50"
                              >
                                Save Key
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Find requirements missing from your work experience
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Analyzes the job description and compares it with your saved work history to identify gaps and then asks you simple questions to address them.
                </p>
                <button
                  type="button"
                  onClick={handleFindMissingExperienceDetails}
                  disabled={isFindingMissingExperience || !generationInstructions.trim() || sortedWorkHistory.length === 0}
                  className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isFindingMissingExperience ? "Analyzing work history..." : "Find missing experience"}
                </button>
                {missingExperienceStatus && (
                  <p className="mt-3 text-sm text-neutral-400">
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
                            <p className="text-sm font-medium text-neutral-200">
                              {detail.question}
                            </p>
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
                              const filteredWorkHistory = workHistoryByPositionCompany.filter((item) => {
                                const searchableText = [item.position, item.company].filter(Boolean).join(" ").toLowerCase();
                                return !normalizedPositionFilter || searchableText.includes(normalizedPositionFilter);
                              });
                              const selectedWorkIdSet = new Set(missingExperienceSelectedPositions[detail.skill] ?? []);
                              const detailText = detail.plainspokenDetail.replace(/^[-•]\s*/, "").trim().toLowerCase();

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
                                        const hasDetail = item.description
                                          .split("\n")
                                          .some((line) => line.trim().toLowerCase() === detailText);
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
                    disabled={isGenerating}
                    className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isGenerating ? "Generating..." : "Generate resume"}
                  </button>
                )}
                {generateStatus && (
                  <p className="mt-3 text-sm text-neutral-400">
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
              Model provider, model choice, and API key for imports and generation.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pagefit-scrollbar">
            <div className="mx-auto max-w-3xl space-y-5">
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
                            : "Save an API key to load the latest models."}
                    </p>
                  </label>
                </div>

                <div className="mt-4 space-y-3">
                  <p className="text-xs text-neutral-500">
                    API keys
                  </p>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Google API key
                    </span>
                    <input
                      type="password"
                      value={apiKeyDrafts.gemini}
                      onChange={(e) => setApiKeyDrafts((current) => ({ ...current, gemini: e.target.value }))}
                      placeholder="AIza..."
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      OpenAI API key
                    </span>
                    <input
                      type="password"
                      value={apiKeyDrafts.openai}
                      onChange={(e) => setApiKeyDrafts((current) => ({ ...current, openai: e.target.value }))}
                      placeholder="sk-..."
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Anthropic API key
                    </span>
                    <input
                      type="password"
                      value={apiKeyDrafts.anthropic}
                      onChange={(e) => setApiKeyDrafts((current) => ({ ...current, anthropic: e.target.value }))}
                      placeholder="sk-ant-..."
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Firecrawl API key
                    </span>
                    <input
                      type="password"
                      value={apiKeyDrafts.firecrawl ?? ""}
                      onChange={(e) => setApiKeyDrafts((current) => ({ ...current, firecrawl: e.target.value }))}
                      placeholder="fc-..."
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={handleSaveApiKeys}
                    className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Save API keys
                  </button>
                </div>

                <p className="mt-3 text-xs text-neutral-500">
                  API keys are saved in browser storage on this device.
                </p>
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Export profile
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Download your profile, work history, resumes as markdown, and model preferences to use on another device.
                </p>
                <p className="mt-2 text-xs text-neutral-600">
                  API keys are not included in exports.
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
                  {resumes.map((resume) => (
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

      {(apiKeySaveToast || workHistorySaveToast || profileDataToast) && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-emerald-500/30 bg-neutral-900 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-200 shadow-lg"
        >
          {apiKeySaveToast || workHistorySaveToast || profileDataToast}
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
                  value={normalizeWorkMonth(newPositionDraft.endMonth)}
                  onChange={(e) => handleNewPositionDraftChange("endMonth", e.target.value)}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
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
                  value={newPositionDraft.endYear}
                  onChange={(e) => handleNewPositionDraftChange("endYear", e.target.value)}
                  placeholder="2024 or present"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                />
              </label>
            </div>

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
