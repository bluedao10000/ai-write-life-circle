import {execFileSync} from "node:child_process";
import {join,resolve} from "node:path";

const args=process.argv.slice(2);
if(args.length<9 || args.length>10)throw Error("Usage: prepare-thinking-rollback.mjs --pi-state DIR --registry FILE --output DIR --rollback-bin FILE --compatible-go|--legacy-go");
const value=(flag)=>{const i=args.indexOf(flag);if(i<0||!args[i+1])throw Error(`Missing ${flag}`);return resolve(args[i+1])};
const pi=value("--pi-state"),registry=value("--registry"),output=value("--output"),tool=value("--rollback-bin");
const compatible=args.includes("--compatible-go"),legacy=args.includes("--legacy-go");
if(compatible===legacy)throw Error("Choose exactly one --compatible-go or --legacy-go");
execFileSync(process.execPath,["--import","tsx",join(process.cwd(),"scripts/lib/thinking-rollback.mts"),"--pi-state",pi,"--output",join(output,"pi")],{stdio:"inherit"});
execFileSync(tool,[registry,join(output,"sessions-v1.json"),compatible?"--compatible-go":"--legacy-go"],{stdio:"inherit"});
console.log(JSON.stringify({event:"thinking_rollback_prepared",output,compatibleGo:compatible,sourceUnchanged:true,next:"Verify outputs with both services stopped. Install only with an explicit backup; open billing reservations and durable cancel fences are not silently discarded."}));
