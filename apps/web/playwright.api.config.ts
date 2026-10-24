import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const stateDirectory = process.env.WRITER_AGENT_E2E_STATE_DIR
if (!stateDirectory) throw new Error('WRITER_AGENT_E2E_STATE_DIR must point to an isolated temporary directory.')

const harnessRoot = resolve(process.cwd(), 'e2e/fixtures/harness')

export default defineConfig({
  testDir: './e2e',
  testMatch: 'api.integration.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: './test-results-api',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-api', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: '../api-go/dist/writer-agent-api',
      url: 'http://127.0.0.1:8788/healthz',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'development',
        WRITER_AGENT_PROJECT_ID: 'e2e-fixture',
        WRITER_AGENT_API_PORT: '8788',
        WRITER_AGENT_HARNESS_ROOT: harnessRoot,
        WRITER_AGENT_STATE_DIR: stateDirectory,
      },
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 5175',
      url: 'http://127.0.0.1:5175',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_WRITER_AGENT_MODE: 'api',
        VITE_WRITER_AGENT_PROJECT_ID: 'e2e-fixture',
        WRITER_AGENT_API_TARGET: 'http://127.0.0.1:8788',
      },
    },
  ],
})
