import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
