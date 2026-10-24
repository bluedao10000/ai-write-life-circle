import { defineConfig, devices } from '@playwright/test'
const root = process.env.WRITER_AGENT_MANAGEMENT_FIXTURE
if (!root) throw Error('An isolated management fixture directory is required.')
export default defineConfig({
  testDir: './e2e',
  testMatch: 'management.integration.spec.ts',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  timeout: 60_000,
  outputDir: './test-results-management',
  use: {
    baseURL: 'http://127.0.0.1:5181',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'managed-go', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: '../api-go/dist/writer-agent-api',
      url: 'http://127.0.0.1:8794/healthz',
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        WRITER_AGENT_ENV: 'test',
        WRITER_AGENT_AUTH_MODE: 'local',
        WRITER_AGENT_PROJECT_ID: 'empty-external',
        WRITER_AGENT_API_PORT: '8794',
        WRITER_AGENT_HARNESS_ROOT: root + '/harness',
        WRITER_AGENT_STATE_DIR: root + '/state',
      },
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 5181',
      url: 'http://127.0.0.1:5181',
      reuseExistingServer: false,
      env: {
        VITE_WRITER_AGENT_MODE: 'api',
        VITE_WRITER_AGENT_AUTH: '',
        VITE_STORY2U_PUBLIC_SITE: 'true',
        VITE_WRITER_AGENT_PROJECT_ID: 'empty-external',
        WRITER_AGENT_API_TARGET: 'http://127.0.0.1:8794',
      },
    },
  ],
})
