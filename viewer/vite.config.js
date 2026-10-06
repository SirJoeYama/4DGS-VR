import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run dev:quest` serves HTTPS on the LAN so the Quest browser can open WebXR.
// GitHub Pages serves the site from /4DGS-VR/, so production builds use that base.
export default defineConfig(({ command, mode, isPreview }) => ({
  base: command === "build" || isPreview ? "/4DGS-VR/" : "/",
  plugins: mode === "quest" ? [basicSsl()] : [],
  server: { host: mode === "quest" ? true : "localhost", port: 5180 },
  build: { target: "es2022" },
}));
