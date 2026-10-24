export const maxCalls=2,maxReservedTokens=100000;
export function authorize(args,env){
 if(!args.includes('--confirm-fixtures'))throw Error('Explicit synthetic data authorization required: --confirm-fixtures');
 if(!env.WRITER_AGENT_LLM_API_KEY)throw Error('Configure WRITER_AGENT_LLM_API_KEY locally; never paste it into chat');
 const endpoint=env.WRITER_AGENT_LLM_BASE_URL??'https://api.deepseek.com',url=new URL(endpoint);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Live Eval requires an explicit HTTPS model origin');
 return {key:env.WRITER_AGENT_LLM_API_KEY,endpoint};
}
export function reserve(state,tokens){
 if(!Number.isSafeInteger(tokens)||tokens<1||state.calls>=maxCalls||state.reserved+tokens>maxReservedTokens)throw Error('Synthetic Eval hard cap reached before model send');
 state.calls++;state.reserved+=tokens;
}
