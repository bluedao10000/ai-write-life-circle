import { defineConfig, devices } from '@playwright/test'
const root = process.env.WRITER_AGENT_PUBLIC_FIXTURE_ROOT,
  state = process.env.WRITER_AGENT_PUBLIC_FIXTURE_STATE
if (!root || !state) throw Error('Use the isolated public site E2E runner.')
export default defineConfig({
  testDir: './e2e',
  testMatch: 'public.integration.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  outputDir: './test-results-public',
  use: {
    baseURL: 'http://127.0.0.1:5177',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-public', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: '../api-go/dist/writer-agent-api',
      url: 'http://127.0.0.1:8791/healthz',
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        WRITER_AGENT_ENV: 'test',
        WRITER_AGENT_AUTH_MODE: 'local',
        WRITER_AGENT_AUTHOR_ID: '',
        WRITER_AGENT_PROJECT_ID: 'site-fixture',
        WRITER_AGENT_API_PORT: '8791',
        WRITER_AGENT_HARNESS_ROOT: root,
        WRITER_AGENT_STATE_DIR: state,
        WRITER_AGENT_LLM_API_KEY: '',
        WRITER_AGENT_LLM_BASE_URL: '',
      },
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 5177',
      url: 'http://127.0.0.1:5177',
      reuseExistingServer: false,
      env: {
        VITE_STORY2U_PUBLIC_SITE: 'true',
        WRITER_AGENT_PUBLIC_SSR: '1',
        VITE_WRITER_AGENT_MODE: 'api',
        VITE_WRITER_AGENT_PROJECT_ID: 'site-fixture',
        WRITER_AGENT_API_TARGET: 'http://127.0.0.1:8791',
        STORY2U_SITE_ORIGIN: 'https://www.story2u.xyz',
      },
    },
  ],
})
