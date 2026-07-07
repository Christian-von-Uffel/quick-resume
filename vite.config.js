import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // PORT lets preview harnesses assign a free port; CLI --port still wins.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
});
