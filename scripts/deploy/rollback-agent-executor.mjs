import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);if(args.includes('--owner'))throw Error('Rollback owner is fixed to go');const r=spawnSync(process.execPath,[new URL('./switch-agent-executor.mjs',import.meta.url).pathname,...args,'--owner','go'],{stdio:'inherit'});process.exit(r.status??1);
