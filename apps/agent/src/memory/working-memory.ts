import type {ThinkingMessage} from '@writer-agent/contracts';

export type WorkingMemory={through:number;summary:string;provenance?:{schemaVersion:1;messageIds:string[]}};
export const visibleMessages=(messages:ThinkingMessage[])=>messages.filter(message=>message.role==='user'||message.status==='completed');

/** Sources are immutable session messages; the Store owns their lifetime and isolation. */
export function currentWorkingMemory(messages:ThinkingMessage[],memory:WorkingMemory|undefined):WorkingMemory|undefined {
 if(!memory||!Number.isSafeInteger(memory.through)||memory.through<1||memory.through>messages.length)return undefined;
 // Legacy through already identifies this session's immutable prefix.
 if(!memory.provenance)return workingMemory(messages,memory.through,memory.summary);
 if(memory.provenance.schemaVersion!==1)return undefined;
 const sources=visibleMessages(messages.slice(0,memory.through));
 if(sources.length!==memory.provenance.messageIds.length||sources.some((message,index)=>message.id!==memory.provenance!.messageIds[index]))return undefined;
 return memory;
}

export function workingMemory(messages:ThinkingMessage[],through:number,summary:string):WorkingMemory {
 return {through,summary,provenance:{schemaVersion:1,messageIds:visibleMessages(messages.slice(0,through)).map(message=>message.id)}};
}
