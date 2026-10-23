import type { Conversation } from './inbox';
import { zonedInstant } from './time';

// The chat list's "Filter by" menu. Within a group any choice matches (OR); across groups all must match (AND).
// The server applies the same rules (conversations query), this mirrors them for live updates on screen.
export type MenuFilters = {
  labelIds: string[];
  // Member ids of assignees, or 'unassigned'
  assigneeIds: string[];
  // Last activity range, local calendar days yyyy-mm-dd ('' = open)
  from: string;
  to: string;
  // Lifecycle stages of the customer (stage values)
  leadStages: string[];
};

export const EMPTY_MENU_FILTERS: MenuFilters = { labelIds: [], assigneeIds: [], from: '', to: '', leadStages: [] };

export const activeFilterCount = (f: MenuFilters) =>
  (f.labelIds.length ? 1 : 0) + (f.assigneeIds.length ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.leadStages.length ? 1 : 0);

// A Dubai calendar day's first and last moment, for the server (not the browser's own time zone)
export const dayStart = (day: string) => (day ? zonedInstant(day, '00:00:00.000').toISOString() : null);
export const dayEnd = (day: string) => (day ? zonedInstant(day, '23:59:59.999').toISOString() : null);

export function toServerFilter(f: MenuFilters) {
  return {
    labelIds: f.labelIds.length ? f.labelIds : null,
    assigneeIds: f.assigneeIds.length ? f.assigneeIds : null,
    from: dayStart(f.from),
    to: dayEnd(f.to),
    leadStages: f.leadStages.length ? f.leadStages : null,
  };
}

export function matchesMenuFilters(c: Pick<Conversation, 'labels' | 'assignee' | 'lastMessageAt' | 'contact'>, f: MenuFilters) {
  if (f.leadStages.length && !(c.contact.leadStage && f.leadStages.includes(c.contact.leadStage))) return false;
  if (f.labelIds.length && !c.labels.some((l) => f.labelIds.includes(l.id))) return false;
  if (f.assigneeIds.length) {
    const key = c.assignee ? c.assignee.id : 'unassigned';
    if (!f.assigneeIds.includes(key)) return false;
  }
  const at = new Date(c.lastMessageAt).getTime();
  const from = dayStart(f.from);
  const to = dayEnd(f.to);
  if (from && at < new Date(from).getTime()) return false;
  if (to && at > new Date(to).getTime()) return false;
  return true;
}

export const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
