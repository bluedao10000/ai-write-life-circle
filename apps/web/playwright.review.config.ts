import { defineConfig, devices } from '@playwright/test'
const state=process.env.WRITER_AGENT_E2E_STATE_DIR,harness=process.env.WRITER_AGENT_E2E_HARNESS_ROOT,model=process.env.WRITER_AGENT_E2E_MODEL_ORIGIN
if(!state||!harness||!model) throw Error('Run via the isolated review E2E runner.')
export default defineConfig({
  testDir:'./e2e',testMatch:'review.integration.spec.ts',fullyParallel:false,workers:1,retries:0,reporter:'list',outputDir:'./test-results-review',
  use:{baseURL:'http://127.0.0.1:5176',viewport:{width:1440,height:900},screenshot:'only-on-failure',trace:'retain-on-failure'},
  projects:[{name:'chromium-review',use:{...devices['Desktop Chrome']}}],
  webServer:[
    {command:'../api-go/dist/writer-agent-api',url:'http://127.0.0.1:8789/healthz',reuseExistingServer:false,env:{WRITER_AGENT_ENV:'test',WRITER_AGENT_PROJECT_ID:'review-fixture',WRITER_AGENT_API_PORT:'8789',WRITER_AGENT_HARNESS_ROOT:harness,WRITER_AGENT_STATE_DIR:state,WRITER_AGENT_LLM_PROVIDER:'openai-compatible',WRITER_AGENT_LLM_BASE_URL:`${model}/v1`,WRITER_AGENT_LLM_MODEL:'deterministic-test-only',WRITER_AGENT_LLM_API_KEY:'',WRITER_AGENT_LLM_RESPONSE_FORMAT:'none'}},
    {command:'pnpm exec vite --host 127.0.0.1 --port 5176',url:'http://127.0.0.1:5176',reuseExistingServer:false,env:{VITE_WRITER_AGENT_MODE:'api',VITE_WRITER_AGENT_PROJECT_ID:'review-fixture',WRITER_AGENT_API_TARGET:'http://127.0.0.1:8789'}},
  ],
})
