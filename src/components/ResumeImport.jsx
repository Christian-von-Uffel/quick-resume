import { useEffect, useRef, useState } from "react";
import { RESUME_IMPORT_ACCEPT } from "../lib/importResume";
import { describeBatchProgress, describeBatchSummary } from "../lib/importBatch";

// The Work History pieces of multi-resume import: the upload-first empty state
// a new account lands on, the progress/summary card a batch reports into, and
// the drop overlay for dragging files in on desktop. The batch itself runs in
// App (handleImportResume) through lib/importBatch.

function DocumentsIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h6.379a1.5 1.5 0 0 1 1.06.44l2.622 2.62A1.5 1.5 0 0 1 20 8.122V16.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 9.5A1.5 1.5 0 0 1 5.5 8h6.379a1.5 1.5 0 0 1 1.06.44l2.622 2.62a1.5 1.5 0 0 1 .439 1.061V19.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 19.5v-10Z" />
      <path strokeLinecap="round" d="M7.5 14.5h5M7.5 17.5h3.5" />
    </svg>
  );
}

/** Hidden multi-select file input wrapped by a styled label. */
export function ResumeFilePicker({ onFiles, disabled, className, children }) {
  return (
    <label className={`${className} ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
      <input
        type="file"
        multiple
        accept={RESUME_IMPORT_ACCEPT}
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Cleared so picking the same files again still fires onChange.
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
        className="sr-only"
      />
      {children}
    </label>
  );
}

/* ── Empty state ───────────────────────────────────────────────────────── */

export function WorkHistoryEmptyState({ onFiles, onAddPosition, disabled }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border border-dashed border-neutral-700 px-5 py-8 text-center sm:px-8 sm:py-10">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-800 text-neutral-300">
        <DocumentsIcon className="h-6 w-6" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-neutral-100 text-balance">
        Upload the resumes you already have
      </h2>
      <p className="mt-2 text-sm text-neutral-400 text-pretty">
        Every role and detail gets merged into one profile.
      </p>
      <ResumeFilePicker
        onFiles={onFiles}
        disabled={disabled}
        className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-neutral-50 px-4 py-3 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-200 sm:w-auto sm:min-w-[220px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500"
      >
        Upload resumes
      </ResumeFilePicker>
      <button
        type="button"
        onClick={onAddPosition}
        className="mt-2 w-full rounded-lg px-4 py-2.5 text-sm font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 sm:w-auto"
      >
        Add a position by hand
      </button>
      <p className="mt-4 text-xs text-neutral-500 text-balance">
        PDF, Word, PowerPoint or images. Pick several at once
        <span className="hidden sm:inline">, or drop them here</span>.
      </p>
    </div>
  );
}

/* ── Progress and summary ──────────────────────────────────────────────── */

function Spinner() {
  return (
    <svg className="h-4 w-4 shrink-0 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function ResumeImportProgress({ progress }) {
  if (!progress) return null;
  const { index, total, phase } = progress;
  const done = phase === "waiting" ? index : index + 0.5;

  return (
    <div role="status" aria-live="polite" className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
      <div className="flex items-center gap-3">
        <Spinner />
        <p className="min-w-0 flex-1 truncate text-sm text-neutral-300">{describeBatchProgress(progress)}</p>
      </div>
      {total > 1 && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-blue-500 transition-[width] duration-500"
            style={{ width: `${Math.round((done / total) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function ResumeImportSummary({
  summary,
  conflictCount = 0,
  onReview,
  onSubscribe,
  subscribing = false,
  onDismiss,
}) {
  if (!summary) return null;
  const failed = summary.files.filter((file) => file.status === "failed");
  const skipped = summary.files.filter((file) => file.status === "skipped");

  return (
    <div role="status" className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4 text-sm">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 font-medium text-neutral-200">{describeBatchSummary(summary)}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss import summary"
          className="-m-1 shrink-0 rounded p-1 text-neutral-500 transition-colors hover:text-neutral-200"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>

      {failed.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {failed.map((file) => (
            <li key={`${file.index}-${file.name}`} className="text-neutral-400">
              <span className="break-all font-medium text-rose-600 dark:text-rose-300">{file.name}</span>
              <span className="text-neutral-500"> — {file.error}</span>
            </li>
          ))}
        </ul>
      )}

      {summary.stoppedBy && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-neutral-300">{summary.stoppedBy.message}</p>
          {skipped.length > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              Not read yet: {skipped.map((file) => file.name).join(", ")}
            </p>
          )}
          {summary.stoppedBy.upgrade && onSubscribe && (
            <button
              type="button"
              onClick={onSubscribe}
              disabled={subscribing}
              className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-200 disabled:opacity-60"
            >
              {subscribing ? "Opening checkout…" : "Subscribe to keep going"}
            </button>
          )}
        </div>
      )}

      {conflictCount > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-3">
          <p className="min-w-0 flex-1 text-neutral-400">
            {conflictCount === 1
              ? "1 role looks like a duplicate or has dates to check."
              : `${conflictCount} roles look like duplicates or have dates to check.`}
          </p>
          <button
            type="button"
            onClick={onReview}
            className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-200"
          >
            Review now
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Drag and drop ─────────────────────────────────────────────────────── */

const carriesFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

/**
 * Accept files dropped anywhere on the window while `enabled`. Returns whether
 * files are being dragged over it, for the overlay. Listening on the window
 * rather than one element means the target can't be missed, and a drop
 * outside it no longer makes the browser navigate away to the file.
 */
export function useResumeFileDrop(enabled, onFiles) {
  const [isDragging, setIsDragging] = useState(false);
  const depthRef = useRef(0);
  const onFilesRef = useRef(onFiles);

  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    if (!enabled) return undefined;

    const reset = () => {
      depthRef.current = 0;
      setIsDragging(false);
    };
    const handleEnter = (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depthRef.current += 1;
      setIsDragging(true);
    };
    const handleOver = (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const handleLeave = (event) => {
      if (!carriesFiles(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setIsDragging(false);
    };
    const handleDrop = (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      reset();
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length) onFilesRef.current(files);
    };

    window.addEventListener("dragenter", handleEnter);
    window.addEventListener("dragover", handleOver);
    window.addEventListener("dragleave", handleLeave);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragenter", handleEnter);
      window.removeEventListener("dragover", handleOver);
      window.removeEventListener("dragleave", handleLeave);
      window.removeEventListener("drop", handleDrop);
      reset();
    };
  }, [enabled]);

  return isDragging;
}

export function ResumeDropOverlay({ active }) {
  if (!active) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/70 p-6 backdrop-blur-sm">
      <div className="flex flex-col items-center rounded-2xl border-2 border-dashed border-blue-500 bg-neutral-900 px-10 py-8 text-center">
        <DocumentsIcon className="h-8 w-8 text-blue-500" />
        <p className="mt-3 text-base font-semibold text-neutral-100">Drop your resumes to import them</p>
        <p className="mt-1 text-sm text-neutral-400">Every role gets merged into one profile.</p>
      </div>
    </div>
  );
}
