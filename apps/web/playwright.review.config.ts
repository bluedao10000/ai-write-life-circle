import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir:'./e2e',testMatch:'review.integration.spec.ts',fullyParallel:false,workers:1,retries:0,reporter:'list',outputDir:'./test-results-review',
  use:{baseURL:'http://127.0.0.1:5176',viewport:{width:1440,height:900},screenshot:'only-on-failure',trace:'retain-on-failure'},
  projects:[{name:'chromium-review',use:{...devices['Desktop Chrome']}}],
  webServer:[
    {command:'pnpm exec vite --host 127.0.0.1 --port 5176',url:'http://127.0.0.1:5176',reuseExistingServer:false,env:{VITE_WRITER_AGENT_MODE:'api',VITE_WRITER_AGENT_PROJECT_ID:'review-fixture',WRITER_AGENT_API_TARGET:'http://127.0.0.1:8789'}},
  ],
})
