import { gql } from './api';

// Contact lists (profile panel "Lists"): named groups of customers. Every member can create lists and add or
// remove customers; owners/admins delete lists (the server checks).
export type ContactList = { id: string; name: string; contactCount: number };
export type ContactListRef = { id: string; name: string };

export async function fetchContactLists() {
  return (await gql<{ contactLists: ContactList[] }>(`{ contactLists { id name contactCount } }`)).contactLists;
}
export async function createContactList(name: string) {
  return (await gql<{ createContactList: ContactList }>(`mutation CreateList($n: String!) { createContactList(name: $n) { id name contactCount } }`, { n: name })).createContactList;
}
export async function deleteContactList(id: string) {
  return (await gql<{ deleteContactList: boolean }>(`mutation DeleteList($id: ID!) { deleteContactList(id: $id) }`, { id })).deleteContactList;
}
export async function addContactToList(contactId: string, listId: string) {
  return (await gql<{ addContactToList: ContactListRef[] }>(`mutation AddToList($c: ID!, $l: ID!) { addContactToList(contactId: $c, listId: $l) { id name } }`, { c: contactId, l: listId })).addContactToList;
}
export async function removeContactFromList(contactId: string, listId: string) {
  return (await gql<{ removeContactFromList: ContactListRef[] }>(`mutation RemoveFromList($c: ID!, $l: ID!) { removeContactFromList(contactId: $c, listId: $l) { id name } }`, { c: contactId, l: listId })).removeContactFromList;
}

// Dropdown search: lists whose name contains the text; "Create list" is offered when no list has exactly that name
export function searchLists<L extends { name: string }>(lists: L[], query: string) {
  const term = query.trim();
  const lower = term.toLowerCase();
  const shown = lower ? lists.filter((l) => l.name.toLowerCase().includes(lower)) : lists;
  const canCreate = !!term && term.length <= 100 && !lists.some((l) => l.name.toLowerCase() === lower);
  return { shown, canCreate, name: term };
}

// Keep a list of lists up to date from live events (saved = added or changed, deleted = removed), A to Z
export function upsertList<L extends { id: string; name: string }>(lists: L[], list: L) {
  return [...lists.filter((l) => l.id !== list.id), list].sort((a, b) => a.name.localeCompare(b.name));
}
