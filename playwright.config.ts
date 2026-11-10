import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8787",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "npx wrangler dev --port 8787 --ip 127.0.0.1",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
