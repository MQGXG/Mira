import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@mira/core", "@modelcontextprotocol/sdk", "effect", "zod", "docx"] })],
    build: {
      outDir: "dist-electron",
      emptyOutDir: false,
      rollupOptions: {
        input: {
          main: resolve(__dirname, "packages/electron/src/main/index.ts"),
          // Sidecar 独立入口：生产模式下由 ServerManager spawn 该 JS（替代原 tsx 开发路径）
          sidecar: resolve(__dirname, "packages/core/src/system/server/cli.ts"),
        },
        external: ["playwright", "playwright-core"],
      },
    },
    resolve: {
      alias: [
        {
          find: /^@mira\/core(\/.*)?$/,
          replacement: resolve(__dirname, "packages/core/src") + "$1",
        },
      ],
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron",
      emptyOutDir: false,
      rollupOptions: {
        input: { preload: resolve(__dirname, "packages/electron/src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      outDir: "dist",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
          pet: resolve(__dirname, "pet.html"),
          "widget-test": resolve(__dirname, "apps/desktop/widget-test.html"),
        },
      },
    },
    plugins: [react()],
    optimizeDeps: {
      include: ["diff", "parse-diff"],
    },
    resolve: {
      alias: {
        "@mira/core": resolve(__dirname, "packages/core/src"),
        "@mira/ui": resolve(__dirname, "packages/ui/src"),
        "@mira/electron": resolve(__dirname, "packages/electron/src"),
      },
    },
  },
});
