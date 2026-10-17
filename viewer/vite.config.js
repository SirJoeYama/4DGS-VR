import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run dev:quest` serves HTTPS on the LAN so the Quest browser can open WebXR.
// GitHub Pages serves the site from /4DGS-VR/, so production builds use that base.
export default defineConfig(({ command, mode, isPreview }) => ({
  base: command === "build" || isPreview ? "/4DGS-VR/" : "/",
  plugins: mode === "quest" ? [basicSsl()] : [],
  clearScreen: false, // keep start.cmd's "On the Quest open ..." line visible
  server: {
    host: mode === "quest" ? true : "localhost",
    port: 5180,
    strictPort: true,
    // The generator only listens on this PC; /api relays it so the Create page also works from
    // the Quest (which can't reach the PC's 127.0.0.1, or call plain HTTP from an HTTPS page).
    proxy: { "/api": { target: "http://127.0.0.1:8766", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  build: {
    target: "es2022",
    rolldownOptions: { input: { main: "index.html", create: "create.html" } },
  },
}));
