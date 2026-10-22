import type { SendValues, TemplateInfo } from './templateModel.js';

// Follow-up after 24 hours: the rules, without I/O (sending is in followUps.ts). Kept free of the app's other
// modules, which import each other in a loop that reaches Simple automations' settings.
//
// The follow-up is the workspace's own Meta-approved template, written in Settings → Message templates and found by
// its name: `follow_up` or `follow_up_…` (e.g. follow_up_inquiry). Nothing is chosen in Simple automations and no
// text is built in. Its variables are filled from the customer's details:
//   - numbered ones by position: {{1}} = first name, {{2}} = last name;
//   - named ones by name, from the workspace's contact and company variables: {{first_name}}, {{company_name}}…

export const FOLLOW_UP_NAME = 'follow_up';
export const isFollowUpName = (name: string) => name === FOLLOW_UP_NAME || name.startsWith(`${FOLLOW_UP_NAME}_`);
// Numbered variables, by position
export const POSITIONAL_KEYS = ['contact.first_name', 'contact.last_name'];
const POSITIONAL_LABELS = ['first name', 'last name'];

// A template variable and the contact (or company) detail that fills it
export type FollowUpVariable = { part: 'header' | 'body'; name: string; key: string };

const variablesOf = (t: TemplateInfo) => [
  ...(t.header?.variables ?? []).map((name) => ({ part: 'header' as const, name })),
  ...t.body.variables.map((name) => ({ part: 'body' as const, name })),
];

// Why an approved template can't be sent automatically (null = it can): nobody is there to add a header file or
// button values
export function templateProblem(t: TemplateInfo): string | null {
  if (!t.sendable) return t.unsupportedReason ?? "This template can't be sent from here";
  if (t.header && t.header.format !== 'TEXT') return `it has a${t.header.format === 'IMAGE' ? 'n' : ''} ${t.header.format.toLowerCase()} header`;
  if (t.buttons.some((b) => b.variables.length)) return 'its buttons need a value';
  return null;
}

// What fills each variable, or why it can't be filled automatically. `known` = the workspace's variable keys.
export function followUpVariablesOf(t: TemplateInfo, known: string[]): { vars: FollowUpVariable[] } | { problem: string } {
  const vars: FollowUpVariable[] = [];
  for (const v of variablesOf(t)) {
    let key: string | null;
    if (/^\d+$/.test(v.name)) {
      key = POSITIONAL_KEYS[Number(v.name) - 1] ?? null;
      if (!key) return { problem: `{{${v.name}}} isn't filled automatically: follow-ups use {{1}} = ${POSITIONAL_LABELS[0]} and {{2}} = ${POSITIONAL_LABELS[1]}` };
    } else {
      // a named variable: the workspace's variable of that name ({{first_name}} = contact.first_name)
      const name = v.name.toLowerCase();
      const matches = known.includes(name) ? [name] : known.filter((k) => k.endsWith(`.${name}`));
      key = matches.length === 1 ? matches[0] : null;
      if (!key) return { problem: `{{${v.name}}} isn't a contact or company detail of this workspace` };
    }
    vars.push({ ...v, key });
  }
  return { vars };
}

// The workspace's follow-up among its approved templates (follow_up / follow_up_…), or why there's none to send.
// Several: the first by name, then language, that can be sent automatically.
export function pickFollowUpTemplate(approved: TemplateInfo[], known: string[]): { template: TemplateInfo; vars: FollowUpVariable[]; others: number } | { problem: string } {
  const named = approved.filter((t) => isFollowUpName(t.name)).sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
  if (!named.length) return { problem: `No approved template named ${FOLLOW_UP_NAME} or ${FOLLOW_UP_NAME}_… on this WhatsApp number (create one in Settings → Message templates)` };
  const reasons: string[] = [];
  for (const t of named) {
    const problem = templateProblem(t);
    const filled = problem ? { problem } : followUpVariablesOf(t, known);
    if ('vars' in filled) return { template: t, vars: filled.vars, others: named.length - 1 };
    reasons.push(`${t.name} (${t.language}): ${filled.problem}`);
  }
  return { problem: `No follow-up template can be sent automatically: ${reasons.join('; ')}` };
}

// The values a follow-up sends, from the customer's details. WhatsApp refuses empty values, so a variable with no
// value for this customer is reported (and nothing is sent).
export function followUpValues(t: TemplateInfo, vars: FollowUpVariable[], data: Record<string, string>): { values: SendValues } | { missing: string } {
  const values: SendValues = { header: {}, body: {}, buttons: {} };
  for (const p of variablesOf(t)) {
    const v = vars.find((x) => x.part === p.part && x.name === p.name);
    const value = (v ? data[v.key] : '')?.trim() ?? '';
    if (!value) return { missing: `{{${p.name}}}${v ? ` (${v.key})` : ''}` };
    values[p.part][p.name] = value;
  }
  return { values };
}
