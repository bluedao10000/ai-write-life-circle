import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "knowledge.integration.spec.ts",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  timeout: 90000,
  outputDir: "./test-results-knowledge",
  use: {
    baseURL: "http://127.0.0.1:5186",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "knowledge-go", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/start-knowledge-stack.mjs",
    url: "http://127.0.0.1:5186",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
