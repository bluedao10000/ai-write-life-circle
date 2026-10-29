// Test-only loader: prove the old Store parses and recovers converted files.
import { Store } from "../../../apps/agent/dist/sessions/store.js";

const directory = process.argv[3];
const legacyDist = process.argv[2];
if (!directory || !legacyDist) throw Error("legacy dist and Store directory are required");
const {Store: LegacyStore} = await import(`${legacyDist}/sessions/store.js`);
const store = new LegacyStore(directory) as Store;
try {
  store.recover();
  for (const id of process.argv.slice(4)) {
    const saved = store.read(id);
    if (!saved && store.isDeleted(id)) {
      console.log(JSON.stringify({id,status:"deleted",messages:0,receipts:0,deleted:true}));
      continue;
    }
    if (!saved) throw Error("converted session not found");
    console.log(JSON.stringify({id,status:saved.view.status,messages:saved.view.messages.length,usage:saved.view.usage,receipts:Object.keys(saved.requests).length,deleted:saved.deleted===true}));
  }
} finally {store.close()}
