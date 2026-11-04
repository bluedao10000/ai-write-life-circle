import type { ThinkingMessage, ThinkingSession } from "@writer-agent/contracts";

export const recentMessageLimit = 40;
export const historyPageLimit = 80;
export const fullMessageLimit = 1000;
export type SessionHeader = Omit<ThinkingSession, "messages" | "history">;
export type MessagePage = {
  items: ThinkingMessage[];
  nextBefore?: string;
  hasMore: boolean;
  totalMessages: number;
};
export interface MessageProjection {
  messageCount(): number;
  recentMessages(limit?: number): ThinkingMessage[];
  fullMessages(limit?: number): ThinkingMessage[];
  messagePage(before?: string, limit?: number): MessagePage;
}

/** Reads only the indexed message window; event payloads are never loaded. */
export function projectSnapshot(header: SessionHeader, projection: MessageProjection, limit = recentMessageLimit): ThinkingSession {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > fullMessageLimit) throw Error("INVALID_HISTORY_LIMIT");
  const totalMessages = projection.messageCount();
  const messages = limit === fullMessageLimit ? projection.fullMessages(limit) : projection.recentMessages(limit);
  return {
    ...structuredClone(header),
    messages,
    ...(totalMessages > messages.length ? {
      history: {hasMore:true,oldestMessageId:messages[0]!.id,totalMessages},
    } : {}),
  };
}

export function projectHistory(projection: MessageProjection, before?: string, limit = historyPageLimit): MessagePage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > historyPageLimit) throw Error("INVALID_HISTORY_LIMIT");
  return projection.messagePage(before, limit);
}
