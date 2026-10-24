import type {AgentTask} from "@writer-agent/contracts";
import {ModelGateway,GatewayError} from "../../runtime/model-gateway.js";
import {validateReviewPrompt} from "./prompt.js";
import {reviewCandidates} from "./schema.js";
export function validateReview(task:AgentTask,gateway:ModelGateway){gateway.validate(task);validateReviewPrompt(task)}
export async function executeReview(task:AgentTask,gateway:ModelGateway,signal:AbortSignal){
 const response=await gateway.execute(task,signal);
 try{reviewCandidates.parse(JSON.parse(response.text))}catch{throw new GatewayError("LLM_INVALID_OUTPUT",response)}
 // Source identity, exact quotations, anchors and freshness are still independently validated by Go.
 return response;
}
