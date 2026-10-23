import {
  REMARK_MAX_LENGTH,
  type ContactUpdate,
  addRemark,
  getPropertyView,
  savePropertyView,
  saveDefaultPropertyView,
  renameStandardProperty,
  type PropertyView,
  updateRemark,
  chatChannel,
  lastOutboundAt,
  phoneCountry,
  listChatFiles,
  deleteRemark,
  getContact,
  listChatNotes,
  listRemarks,
  updateContact,
  leadStageCounts,
} from '../services/contacts.js';
import { type ChoiceField, choiceCounts, choicesOf, saveFieldChoices } from '../services/fieldChoices.js';
import { getWorkspaceSettings, settingsOf, updateWorkspaceSettings } from '../services/workspaceSettings.js';
import { deleteContact, listDeletedContacts, restoreContact } from '../services/deletedContacts.js';
import { createLeadStage, deleteLeadStage, getLeadStages, reorderLeadStages, setDefaultLeadStage, updateLeadStage } from '../services/leadStages.js';
import {
  CUSTOM_TYPES,
  createCustomProperty,
  customValuesOf,
  deleteCustomProperty,
  listCustomProperties,
  setCustomValue,
  updateCustomProperty,
} from '../services/customProperties.js';
import { addContactToList, createContactList, deleteContactList, listContactLists, listsOfContact, removeContactFromList } from '../services/contactLists.js';
import { prisma } from '../prisma.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  extend type Contact {
    "Profile fields edited by the team (chat side panel). Null = not filled in."
    firstName: String
    lastName: String
    email: String
    companyName: String
    jobTitle: String
    "One of contactFieldOptions.leadStages"
    leadStage: String
    "One of contactFieldOptions.leadSources"
    leadSource: String
    "One of contactFieldOptions.priorities"
    priority: String
    "Set by the team; null = not set (see phoneCountry)"
    country: String
    "Country of the phone number's calling code"
    phoneCountry: String
    "Whether the customer wants messages from you (team-managed)"
    subscribed: Boolean!
    "WhatsApp business-scoped user ID, when WhatsApp has sent it"
    waBsuid: String
    "The customer's WhatsApp username, when WhatsApp has sent it"
    waUsername: String
    "The contact lists this customer is in, A to Z"
    lists: [ContactListRef!]!
    "Values of this workspace's custom properties (only the ones set)"
    customValues: [CustomValue!]!
    "This customer's chat (one per customer in a workspace); null if there is none yet"
    conversationId: ID
    updatedAt: DateTime!
  }

  "A named group of customers (e.g. VIP, Leads)"
  type ContactList {
    id: ID!
    name: String!
    contactCount: Int!
    createdAt: DateTime!
  }

  type ContactListRef {
    id: ID!
    name: String!
  }

  extend type Conversation {
    "When your team last sent a message in this chat"
    lastOutboundAt: DateTime
    "The channel this chat runs on, e.g. WhatsApp · +971 4 000 0000"
    channel: String!
  }

  "Internal note about a customer. Only the team sees it; never sent to the customer."
  type ContactRemark {
    id: ID!
    contactId: ID!
    body: String!
    createdById: ID
    authorName: String
    createdAt: DateTime!
    "Last edit; null = never edited"
    editedAt: DateTime
    "Images and documents attached to the note (download: GET /inbox/remark-files/{id})"
    files: [RemarkFile!]!
  }

  "A file on an internal note: only the team can open it; never sent to WhatsApp"
  type RemarkFile {
    id: ID!
    name: String!
    mime: String!
    size: Int!
  }

  "A file (photo, video, voice note, audio, document, sticker) sent in a chat"
  type ChatFile {
    id: ID!
    "image | video | audio | voice | document | sticker"
    type: String!
    "in = from the customer, out = from your team"
    direction: MessageDirection!
    createdAt: DateTime!
    "e.g. image/jpeg, video/mp4, application/pdf (null for older placeholders)"
    mediaMime: String
    "Documents: the file name"
    mediaName: String
    mediaSize: Int
    "The file can be opened (GET /inbox/messages/{id}/media)"
    available: Boolean!
  }

  "Your layout of the profile panel's Contact property, and the workspace's default view"
  type PropertyView {
    "false = the workspace's Default view"
    personal: Boolean!
    "Property keys in your order (personal view)"
    order: [String!]!
    "Property keys you hid (personal view)"
    hidden: [String!]!
    "Default view (set by admins): property keys in order; empty = the standard order"
    defaultOrder: [String!]!
    "Default view: hidden property keys"
    defaultHidden: [String!]!
    "Standard properties renamed for this workspace"
    labels: [PropertyLabel!]!
  }

  type PropertyLabel {
    key: String!
    name: String!
  }

  input DefaultPropertyViewInput {
    order: [String!]!
    hidden: [String!]!
  }

  input PropertyViewInput {
    personal: Boolean!
    order: [String!]!
    hidden: [String!]!
  }

  type ContactOption {
    value: String!
    label: String!
    "Lead stages: the stage's id (Settings → Customer lifecycle)"
    id: ID
    "Lead stages: the stage new contacts start on"
    isDefault: Boolean
    "Lead stages: the stage's colour (#rrggbb)"
    color: String
    "Lead stages: true for a final stage (won, lost)"
    closed: Boolean
  }

  type ContactFieldOptions {
    leadStages: [ContactOption!]!
    leadSources: [ContactOption!]!
    priorities: [ContactOption!]!
    remarkMaxLength: Int!
  }

  "Only the fields you send are changed; an empty string clears a field"
  input ContactInput {
    firstName: String
    lastName: String
    email: String
    companyName: String
    jobTitle: String
    leadStage: String
    leadSource: String
    priority: String
    country: String
    subscribed: Boolean
  }

  "Settings → Contact properties → Add column: a property this workspace adds to every contact"
  type CustomProperty {
    id: ID!
    name: String!
    "Made from the name when created (e.g. tyre_size); never changes"
    key: String!
    "One of customPropertyTypes"
    type: String!
    "Choices (type options)"
    options: [String!]!
    createdAt: DateTime!
  }

  "A contact's value for a custom property (as text: numbers, YYYY-MM-DD dates, true/false for Yes / No)"
  type CustomValue {
    propertyId: ID!
    value: String!
  }

  input CustomPropertyInput {
    name: String!
    type: String!
    options: [String!]
  }

  input CustomPropertyUpdate {
    name: String
    options: [String!]
  }

  input LeadStageInput {
    label: String!
    color: String!
    "true = a Lost stage"
    lost: Boolean
  }

  input LeadStageUpdate {
    label: String
    color: String
  }

  type DeletedLeadStage {
    stages: [ContactOption!]!
    "Contacts moved off the deleted stage"
    moved: Int!
  }

  "Settings → Company settings → Workspace preferences (defaults filled in)"
  type WorkspaceSettings {
    "IANA time zone used when a person hasn't chosen one"
    defaultTimeZone: String!
    "ISO country code preselected for phone numbers"
    defaultCountry: String!
    "Hour the business day starts (snooze: Tomorrow / Monday)"
    businessDayStartHour: Int!
    "Minutes before an unattended chat is reminded (0 = off)"
    reminderMinutes: Int!
    "Idle minutes before someone shows as Away"
    awayMinutes: Int!
    "Days deleted contacts are kept before being removed for good"
    deletedContactRetentionDays: Int!
  }

  input WorkspaceSettingsInput {
    defaultTimeZone: String
    defaultCountry: String
    businessDayStartHour: Int
    reminderMinutes: Int
    awayMinutes: Int
    deletedContactRetentionDays: Int
  }

  input FieldChoiceInput {
    "Keep an existing choice's value (its contacts stay on it); omit for a new one"
    value: String
    label: String!
  }

  type SavedFieldChoices {
    choices: [ContactOption!]!
    "Contacts cleared because their choice was removed"
    cleared: Int!
  }

  type FieldChoiceCount {
    value: String
    count: Int!
  }

  "Settings → Recently deleted contacts"
  type DeletedContact {
    id: ID!
    waId: String!
    name: String
    firstName: String
    lastName: String
    email: String
    deletedAt: DateTime!
    deletedByName: String
    "When it is removed for good"
    purgeAt: DateTime!
  }

  type LeadStageCount {
    stage: String
    count: Int!
  }

  extend type Query {
    contact(id: ID!): Contact!
    "Newest first"
    contactRemarks(contactId: ID!): [ContactRemark!]!
    "Internal notes shown in the chat (its customer's remarks, oldest first; after Clear chat, only later ones). Never sent to WhatsApp"
    chatNotes(conversationId: ID!): [ContactRemark!]!
    contactFieldOptions: ContactFieldOptions!
    "Settings → Customer lifecycle: how many of this workspace's contacts are at each lead stage (stage null = none)"
    leadStageCounts(
      "true: count chats (contacts with a chat, not deleted), as the left menu's stage links list them"
      chats: Boolean
    ): [LeadStageCount!]!
    "Admins only: deleted contacts, newest first (kept for deletedContactsRetentionDays)"
    deletedContacts: [DeletedContact!]!
    "Admins: contacts per Lead source / Priority choice (field = leadSource or priority)"
    fieldChoiceCounts(field: String!): [FieldChoiceCount!]!
    workspaceSettings: WorkspaceSettings!
    deletedContactsRetentionDays: Int!
    "This workspace's custom contact properties, oldest first"
    customProperties: [CustomProperty!]!
    "The property types a custom property can have"
    customPropertyTypes: [ContactOption!]!
    "All contact lists in the workspace, A to Z"
    contactLists: [ContactList!]!
    myPropertyView: PropertyView!
    "Files sent in this chat, newest first (up to 200)"
    chatFiles(conversationId: ID!): [ChatFile!]!
  }

  extend type Mutation {
    "Any member of the workspace"
    updateContact(id: ID!, input: ContactInput!): Contact!
    "mentions: user ids of teammates @mentioned in the note (they get the chat in Mentions and a notification). files: ids from POST /inbox/contacts/{contactId}/remark-files (up to 10); with files the body may be empty"
    addContactRemark(contactId: ID!, body: String!, mentions: [ID!], files: [ID!]): ContactRemark!
    "Saves your own Contact property view"
    savePropertyView(input: PropertyViewInput!): PropertyView!
    "Admins only: the contact and its chat leave the app; restorable for 14 days, then removed for good"
    deleteContact(id: ID!): Boolean!
    "Admins only: the full list of Lead source or Priority choices, in order"
    saveFieldChoices(field: String!, choices: [FieldChoiceInput!]!): SavedFieldChoices!
    "Admins only"
    updateWorkspaceSettings(input: WorkspaceSettingsInput!): WorkspaceSettings!
    "Admins only"
    restoreContact(id: ID!): Boolean!
    "Admins only (Settings → Customer lifecycle); each returns the workspace's stages, in order"
    createLeadStage(input: LeadStageInput!): [ContactOption!]!
    updateLeadStage(id: ID!, input: LeadStageUpdate!): [ContactOption!]!
    "The full order of both groups; listing a stage in the other group moves it there"
    reorderLeadStages(progressing: [ID!]!, lost: [ID!]!): [ContactOption!]!
    setDefaultLeadStage(id: ID!): [ContactOption!]!
    "Its contacts move to moveTo (another stage's value) or to no stage"
    deleteLeadStage(id: ID!, moveTo: String): DeletedLeadStage!
    "Admins only"
    createCustomProperty(input: CustomPropertyInput!): CustomProperty!
    "Admins only: rename, or change an Options property's choices"
    updateCustomProperty(id: ID!, input: CustomPropertyUpdate!): CustomProperty!
    "Admins only: removes the property and every contact's value for it"
    deleteCustomProperty(id: ID!): Boolean!
    "A contact's value for a custom property; empty or null clears it"
    setContactCustomValue(contactId: ID!, propertyId: ID!, value: String): Contact!
    "Admins only: the workspace's default view of contact properties"
    saveDefaultPropertyView(input: DefaultPropertyViewInput!): PropertyView!
    "Admins only: rename a standard property for this workspace (empty name = its original name)"
    renameStandardProperty(key: String!, name: String!): PropertyView!
    "Any member; names are unique in the workspace"
    createContactList(name: String!): ContactList!
    "Owners and admins"
    deleteContactList(id: ID!): Boolean!
    "Any member; returns the customer's lists afterwards"
    addContactToList(contactId: ID!, listId: ID!): [ContactListRef!]!
    removeContactFromList(contactId: ID!, listId: ID!): [ContactListRef!]!
    "The remark's author, or an owner/admin"
    updateContactRemark(id: ID!, body: String!): ContactRemark!
    "The remark's author, or an owner/admin"
    deleteContactRemark(id: ID!): Boolean!
  }
