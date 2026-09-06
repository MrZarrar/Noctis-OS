import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // Tauri's `frontendDist` reads this directory (apps/desktop/src-tauri/tauri.conf.json).
    outDir: "dist",
  },
});
