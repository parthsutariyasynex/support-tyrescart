// Location messages: the stored format, customers' locations from the webhook, sending a pin to WhatsApp (mock),
// place search through the server (OpenStreetMap rules: identified, cached, 1 request a second), and live
// location (a private link, positions only from the sharer, stop / expiry, the public page shows nothing else).
// WhatsApp and the map search are replaced by mocks; the API server must be running (API_URL) for sign-ups.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, mock, test } from 'node:test';

const posted: any[] = [];
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    posted.push(j);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: `wamid.loc-${Date.now()}-${Math.random().toString(36).slice(2)}` }] }));
  });
});

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
  if (j.errors) throw Object.assign(new Error(j.errors[0].message), { code: j.errors[0].extensions?.code });
  return j.data;
}

let fmt: typeof import('../src/services/locationFormat.js');
let loc: typeof import('../src/services/location.js');
let geo: typeof import('../src/services/geocoding.js');
let live: typeof import('../src/services/liveLocation.js');
let messages: typeof import('../src/messages.js');
let prisma: typeof import('../src/prisma.js')['prisma'];
let liveApp: ReturnType<typeof createServer>;
let liveUrl = '';
const workspaces: string[] = [];

before(async () => {
  await new Promise<void>((r) => graph.listen(0, '127.0.0.1', r));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`; // read when env.ts loads
  process.env.PUBLIC_APP_URL = 'https://support.example.test';
  fmt = await import('../src/services/locationFormat.js');
  loc = await import('../src/services/location.js');
  geo = await import('../src/services/geocoding.js');
  live = await import('../src/services/liveLocation.js');
  messages = await import('../src/messages.js');
  prisma = (await import('../src/prisma.js')).prisma;
  // The public live page, served in this process (where the live locations are)
  const express = (await import('express')).default;
  const { liveRouter } = await import('../src/routes/live.js');
  const app = express();
  app.use('/live', liveRouter);
  liveApp = createServer(app);
  await new Promise<void>((r) => liveApp.listen(0, '127.0.0.1', r));
  liveUrl = `http://127.0.0.1:${(liveApp.address() as AddressInfo).port}/live`;
});
after(async () => {
  geo?.setGeocoderFetch();
  live?.resetLiveLocations();
  graph.close();
  liveApp?.close();
  if (workspaces.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await prisma?.$disconnect();
});

describe('stored format', () => {
  test('name, address and exact coordinates; read back the same; readable text', () => {
    const body = fmt.locationBody({ latitude: 25.1234567, longitude: 55.2345678, name: 'Al Quoz  Tyre\nCentre', address: 'Street 4a, Al Quoz 3, Dubai' });
    assert.equal(body, '📍 Al Quoz Tyre Centre\nStreet 4a, Al Quoz 3, Dubai\nhttps://maps.google.com/?q=25.123457,55.234568');
    assert.deepEqual(fmt.parseLocationBody(body), { latitude: 25.123457, longitude: 55.234568, name: 'Al Quoz Tyre Centre', address: 'Street 4a, Al Quoz 3, Dubai' });
    assert.equal(fmt.locationBody({ latitude: -33.9, longitude: -70.6 }), 'https://maps.google.com/?q=-33.9,-70.6');
    assert.deepEqual(fmt.parseLocationBody('https://maps.google.com/?q=-33.9,-70.6'), { latitude: -33.9, longitude: -70.6, name: null, address: null });
  });
  test('anything else is not a location', () => {
    for (const body of ['[location]', 'hello', 'https://maps.google.com/?q=95,10', 'https://evil.test/?q=1,2', ''])
      assert.equal(fmt.parseLocationBody(body), null, body);
  });
});

describe("customers' locations from the webhook", () => {
  test('a pin with name and address; without them; with bad coordinates', () => {
    assert.deepEqual(messages.describe({ type: 'location', location: { latitude: 25.2, longitude: 55.27, name: 'Dubai Mall', address: 'Financial Centre Rd' } }), {
      type: 'location',
      body: '📍 Dubai Mall\nFinancial Centre Rd\nhttps://maps.google.com/?q=25.2,55.27',
    });
    assert.deepEqual(messages.describe({ type: 'location', location: { latitude: '25.2', longitude: '55.27' } }), { type: 'location', body: 'https://maps.google.com/?q=25.2,55.27' });
    assert.deepEqual(messages.describe({ type: 'location', location: { latitude: 200, longitude: 1 } }), { type: 'location', body: '[location]' });
    assert.deepEqual(messages.describe({ type: 'location' }), { type: 'location', body: '[location]' });
  });
  test("a live location (which WhatsApp's API doesn't pass on) is marked so the chat can say so", () => {
    assert.deepEqual(messages.describe({ type: 'unsupported', unsupported: { type: 'location' } }), { type: 'location', body: '[live location]' });
    assert.deepEqual(messages.describe({ type: 'unsupported', unsupported: { type: 'poll_creation' } }), { type: 'unsupported', body: '[unsupported]' });
  });
});

describe('place search (OpenStreetMap Nominatim rules)', () => {
  test('identified, cached, spaced 1 per second, short searches refused, the point asked about kept', async () => {
    const calls: { url: string; ua: string; at: number }[] = [];
    geo.setGeocoderFetch((async (url: any, init: any) => {
      calls.push({ url: String(url), ua: init.headers['User-Agent'], at: Date.now() });
      const u = new URL(String(url));
      const body = u.pathname === '/search' ? [{ lat: '25.1972', lon: '55.2744', name: 'Burj Khalifa', display_name: 'Burj Khalifa, Downtown Dubai, Dubai' }, { lat: 'x', lon: '1' }] : { lat: '25.19', lon: '55.27', name: '', display_name: 'Sheikh Zayed Road, Dubai' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch);
    assert.equal(geo.geocoderEnabled(), true);
    const r = await geo.searchPlaces('  burj   khalifa ');
    assert.deepEqual(r, [{ latitude: 25.1972, longitude: 55.2744, name: 'Burj Khalifa', address: 'Burj Khalifa, Downtown Dubai, Dubai' }]);
    assert.match(calls[0].url, /\/search\?format=jsonv2&q=burj\+khalifa&limit=5/);
    assert.match(calls[0].ua, /^support-tyrescart\/1\.0 \(support chat location search/);
    await geo.searchPlaces('Burj Khalifa'); // same search: from the cache
    assert.equal(calls.length, 1);
    const a = await geo.reversePlace(25.190001, 55.270001);
    const b = await geo.reversePlace(25.190031, 55.270041); // ~5 m away: same cached answer, its own point
    assert.equal(calls.length, 2);
    assert.equal(calls[1].at - calls[0].at >= 1000, true, 'at least a second between requests');
    assert.deepEqual([a?.latitude, a?.longitude, b?.latitude, b?.longitude, b?.address], [25.190001, 55.270001, 25.190031, 55.270041, 'Sheikh Zayed Road, Dubai']);
    await assert.rejects(geo.searchPlaces('ab'), /at least 3 characters/);
    await assert.rejects(geo.reversePlace(91, 0), /valid point/);
  });
  test('the service saying "too many requests" or failing becomes a clear message', async () => {
    geo.setGeocoderFetch((async () => new Response('', { status: 429 })) as typeof fetch);
    await assert.rejects(geo.searchPlaces('Dubai Mall'), /busy/);
    geo.setGeocoderFetch((async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    await assert.rejects(geo.searchPlaces('Mall of the Emirates'), /Couldn't reach/);
  });
});

describe('sending and live location (in a chat)', () => {
  let owner: { token: string; user: { id: string }; workspace: { id: string } };
  let agent: { token: string; user: { id: string } };
  let conversationId = '';
  const waId = '971505551234';

  before(async () => {
    const reg = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
    owner = (await gql(reg, { i: { name: 'Loc Owner', email: `e2e-loc-o-${run}@example.com`, password: 'password123', workspaceName: `Loc Co ${run}` } })).register;
    workspaces.push(owner.workspace.id);
    const { token: join } = (await gql(`mutation { createJoinLink { token } }`, {}, owner.token)).createJoinLink;
    agent = (await gql(reg, { i: { name: 'Loc Agent', email: `e2e-loc-a-${run}@example.com`, password: 'password123', joinToken: join } })).register;
    await prisma.whatsAppAccount.create({ data: { workspaceId: owner.workspace.id, wabaId: `waba-loc-${run}`, phoneNumberId: `pn-loc-${run}`, displayPhone: '+1 555 000 5555', accessToken: 'mock-token' } });
    await messages.saveIncoming(owner.workspace.id, { waId, name: 'Rami', type: 'text', body: 'Where is your shop?', waMessageId: `wamid.loc-in-${run}` });
    conversationId = (await prisma.conversation.findFirstOrThrow({ where: { workspaceId: owner.workspace.id } })).id;
  });

  test("a pin goes to WhatsApp as Meta's location message and is saved as a location", async () => {
    const auth = { userId: owner.user.id, workspaceId: owner.workspace.id };
    const m = await loc.sendLocationMessage(auth.workspaceId, conversationId, { latitude: 25.1234567, longitude: 55.2345678, name: 'TyresCart Al Quoz', address: 'Al Quoz 3, Dubai' }, auth.userId);
    assert.deepEqual(posted.at(-1), {
      messaging_product: 'whatsapp',
      to: waId,
      type: 'location',
      location: { latitude: 25.123457, longitude: 55.234568, name: 'TyresCart Al Quoz', address: 'Al Quoz 3, Dubai' },
    });
    assert.equal(m.type, 'location');
    assert.equal(m.status, 'sent');
    assert.equal(m.body, '📍 TyresCart Al Quoz\nAl Quoz 3, Dubai\nhttps://maps.google.com/?q=25.123457,55.234568');
  });
  test('bad coordinates are refused; a closed 24-hour window too', async () => {
    await assert.rejects(loc.sendLocationMessage(owner.workspace.id, conversationId, { latitude: 91, longitude: 0 }, owner.user.id));
    await prisma.conversation.update({ where: { id: conversationId }, data: { lastInboundAt: new Date(Date.now() - 25 * 3_600_000) } });
    await assert.rejects(loc.sendLocationMessage(owner.workspace.id, conversationId, { latitude: 25, longitude: 55 }, owner.user.id), /24-hour window closed/);
    await prisma.conversation.update({ where: { id: conversationId }, data: { lastInboundAt: new Date() } });
  });
  test('the GraphQL API has it (search availability, search input checked)', async () => {
    assert.equal(typeof (await gql('query { locationSearchEnabled }', {}, owner.token)).locationSearchEnabled, 'boolean');
    await assert.rejects(gql('query { searchPlaces(query: "ab") { address } }', {}, owner.token), /at least 3 characters/);
  });

  test('live location: a private link is sent; only the sharer moves it; the page shows the position only while sharing', async () => {
    const auth = { userId: owner.user.id, workspaceId: owner.workspace.id };
    await assert.rejects(live.startLiveLocation(auth, { conversationId, minutes: 30, latitude: 25, longitude: 55 }), /15 minutes, 1 hour or 8 hours/);
    const { message, live: info } = await live.startLiveLocation(auth, { conversationId, minutes: 15, latitude: 25.2, longitude: 55.27, accuracy: 12.4 });
    const text = posted.at(-1);
    assert.equal(text.type, 'text');
    assert.match(text.text.body, /^📍 Live location: Loc Owner is sharing their location with you until \d{2}:\d{2} .+\.\nFollow it on the map: https:\/\/support\.example\.test\/live\/[A-Za-z0-9_-]{24}$/);
    assert.equal(message.type, 'live_location');
    assert.equal(info.active, true);
    assert.deepEqual([info.position?.latitude, info.position?.longitude, info.position?.accuracy], [25.2, 55.27, 12]);
    const token = live.tokenForMessage(message.id)!;

    // The public page and its position
    const page = await fetch(`${liveUrl}/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'; script-src 'nonce-/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await page.text(), /Rami|971505551234|Where is your shop/);
    let pub: any = await (await fetch(`${liveUrl}/${token}/position`)).json();
    assert.deepEqual([pub.active, pub.sharerName, pub.position.latitude], [true, 'Loc Owner', 25.2]);
    assert.deepEqual(Object.keys(pub).sort(), ['active', 'endedAt', 'position', 'sharerName', 'until']);
    assert.equal((await fetch(`${liveUrl}/AAAAAAAAAAAAAAAAAAAAAAAA/position`)).status, 404);

    // Moving: the sharer only
    const agentAuth = { userId: agent.user.id, workspaceId: owner.workspace.id };
    assert.throws(() => live.updateLiveLocation(agentAuth, message.id, { latitude: 1, longitude: 1 }), /Only the person sharing/);
    assert.throws(() => live.updateLiveLocation({ ...auth, workspaceId: 'other-workspace' }, message.id, { latitude: 1, longitude: 1 }), /not found/);
    live.updateLiveLocation(auth, message.id, { latitude: 25.21, longitude: 55.28, accuracy: 8 });
    pub = await (await fetch(`${liveUrl}/${token}/position`)).json();
    assert.equal(pub.position.latitude, 25.21);

    // Stopping: not an agent who isn't sharing it; the sharer can
    await assert.rejects(live.stopLiveLocation(agentAuth, message.id), /Only the person sharing/);
    const stopped = await live.stopLiveLocation(auth, message.id);
    assert.equal(stopped.active, false);
    assert.throws(() => live.updateLiveLocation(auth, message.id, { latitude: 1, longitude: 1 }), /has ended/);
    pub = await (await fetch(`${liveUrl}/${token}/position`)).json();
    assert.deepEqual([pub.active, pub.position], [false, null]);
    assert.equal(live.myActiveLiveLocations(auth).length, 0);
  });

  test('live location ends on time, and is forgotten a day later', async () => {
    const auth = { userId: owner.user.id, workspaceId: owner.workspace.id };
    const { message } = await live.startLiveLocation(auth, { conversationId, minutes: 15, latitude: 25.2, longitude: 55.27 });
    const token = live.tokenForMessage(message.id)!;
    assert.equal(live.myActiveLiveLocations(auth).length, 1);
    assert.equal(live.publicLiveLocation(token)?.active, true);
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 16 * 60_000 });
    try {
      assert.deepEqual([live.publicLiveLocation(token)?.active, live.publicLiveLocation(token)?.position], [false, null]);
      assert.equal(live.getLiveLocation(auth, message.id)?.active, false);
      live.sweepLiveLocations(Date.now() + 25 * 60 * 60_000);
      assert.equal(live.publicLiveLocation(token), null);
    } finally {
      mock.timers.reset();
    }
  });

  test('an admin can stop a teammate’s live location; starting again in the same chat ends the earlier one', async () => {
    await prisma.conversation.update({ where: { id: conversationId }, data: { assignedToId: (await prisma.member.findFirstOrThrow({ where: { userId: agent.user.id, workspaceId: owner.workspace.id } })).id } });
    const agentAuth = { userId: agent.user.id, workspaceId: owner.workspace.id };
    const first = await live.startLiveLocation(agentAuth, { conversationId, minutes: 60, latitude: 25, longitude: 55 });
    const second = await live.startLiveLocation(agentAuth, { conversationId, minutes: 480, latitude: 25, longitude: 55 });
    assert.equal(live.getLiveLocation(agentAuth, first.message.id)?.active, false);
    assert.equal(live.getLiveLocation(agentAuth, second.message.id)?.active, true);
    const stopped = await live.stopLiveLocation({ userId: owner.user.id, workspaceId: owner.workspace.id }, second.message.id);
    assert.equal(stopped.active, false);
  });
});
