import type { Conversation } from './inbox';

// The chat list's "Filter by" menu. Within a group any choice matches (OR); across groups all must match (AND).
// The server applies the same rules (conversations query), this mirrors them for live updates on screen.
export type MenuFilters = {
  labelIds: string[];
  // Member ids of assignees, or 'unassigned'
  assigneeIds: string[];
  // Last activity range, local calendar days yyyy-mm-dd ('' = open)
  from: string;
  to: string;
};

export const EMPTY_MENU_FILTERS: MenuFilters = { labelIds: [], assigneeIds: [], from: '', to: '' };

export const activeFilterCount = (f: MenuFilters) =>
  (f.labelIds.length ? 1 : 0) + (f.assigneeIds.length ? 1 : 0) + (f.from || f.to ? 1 : 0);

export const dayStart = (day: string) => (day ? new Date(`${day}T00:00:00`).toISOString() : null);
export const dayEnd = (day: string) => (day ? new Date(`${day}T23:59:59.999`).toISOString() : null);

export function toServerFilter(f: MenuFilters) {
  return {
    labelIds: f.labelIds.length ? f.labelIds : null,
    assigneeIds: f.assigneeIds.length ? f.assigneeIds : null,
    from: dayStart(f.from),
    to: dayEnd(f.to),
  };
}

export function matchesMenuFilters(c: Pick<Conversation, 'labels' | 'assignee' | 'lastMessageAt'>, f: MenuFilters) {
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
