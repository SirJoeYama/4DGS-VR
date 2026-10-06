import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run dev:quest` serves HTTPS on the LAN so the Quest browser can open WebXR.
export default defineConfig(({ mode }) => ({
  plugins: mode === "quest" ? [basicSsl()] : [],
  server: { host: mode === "quest" ? true : "localhost", port: 5180 },
  build: { target: "es2022" },
}));
