/** Drain the public cursor API through the snapshot being evaluated. */
export async function readThinkingEvents(call,path,through){
 const items=[];let after=0;
 while(after<through){
  const page=await call(path+'/events?after='+after);
  if(!page.items?.length||page.cursor<=after)throw Error('EVAL_EVENT_CURSOR_STALLED');
  for(const event of page.items){if(event.id!==after+1)throw Error('EVAL_EVENT_CURSOR_GAP');if(event.id>through)break;items.push(event);after=event.id}
 }
 return {items,cursor:after};
}
