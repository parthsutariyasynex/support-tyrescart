// Settings → Contact properties: added columns (custom properties), their values, and renamed standard properties.
// Pure checks plus the API (needs the server running: API_URL, default http://localhost:5001)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeValue, propertyKey } from '../src/services/customProperties.js';

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
const REG = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;

describe('custom property keys and values', () => {
  test('the key is made from the name', () => {
    assert.equal(propertyKey('Tyre size (inches)'), 'tyre_size_inches');
    assert.equal(propertyKey('  Vehicle Model  '), 'vehicle_model');
    assert.equal(propertyKey('2nd phone'), 'nd_phone');
    assert.equal(propertyKey('Café'), 'cafe');
    assert.equal(propertyKey('!!!'), '');
  });
  test('values are checked against the type', () => {
    assert.equal(normalizeValue('number', [], ' 1,250.50 '), '1250.5');
    assert.throws(() => normalizeValue('number', [], 'abc'), /Enter a number/);
    assert.equal(normalizeValue('date', [], '2026-02-28'), '2026-02-28');
    assert.throws(() => normalizeValue('date', [], '2026-02-30'), /valid date/);
    assert.equal(normalizeValue('email', [], 'A@Example.com'), 'a@example.com');
    assert.throws(() => normalizeValue('email', [], 'nope'), /valid email/);
    assert.equal(normalizeValue('url', [], 'tyrescart.ae/offers'), 'https://tyrescart.ae/offers');
    assert.throws(() => normalizeValue('url', [], 'javascript:alert(1)'), /valid link/);
    assert.equal(normalizeValue('options', ['Michelin'], 'Michelin'), 'Michelin');
    assert.throws(() => normalizeValue('options', ['Michelin'], 'Pirelli'), /one of the options/);
    assert.equal(normalizeValue('boolean', [], 'true'), 'true');
    assert.throws(() => normalizeValue('boolean', [], 'yes'), /yes or no/);
    assert.equal(normalizeValue('datetime', [], '2026-10-16T14:30'), '2026-10-16T14:30');
    assert.equal(normalizeValue('datetime', [], '2026-10-16 09:05:00'), '2026-10-16T09:05');
    assert.throws(() => normalizeValue('datetime', [], '2026-10-16T25:00'), /date and time/);
    assert.equal(normalizeValue('multiline', [], '  line 1\r\nline 2  '), 'line 1\nline 2');
    assert.throws(() => normalizeValue('multiline', [], 'x'.repeat(2001)), /2000/);
    assert.equal(normalizeValue('text', [], '   '), null);
    assert.throws(() => normalizeValue('text', [], 'x'.repeat(501)), /500/);
  });
});

describe('custom properties over the API', () => {
  test('admins add, rename and remove columns; everyone fills them in; values follow the type', async () => {
    const o = (await gql(REG, { i: { name: 'Owner', email: `e2e-cpt-o-${run}@example.com`, password: 'password123', workspaceName: `cpt-${run}` } })).register;
    const { token: join } = (await gql(`mutation { createJoinLink { token } }`, {}, o.token)).createJoinLink;
    const a = (await gql(REG, { i: { name: 'Agent', email: `e2e-cpt-a-${run}@example.com`, password: 'password123', joinToken: join } })).register;
    const C = `mutation($i: CustomPropertyInput!) { createCustomProperty(input: $i) { id key type options } }`;
    await assert.rejects(gql(C, { i: { name: 'X', type: 'text' } }, a.token), /admins/i);
    const size = (await gql(C, { i: { name: 'Tyre size', type: 'number' } }, o.token)).createCustomProperty;
    const brand = (await gql(C, { i: { name: 'Brand', type: 'options', options: ['Michelin', 'Bridgestone', 'Michelin'] } }, o.token)).createCustomProperty;
    assert.deepEqual([size.key, brand.options], ['tyre_size', ['Michelin', 'Bridgestone']]);
    await assert.rejects(gql(C, { i: { name: 'Tyre  size', type: 'text' } }, o.token), /already exists/);
    await assert.rejects(gql(C, { i: { name: 'Empty', type: 'options', options: [] } }, o.token), /at least one choice/);
    await assert.rejects(gql(C, { i: { name: 'Odd', type: 'colour' } }, o.token), /property type/);

    await gql(`mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`, { i: { waId: '971505558888', name: 'CPT', body: 'hi' } }, o.token);
    const contactId = (await gql(`{ conversations { nodes { contact { id } } } }`, {}, o.token)).conversations.nodes[0].contact.id;
    const S = `mutation($c: ID!, $p: ID!, $v: String) { setContactCustomValue(contactId: $c, propertyId: $p, value: $v) { customValues { propertyId value } } }`;
    await assert.rejects(gql(S, { c: contactId, p: size.id, v: 'big' }, o.token), /number/);
    await gql(S, { c: contactId, p: size.id, v: '17' }, o.token);
    const after = (await gql(S, { c: contactId, p: brand.id, v: 'Michelin' }, o.token)).setContactCustomValue.customValues;
    assert.equal(after.length, 2);

    // the change is in the contact's activity log, with the property's name
    const log = (await gql(`query($c: ID!) { contactActivity(contactId: $c) { type data } }`, { c: contactId }, o.token)).contactActivity;
    assert.ok(log.some((x: { type: string; data: unknown }) => x.type === 'contact_updated' && JSON.stringify(x.data).includes('Tyre size')), JSON.stringify(log));

    // rename keeps the key; removing deletes the values
    const renamed = (await gql(`mutation($id: ID!) { updateCustomProperty(id: $id, input: { name: "Tyre brand" }) { name key } }`, { id: brand.id }, o.token)).updateCustomProperty;
    assert.deepEqual(renamed, { name: 'Tyre brand', key: 'brand' });
    await gql(`mutation($id: ID!) { deleteCustomProperty(id: $id) }`, { id: brand.id }, o.token);
    const left = (await gql(`query($id: ID!) { contact(id: $id) { customValues { propertyId value } } }`, { id: contactId }, o.token)).contact.customValues;
    assert.deepEqual(left, [{ propertyId: size.id, value: '17' }]);

    // standard properties can be renamed (admins); empty name restores it
    await assert.rejects(gql(`mutation { renameStandardProperty(key: "companyName", name: "Garage") { labels { key name } } }`, {}, a.token), /admins/i);
    const v1 = (await gql(`mutation { renameStandardProperty(key: "companyName", name: "Garage name") { labels { key name } } }`, {}, o.token)).renameStandardProperty;
    assert.deepEqual(v1.labels, [{ key: 'companyName', name: 'Garage name' }]);
    assert.deepEqual((await gql(`{ myPropertyView { labels { key name } } }`, {}, a.token)).myPropertyView.labels, [{ key: 'companyName', name: 'Garage name' }]);
    await assert.rejects(gql(`mutation { renameStandardProperty(key: "nope", name: "X") { labels { key } } }`, {}, o.token), /Unknown property/);
    const v2 = (await gql(`mutation { renameStandardProperty(key: "companyName", name: "") { labels { key name } } }`, {}, o.token)).renameStandardProperty;
    assert.deepEqual(v2.labels, []);

    // views accept the custom keys
    const view = (await gql(`mutation { savePropertyView(input: { personal: true, order: ["custom:tyre_size", "email"], hidden: [] }) { order } }`, {}, a.token)).savePropertyView;
    assert.deepEqual(view.order, ['custom:tyre_size', 'email']);
  });
});
