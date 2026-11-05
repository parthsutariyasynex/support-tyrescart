import { gql } from './api';

// AI Robot (server: services/aiRobot.ts): automatic WhatsApp replies in unassigned chats.
//   Settings → AI Robot (owners and admins): the settings, and Test the robot (what it would answer; nothing sent).
//   The chat's AI Robot tab (everyone who sees the chat): where the robot stands, Stop robot, its drafts and history.
export type AiRobotSettings = {
  enabled: boolean;
  mode: 'draft' | 'live';
  firstReplyMins: number;
  groupSeconds: number;
  hoursRule: 'any' | 'in_hours' | 'out_hours';
  maxRepliesPerDay: number;
  minConfidence: number;
  webSearch: boolean;
  handoverMessage: string | null;
  defaultHandoverMessage: string;
  defaultHandoverMessageArabic: string;
  companyInfo: string | null;
  bannedPhrases: string | null;
  serverEnabled: boolean;
  aiConfigured: boolean;
  catalogueConfigured: boolean;
  webSearchAvailable: boolean;
  updatedAt: string | null;
};
export type AiRobotInput = Partial<Pick<AiRobotSettings, 'enabled' | 'mode' | 'firstReplyMins' | 'groupSeconds' | 'hoursRule' | 'maxRepliesPerDay' | 'minConfidence' | 'webSearch' | 'handoverMessage' | 'companyInfo' | 'bannedPhrases'>>;
const SETTINGS_FIELDS = `enabled mode firstReplyMins groupSeconds hoursRule maxRepliesPerDay minConfidence webSearch handoverMessage
  defaultHandoverMessage defaultHandoverMessageArabic companyInfo bannedPhrases serverEnabled aiConfigured catalogueConfigured webSearchAvailable updatedAt`;

export async function fetchAiRobotSettings() {
  return (await gql<{ aiRobotSettings: AiRobotSettings }>(`query AiRobotSettings { aiRobotSettings { ${SETTINGS_FIELDS} } }`)).aiRobotSettings;
}
export async function updateAiRobotSettings(input: AiRobotInput) {
  return (await gql<{ updateAiRobotSettings: AiRobotSettings }>(`mutation SaveAiRobot($i: AiRobotSettingsInput!) { updateAiRobotSettings(input: $i) { ${SETTINGS_FIELDS} } }`, { i: input }))
    .updateAiRobotSettings;
}

// off | waiting | active | stopped | handover
export type AiRobotState = 'off' | 'waiting' | 'active' | 'stopped' | 'handover';
export type AiRobotStatus = { conversationId: string; state: AiRobotState; label: string; dueAt: string | null; mode: 'draft' | 'live' };
export type AiRobotRun = {
  id: string;
  // order: collected an order (tyre, quantity, place, day), sent the summary and handed the chat over
  action: 'reply' | 'draft' | 'order' | 'handover' | 'blocked' | 'failed';
  reason: string | null;
  confidence: number | null;
  draft: string | null;
  tools: string[];
  inMessageId: string | null;
  messageId: string | null;
  createdAt: string;
};
const STATUS_FIELDS = 'conversationId state label dueAt mode';
const RUN_FIELDS = 'id action reason confidence draft tools inMessageId messageId createdAt';

// The chat's robot status and its latest decisions (newest first), in one request
export async function fetchAiRobotChat(conversationId: string, limit = 20) {
  return gql<{ aiRobotStatus: AiRobotStatus; aiRobotRuns: AiRobotRun[] }>(
    `query AiRobotChat($id: ID!, $limit: Int) { aiRobotStatus(conversationId: $id) { ${STATUS_FIELDS} } aiRobotRuns(conversationId: $id, limit: $limit) { ${RUN_FIELDS} } }`,
    { id: conversationId, limit },
  );
}
export async function stopAiRobot(conversationId: string) {
  return (await gql<{ stopAiRobot: AiRobotStatus }>(`mutation StopAiRobot($id: ID!) { stopAiRobot(conversationId: $id) { ${STATUS_FIELDS} } }`, { id: conversationId })).stopAiRobot;
}

export type AiRobotTest = { action: 'reply' | 'order' | 'handover'; reply: string; aiReply: string | null; reason: string | null; blockedBy: string | null; confidence: number | null; model: string; tools: string[]; sources: string[] };
export async function testAiRobot(conversationId: string) {
  return (
    await gql<{ testAiRobot: AiRobotTest }>(`mutation TestAiRobot($id: ID!) { testAiRobot(conversationId: $id) { action reply aiReply reason blockedBy confidence model tools sources } }`, {
      id: conversationId,
    })
  ).testAiRobot;
}
export type AiRobotTestChat = { conversationId: string; name: string; status: string; assigned: boolean; robotState: string | null; lastCustomerMessage: string };
export async function fetchAiRobotTestChats() {
  return (await gql<{ aiRobotTestChats: AiRobotTestChat[] }>('query AiRobotTestChats { aiRobotTestChats { conversationId name status assigned robotState lastCustomerMessage } }')).aiRobotTestChats;
}

// Socket "ai-robot:state" relayed on window by the inbox: the robot did something in this chat (detail: { conversationId })
export const AI_ROBOT_EVENT = 'app:ai-robot-state';

// What a decision is called in the history
export const RUN_LABELS: Record<AiRobotRun['action'], string> = {
  reply: 'Replied',
  draft: 'Draft (not sent)',
  order: 'Order collected, handed to the team',
  handover: 'Handed over to the team',
  blocked: 'Not sent',
  failed: 'Failed',
};

// "3:12" until the robot replies (mm:ss, or h:mm:ss); "0:00" once due
export function countdown(dueAt: string, now = Date.now()) {
  const s = Math.max(0, Math.ceil((new Date(dueAt).getTime() - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Tool lines as people read them: "search_tyres 245/40 R18: 5 of 9" → "Searched tyres 245/40 R18: 5 of 9"
export function toolText(line: string) {
  return line
    .replace(/^search_tyres /, 'Searched tyres ')
    .replace(/^find_tyre_size /, 'Looked up the car’s tyre size: ')
    .replace(/^search_web /, 'Searched the web: ');
}
