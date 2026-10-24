import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e', testMatch: 'auth.spec.ts', reporter: 'list', outputDir: './test-results-auth',
  use: { baseURL: 'http://127.0.0.1:5177', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5177', url: 'http://127.0.0.1:5177', reuseExistingServer: false,
    env: { VITE_WRITER_AGENT_AUTH: 'google', VITE_WRITER_AGENT_MODE: 'api', VITE_WRITER_AGENT_PROJECT_ID: 'local' },
  },
})
