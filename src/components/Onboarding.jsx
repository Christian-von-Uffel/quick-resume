"use client";

import { useEffect, useRef } from "react";

/**
 * First-run onboarding overlay.
 *
 * Renders the self-contained welcome flow (public/onboarding.html) in a
 * full-screen, same-origin iframe. The flow has its own design system and
 * uses generic class names (.btn, .dot, .chip, .report…), so the iframe keeps
 * it fully isolated from the editor's Tailwind styles — no leakage either way.
 *
 * When the user finishes ("Start building"), skips, or presses Escape, the
 * flow posts a `{ source: "1resume-onboarding", type: "complete", via }`
 * message; we validate the origin and call onComplete() to dismiss + record it.
 */
export default function Onboarding({ onComplete }) {
  const doneRef = useRef(false);

  useEffect(() => {
    function handleMessage(event) {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (
        data &&
        data.source === "1resume-onboarding" &&
        data.type === "complete" &&
        !doneRef.current
      ) {
        doneRef.current = true;
        if (typeof onComplete === "function") onComplete(data.via);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onComplete]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to 1Resume"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        background: "#ffffff",
      }}
    >
      <iframe
        src="/onboarding.html"
        title="Welcome to 1Resume"
        style={{ border: 0, width: "100%", height: "100%", display: "block" }}
      />
    </div>
  );
}
