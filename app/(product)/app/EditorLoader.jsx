"use client";

import dynamic from "next/dynamic";

// The editor reads localStorage during initial render and measures text in
// the DOM, so it only ever runs in the browser — no server render.
const ResumeEditor = dynamic(() => import("../../../src/App"), { ssr: false });

export default function EditorLoader({ initialData = null, userId = null }) {
  return <ResumeEditor initialData={initialData} userId={userId} />;
}