`;

export const resolvers = {
  Contact: {
    phoneCountry: (c: { waId: string }) => phoneCountry(c.waId),
    lists: (c: { id: string; workspaceId: string }) => listsOfContact(c.workspaceId, c.id),
    customValues: (c: { id: string }) => customValuesOf(c.id),
    conversationId: async (c: { id: string; workspaceId: string }) =>
      (await prisma.conversation.findUnique({ where: { workspaceId_contactId: { workspaceId: c.workspaceId, contactId: c.id } }, select: { id: true } }))?.id ?? null,
  },
  Conversation: {
    lastOutboundAt: (c: { id: string }) => lastOutboundAt(c.id),
    channel: (c: { workspaceId: string }) => chatChannel(c.workspaceId),
  },
  Query: {
    contact: authed(async ({ id }: { id: string }, auth) => getContact(auth, id)),
    contactRemarks: authed(async ({ contactId }: { contactId: string }, auth) => listRemarks(auth, contactId)),
    chatNotes: authed(async ({ conversationId }: { conversationId: string }, auth) => listChatNotes(auth, conversationId)),
    contactLists: authed(async (_args: unknown, auth) => listContactLists(auth)),
    myPropertyView: authed(async (_args: unknown, auth) => getPropertyView(auth)),
    chatFiles: authed(async ({ conversationId }: { conversationId: string }, auth) => listChatFiles(auth, conversationId)),
    customProperties: authed(async (_args: unknown, auth) => listCustomProperties(auth)),
    customPropertyTypes: authed(async () => CUSTOM_TYPES),
    deletedContacts: authed(async (_args: unknown, auth) => listDeletedContacts(auth)),
    deletedContactsRetentionDays: authed(async (_args: unknown, auth) => (await settingsOf(auth.workspaceId)).deletedContactRetentionDays),
    leadStageCounts: authed(async ({ chats }: { chats?: boolean | null }, auth) => leadStageCounts(auth, !!chats)),
    contactFieldOptions: authed(async (_args: unknown, auth) => ({
      leadStages: await getLeadStages(auth),
      leadSources: await choicesOf(auth.workspaceId, 'leadSource'),
      priorities: await choicesOf(auth.workspaceId, 'priority'),
      remarkMaxLength: REMARK_MAX_LENGTH,
    })),
    fieldChoiceCounts: authed(async ({ field }: { field: string }, auth) => choiceCounts(auth, field as ChoiceField)),
    workspaceSettings: authed(async (_args: unknown, auth) => getWorkspaceSettings(auth)),
  },
  Mutation: {
    updateContact: authed(async ({ id, input }: { id: string; input: ContactUpdate }, auth) => updateContact(auth, id, input)),
    addContactRemark: authed(async ({ contactId, body, mentions, files }: { contactId: string; body: string; mentions?: string[] | null; files?: string[] | null }, auth) =>
      addRemark(auth, contactId, body, mentions, files),
    ),
    saveFieldChoices: authed(async ({ field, choices }: { field: string; choices: unknown }, auth) => saveFieldChoices(auth, { field, choices })),
    updateWorkspaceSettings: authed(async ({ input }: { input: unknown }, auth) => updateWorkspaceSettings(auth, input)),
    deleteContact: authed(async ({ id }: { id: string }, auth) => !!(await deleteContact(auth, id))),
    restoreContact: authed(async ({ id }: { id: string }, auth) => restoreContact(auth, id)),
    createLeadStage: authed(async ({ input }: { input: unknown }, auth) => createLeadStage(auth, input)),
    updateLeadStage: authed(async ({ id, input }: { id: string; input: unknown }, auth) => updateLeadStage(auth, id, input)),
    reorderLeadStages: authed(async (args: { progressing: string[]; lost: string[] }, auth) => reorderLeadStages(auth, args)),
    setDefaultLeadStage: authed(async ({ id }: { id: string }, auth) => setDefaultLeadStage(auth, id)),
    deleteLeadStage: authed(async ({ id, moveTo }: { id: string; moveTo?: string | null }, auth) => deleteLeadStage(auth, id, moveTo ?? null)),
    createCustomProperty: authed(async ({ input }: { input: unknown }, auth) => createCustomProperty(auth, input)),
    updateCustomProperty: authed(async ({ id, input }: { id: string; input: unknown }, auth) => updateCustomProperty(auth, id, input)),
    deleteCustomProperty: authed(async ({ id }: { id: string }, auth) => deleteCustomProperty(auth, id)),
    setContactCustomValue: authed(async ({ contactId, propertyId, value }: { contactId: string; propertyId: string; value: string | null }, auth) =>
      setCustomValue(auth, contactId, propertyId, value),
    ),
    renameStandardProperty: authed(async ({ key, name }: { key: string; name: string }, auth) => renameStandardProperty(auth, key, name)),
    saveDefaultPropertyView: authed(async ({ input }: { input: unknown }, auth) => saveDefaultPropertyView(auth, input)),
    savePropertyView: authed(async ({ input }: { input: PropertyView }, auth) => savePropertyView(auth, input)),
    createContactList: authed(async ({ name }: { name: string }, auth) => createContactList(auth, name)),
    deleteContactList: authed(async ({ id }: { id: string }, auth) => deleteContactList(auth, id)),
    addContactToList: authed(async ({ contactId, listId }: { contactId: string; listId: string }, auth) => addContactToList(auth, contactId, listId)),
    removeContactFromList: authed(async ({ contactId, listId }: { contactId: string; listId: string }, auth) => removeContactFromList(auth, contactId, listId)),
    updateContactRemark: authed(async ({ id, body }: { id: string; body: string }, auth) => updateRemark(auth, id, body)),
    deleteContactRemark: authed(async ({ id }: { id: string }, auth) => deleteRemark(auth, id)),
  },
};
