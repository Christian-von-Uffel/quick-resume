"use client";

import dynamic from "next/dynamic";

// Same treatment as the editor (see ../EditorLoader.jsx): the lab reuses the
// product's flow components, which read the DOM and run their opening model
// call from a mount effect, so there is nothing worth server-rendering.
const PromptLab = dynamic(() => import("../../../../src/components/PromptLab"), {
  ssr: false,
});

export default function LabLoader({ initialData = null }) {
  return <PromptLab initialData={initialData} />;
}
