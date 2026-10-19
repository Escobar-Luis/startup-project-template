import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The SPA only. The Worker (src/worker) is bundled by wrangler and never imported here,
// so no server secret can reach the client bundle (scripts/check-bundle.mjs verifies dist/).
export default defineConfig({
  root: "src/web",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
