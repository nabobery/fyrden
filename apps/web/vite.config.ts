import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter()],
  // Module workers keep the diff renderer's highlighter worker small: its
  // WebAssembly engine (never used: the JavaScript one is) stays a chunk of
  // its own, loaded only on demand, instead of being inlined (measured: 836
  // KB inlined, 214 KB as a module worker).
  worker: { format: "es" },
});
