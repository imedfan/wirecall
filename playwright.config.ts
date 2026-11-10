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
    // Each run gets its own empty room storage. Rooms left by earlier runs would otherwise count
    // against the hourly creation limit, and the tests would start failing after a few runs in a row.
    command: "rm -rf .wrangler/test-state && npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to .wrangler/test-state",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
