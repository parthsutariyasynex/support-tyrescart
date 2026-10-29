import { gql } from './api';

// Settings → Company settings → Workspace preferences: the workspace's defaults and timings (the server fills in
// the app's defaults for anything an admin hasn't set)
export type WorkspaceSettings = {
  defaultTimeZone: string;
  defaultCountry: string;
  businessDayStartHour: number;
  reminderMinutes: number;
  awayMinutes: number;
  deletedContactRetentionDays: number;
  // The most chats pinned for the whole team, and the most pinned messages in one chat (default 5). Owners/admins only:
  // the server sends null to anyone else (this page is admin-only anyway)
  pinLimit: number | null;
};
const FIELDS = 'defaultTimeZone defaultCountry businessDayStartHour reminderMinutes awayMinutes deletedContactRetentionDays pinLimit';

export async function fetchWorkspaceSettings() {
  return (await gql<{ workspaceSettings: WorkspaceSettings }>(`{ workspaceSettings { ${FIELDS} } }`)).workspaceSettings;
}
export async function updateWorkspaceSettings(input: Partial<WorkspaceSettings>) {
  return (await gql<{ updateWorkspaceSettings: WorkspaceSettings }>(`mutation SaveWorkspaceSettings($i: WorkspaceSettingsInput!) { updateWorkspaceSettings(input: $i) { ${FIELDS} } }`, { i: input }))
    .updateWorkspaceSettings;
}
