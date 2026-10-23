import { gql } from './api';
import { snoozedUntilText } from './snooze';

export type Activity = {
  id: string;
  type: string;
  conversationId: string | null;
  actorId: string | null;
  actorName: string | null;
  contactName: string | null;
  data: string | null; // JSON
  createdAt: string;
};
export type NotificationFeed = { items: Activity[]; unseen: number };

const FIELDS = 'id type conversationId actorId actorName contactName data createdAt';

export async function fetchConversationActivity(conversationId: string) {
  const query = `query Activity($c: ID!) { conversationActivity(conversationId: $c) { ${FIELDS} } }`;
  return (await gql<{ conversationActivity: Activity[] }>(query, { c: conversationId })).conversationActivity;
}

// The bell lists what happened in your chats (assignments, labels, closed/reopened, edits…). Customer messages
// aren't listed there: they arrive as desktop notifications (like WhatsApp Web) and as the chat list's unread counts.
export const inBell = (a: Pick<Activity, 'type'>) => a.type !== 'message_received';
export const BELL_SIZE = 30;
// The bell from the server's feed: without customer messages; unseen = what's listed and newer than your last look
export function bellFeed(f: { items: Activity[]; seenAt: string | null }): NotificationFeed {
  const items = f.items.filter(inBell).slice(0, BELL_SIZE);
  const seenAt = f.seenAt ? Date.parse(f.seenAt) : null;
  return { items, unseen: items.filter((a) => seenAt === null || Date.parse(a.createdAt) > seenAt).length };
}

export async function fetchNotifications() {
  // more than the bell shows, so it's still full once customer messages are left out
  const query = `query Notifications { notifications(first: 100) { seenAt items { ${FIELDS} } } }`;
  return bellFeed((await gql<{ notifications: { items: Activity[]; seenAt: string | null } }>(query)).notifications);
}

export async function markNotificationsSeen() {
  await gql(`mutation SeenNotifications { markNotificationsSeen }`);
}

export async function fetchUnreadTotal() {
  return (await gql<{ unreadTotal: number }>(`query UnreadTotal { unreadTotal }`)).unreadTotal;
}

function details(a: Activity): Record<string, string | null> {
  try {
    return a.data ? JSON.parse(a.data) : {};
  } catch {
    return {};
  }
}

// "you" when the assignee is linked to the viewer
const assignedTo = (d: Record<string, string | null>, meId: string | null) =>
  d.assigneeUserId && d.assigneeUserId === meId ? 'you' : (d.assignee ?? 'someone');

// One-line description. `where: 'chat'` for the chat timeline ("closed this chat"), 'bell' names the customer.
export function activityText(a: Activity, meId: string | null, where: 'chat' | 'bell') {
  const d = details(a);
  // A person, or the app itself (e.g. "Simple automations" routing a new chat)
  const who = a.actorId && a.actorId === meId ? 'You' : (a.actorName ?? d.by ?? 'Someone');
  const chat = where === 'chat' ? 'this chat' : `the chat with ${a.contactName ?? 'a customer'}`;
  switch (a.type) {
    case 'conversation_closed':
      return `${who} closed ${chat}`;
    case 'conversation_reopened':
      if (d.reason === 'snooze_ended') return `${where === 'chat' ? 'This chat' : `The chat with ${a.contactName ?? 'a customer'}`} is back from snooze`;
      if (d.reason === 'customer_replied') return `The customer wrote, so ${chat} is back from snooze`;
      return `${who} reopened ${chat}`;
    case 'collaborators_added': {
      const names = (a.data ? (JSON.parse(a.data).names as string[] | undefined) : undefined) ?? [];
      return `${who} added ${names.join(', ') || 'someone'} as ${names.length > 1 ? 'collaborators' : 'a collaborator'}${where === 'bell' ? ` on ${chat}` : ''}`;
    }
    case 'collaborator_removed':
      return `${who} removed ${d.name ?? 'someone'} as a collaborator${where === 'bell' ? ` on ${chat}` : ''}`;
    case 'conversation_snoozed':
      return `${who} snoozed ${chat}${d.until ? ` until ${snoozedUntilText(d.until)}` : ''}`;
    case 'assigned':
      return `${who} assigned ${chat} to ${assignedTo(d, meId)}`;
    case 'reassigned':
      return `${who} reassigned ${chat} from ${d.previous ?? 'someone'} to ${assignedTo(d, meId)}`;
    case 'unassigned':
      if (d.reason === 'assignee_deleted') return `${who} deleted ${d.assignee ?? 'the assignee'}, so ${chat} is now unassigned`;
      if (d.reason === 'member_removed') return `${who} removed ${d.assignee ?? 'a member'} from the team, so ${chat} is now unassigned`;
      return d.assignee ? `${who} unassigned ${d.assignee} from ${chat}` : `${who} unassigned ${chat}`;
    case 'label_added':
      return `${who} added label "${d.label}" to ${chat}`;
    case 'label_removed':
      return `${who} removed label "${d.label}" from ${chat}`;
    case 'message_edited':
      return `${who} edited a message${where === 'bell' ? ` in ${chat}` : ''}`;
    case 'message_deleted':
      return `${who} deleted a message${where === 'bell' ? ` in ${chat}` : ''}`;
    case 'message_restored':
      return `${who} restored a deleted message${where === 'bell' ? ` in ${chat}` : ''}`;
    case 'message_received':
      return `${a.contactName ?? 'Customer'}: ${d.preview ?? 'New message'}`;
    // Only ever in the bell of the person mentioned
    case 'note_mention':
      return `${who} mentioned you in a note${where === 'bell' ? ` on ${chat}` : ''}${d.text ? `: ${d.text}` : ''}`;
    default:
      return `${who} updated ${chat}`;
  }
}
