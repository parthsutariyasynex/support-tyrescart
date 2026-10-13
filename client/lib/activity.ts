import { gql } from './api';

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

export async function fetchNotifications() {
  return (await gql<{ notifications: NotificationFeed }>(`query Notifications { notifications { unseen items { ${FIELDS} } } }`))
    .notifications;
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
  const who = a.actorId && a.actorId === meId ? 'You' : (a.actorName ?? 'Someone');
  const chat = where === 'chat' ? 'this chat' : `the chat with ${a.contactName ?? 'a customer'}`;
  const d = details(a);
  switch (a.type) {
    case 'conversation_closed':
      return `${who} closed ${chat}`;
    case 'conversation_reopened':
      return `${who} reopened ${chat}`;
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
    default:
      return `${who} updated ${chat}`;
  }
}
