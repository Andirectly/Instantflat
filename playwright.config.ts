import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  use: { baseURL: "http://localhost:18080" },
  webServer: { command: "node e2e/start.mjs", url: "http://localhost:18080/api/health", reuseExistingServer: false },
});
