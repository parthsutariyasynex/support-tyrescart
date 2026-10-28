  import { gql } from './api';

// AI Assistant (server: services/ai.ts). AI Summary: owners, admins and supervisors; AI Reply: a suggestion for
// whoever may reply. A reply is only ever sent through the normal sendTextMessage, after the person confirms.
export type ConversationSummary = {
  id: string;
  conversationId: string;
  summary: string;
  lastMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  updatedByName: string | null;
  upToDate: boolean;
  // After Generate/Regenerate: how many messages that run added (0: nothing new, the AI wasn't asked); null when read
  addedMessages: number | null;
};

const SUMMARY_FIELDS = 'id conversationId summary lastMessageId createdAt updatedAt createdByName updatedByName upToDate addedMessages';

// Whether the server has AI set up (the AI Assistant tab shows only then); asked once per page load
let configured: Promise<boolean> | null = null;
export function fetchAiConfigured() {
  configured ??= gql<{ aiConfigured: boolean }>('query AiConfigured { aiConfigured }').then(
    (d) => d.aiConfigured,
    () => {
      configured = null; // try again next time
      return false;
    },
  );
  return configured;
}

export async function fetchConversationSummary(conversationId: string) {
  const d = await gql<{ conversationSummary: ConversationSummary | null }>(
    `query ConversationSummary($conversationId: ID!) { conversationSummary(conversationId: $conversationId) { ${SUMMARY_FIELDS} } }`,
    { conversationId },
  );
  return d.conversationSummary;
}

// Generate, or Regenerate (rewrites the saved one)
export async function generateConversationSummary(conversationId: string) {
  const d = await gql<{ generateConversationSummary: ConversationSummary }>(
    `mutation GenerateConversationSummary($conversationId: ID!) { generateConversationSummary(conversationId: $conversationId) { ${SUMMARY_FIELDS} } }`,
    { conversationId },
  );
  return d.generateConversationSummary;
}

// A reply to edit; nothing is saved or sent
export async function suggestReply(conversationId: string) {
  const d = await gql<{ suggestReply: string }>('mutation SuggestReply($conversationId: ID!) { suggestReply(conversationId: $conversationId) }', { conversationId });
  return d.suggestReply;
}
