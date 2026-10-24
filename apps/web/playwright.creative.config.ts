import { defineConfig, devices } from '@playwright/test'
const root = process.env.WRITER_AGENT_CREATIVE_FIXTURE
if (!root) throw Error('An isolated creative fixture directory is required.')
// Go API + Vite only. The model endpoint is a closed local port: no model is
// ever called, the test covers author-direct creative assets and compose mode.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'creative.integration.spec.ts',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  timeout: 60_000,
  outputDir: './test-results-creative',
  use: {
    baseURL: 'http://127.0.0.1:5183',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'creative-go', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: '../api-go/dist/writer-agent-api',
      url: 'http://127.0.0.1:8796/healthz',
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        WRITER_AGENT_ENV: 'test',
        WRITER_AGENT_AUTH_MODE: 'local',
        WRITER_AGENT_PROJECT_ID: 'empty-external',
        WRITER_AGENT_API_PORT: '8796',
        WRITER_AGENT_HARNESS_ROOT: root + '/harness',
        WRITER_AGENT_STATE_DIR: root + '/state',
        WRITER_AGENT_LLM_PROVIDER: 'openai-compatible',
        WRITER_AGENT_LLM_BASE_URL: 'http://127.0.0.1:9',
        WRITER_AGENT_LLM_MODEL: 'never-called',
      },
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 5183',
      url: 'http://127.0.0.1:5183',
      reuseExistingServer: false,
      env: {
        VITE_WRITER_AGENT_MODE: 'api',
        VITE_WRITER_AGENT_AUTH: '',
        VITE_WRITER_AGENT_PROJECT_ID: 'empty-external',
        WRITER_AGENT_API_TARGET: 'http://127.0.0.1:8796',
      },
    },
  ],
})
