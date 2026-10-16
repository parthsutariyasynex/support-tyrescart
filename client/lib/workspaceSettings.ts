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
};
const FIELDS = 'defaultTimeZone defaultCountry businessDayStartHour reminderMinutes awayMinutes deletedContactRetentionDays';

export async function fetchWorkspaceSettings() {
  return (await gql<{ workspaceSettings: WorkspaceSettings }>(`{ workspaceSettings { ${FIELDS} } }`)).workspaceSettings;
}
export async function updateWorkspaceSettings(input: Partial<WorkspaceSettings>) {
  return (await gql<{ updateWorkspaceSettings: WorkspaceSettings }>(`mutation SaveWorkspaceSettings($i: WorkspaceSettingsInput!) { updateWorkspaceSettings(input: $i) { ${FIELDS} } }`, { i: input }))
    .updateWorkspaceSettings;
}
