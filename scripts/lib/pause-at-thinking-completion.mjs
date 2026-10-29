// Test-only entrypoint: stop synchronously after the durable answer write.
// The parent watches the marker, then delivers real SIGKILL; no timing window.
import {writeFileSync} from 'node:fs';
import { Store } from '../../apps/agent/dist/sessions/store.js';
const marker=process.env.WRITER_AGENT_TEST_COMPLETION_MARKER;
if(!marker || process.env.WRITER_AGENT_PI_FIXTURE!=='1')throw Error('ISOLATED_CRASH_FIXTURE_REQUIRED');
const write = Store.prototype.write;
Store.prototype.write = function(value) {
  write.call(this,value);
  if(value.view.run?.status==='completed' && value.view.messages.at(-1)?.status==='completed') {
    writeFileSync(marker,'completion_persisted',{mode:0o600});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  }
};
await import('../../apps/agent/dist/main.js');
