import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";

const api = `http://localhost:${process.env.PORT ?? 3001}`;

export default defineConfig(({ mode }): UserConfig =>
  // `vite build --mode site` (run by npm run export-site): the gallery alone, with relative paths so the
  // site works at any address, including the admin's /preview/.
  mode === "site"
    ? {
        root: "web",
        base: "./",
        build: { outDir: "../.site-build", emptyOutDir: true, rolldownOptions: { input: { main: resolve("web/index.html") } } },
      }
    : {
        root: "web",
        build: {
          outDir: "../dist",
          emptyOutDir: true,
          rolldownOptions: {
            input: { main: resolve("web/index.html"), admin: resolve("web/admin/index.html") },
          },
        },
        server: {
          port: 5173,
          proxy: { "/api": api, "/media": api, "/data.json": api, "/img": api, "/preview": api },
        },
      },
);
