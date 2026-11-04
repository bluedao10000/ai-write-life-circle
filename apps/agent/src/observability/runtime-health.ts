import {runtimeVersion,governanceMetrics} from '../runtime/governance/index.js';
import {reliabilityMetrics} from '../runtime/reliability.js';
import type {Store} from '../sessions/store.js';

type Snapshot={storage:ReturnType<Store['health']>;closing:boolean;activeTasks:number;pendingAdmissions:number;enabledModels:number};
/** Operational projection only: no IDs, payloads, credentials or provider probes. */
export function runtimeHealth(snapshot:Snapshot){
 const {storage}=snapshot;
 const ready=storage.state==='ready'&&!snapshot.closing&&snapshot.enabledModels>0;
 const degraded=ready&&storage.failedSessions>0;
 return {schemaVersion:1,runtimeVersion,process:'thinking',liveness:true,readiness:ready,degraded,
  status:!ready?'not_ready':degraded?'degraded':'ready',
  components:{storage:storage.state==='ready'?(storage.failedSessions>storage.unpublishedSessions?'degraded':'ready'):storage.state,projection:storage.unpublishedSessions?'degraded':storage.state,modelGateway:snapshot.enabledModels>0?'configured':'unavailable',toolRegistry:'loaded',budgetManager:storage.state==='ready'?'ready':storage.state,provider:'not_probed',authorization:'go_authority',worker:'go_heartbeat'},
  counts:{sessions:storage.sessions,activeTasks:snapshot.activeTasks,pendingAdmissions:snapshot.pendingAdmissions,failedSessions:storage.failedSessions,unpublishedSessions:storage.unpublishedSessions,recoveryPending:storage.recoveryPending,unknownUsageSessions:storage.unknownUsageSessions},
 };
}
export function runtimeDiagnostics(snapshot:Snapshot){
 return {health:runtimeHealth(snapshot),metrics:{scope:'process',reliability:reliabilityMetrics(),governance:governanceMetrics()}};
}
