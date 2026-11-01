import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Identifies each deployed version of the website: the git commit on Vercel, a timestamp locally.
// The app sends it with every API request (X-Kroft-Client) and compares it with /version.json to
// notice when a newer version has been deployed while it was open.
const WEB_BUILD = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 12) || `local-${Date.now().toString(36)}`;

const versionFile = () => ({
  name: "kroft-version-file",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: WEB_BUILD, builtAt: new Date().toISOString() }) });
  },
});

export default defineConfig({
  plugins: [react(), versionFile()],
  define: { __WEB_BUILD__: JSON.stringify(WEB_BUILD) },
  build: {
    rollupOptions: {
      output: {
        // React and Supabase change far less often than KROFT's own code. Keeping them in their
        // own files means a KROFT update only re-downloads the app code; phones keep these cached.
        // (Charts are already split out separately, loaded only when a chart is shown.)
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("node_modules/@supabase/")) return "supabase";
        },
      },
    },
  },
});
