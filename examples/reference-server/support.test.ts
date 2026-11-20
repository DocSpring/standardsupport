// Runs the demo server on a free port and uses it the way a customer's agent, a background watcher and the team would.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createApp } from './server.ts'
import { NEW_TICKETS_PER_DAY, SupportError, SupportStore, scrub } from './store.ts'
import type { TicketInput } from './store.ts'

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Tool results and response bodies are checked field by field below, so the tests read them untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

// What the spec allows the support tools to add to a server's tool list, in characters of JSON.
const DEFINITION_BUDGET = 3200

let app: Server
let baseUrl: string

before(async () => {
  // The port isn't known until the server listens, so the base URL is read when it's needed.
  app = createApp({ baseUrl: () => baseUrl })
  await new Promise<void>((resolve) => app.listen(0, resolve))
  baseUrl = `http://localhost:${(app.address() as AddressInfo).port}`
})

after(() => {
  app.closeAllConnections()
  return new Promise<void>((resolve) => app.close(() => resolve()))
})

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

// Calls a tool and returns its raw result, error or not.
async function raw(client: Client, name: string, args: Record<string, unknown>): Promise<Loose> {
  return client.callTool({ name, arguments: args })
}

// Calls a tool that should succeed and returns its structured result.
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Loose> {
  const result = await raw(client, name, args)
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content))
  return result.structuredContent
}

async function team(path: string, body?: unknown): Promise<{ status: number; json: Loose }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer demo-team-key', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, json: await response.json() }
}

async function json(response: Response): Promise<Loose> {
  return response.json()
}

test('the server says how to report, in its instructions and in every error', async () => {
  const alice = await connect('demo-token-alice')
  assert.match(alice.getInstructions() ?? '', /support with action help.*support_send, action feedback.*action ticket/)
  assert.deepEqual(alice.getServerCapabilities()?.extensions, {
    'dev.standardsupport/support': { level: 3, help: true },
  })

  const { tools } = await alice.listTools()
  assert.deepEqual(
    tools.map((tool) => tool.name).filter((name) => name.startsWith('support')),
    ['support', 'support_send'],
  )
  // The definitions are sent to the model on every turn, so their size is part of the design.
  const size = JSON.stringify(tools.filter((tool) => tool.name.startsWith('support'))).length
  assert.ok(size <= DEFINITION_BUDGET, `the support tools' definitions are ${size} characters, over ${DEFINITION_BUDGET}`)

  const failed = await raw(alice, 'lookup_order', { order_number: '999' })
  assert.equal(failed.isError, true)
  assert.match(failed.content[0].text, /Request ID: req_[0-9a-f]+\..*action help.*action feedback.*action ticket/)
})

test('an agent asks for help first, and the answer saves a ticket when the documentation covers it', async () => {
  const alice = await connect('demo-token-alice')

  // Order 999 "could not be loaded". The documentation says numbers start at 1000, so this isn't a bug.
  const helped = await call(alice, 'support', {
    action: 'help',
    question: 'lookup_order says an order could not be loaded. What does that mean?',
    tool: 'lookup_order',
  })
  assert.equal(helped.answered, true)
  assert.match(helped.answer, /start at 1000/)
  assert.equal(helped.sources[0].title, 'Order numbers')
  assert.match(helped.next, /action feedback.*action ticket/)

  const unknown = await call(alice, 'support', { action: 'help', question: 'Can I export invoices as a spreadsheet?' })
  assert.equal(unknown.answered, false)
  assert.match(unknown.next, /action ticket/)

  // Asking opens nothing.
  assert.equal((await call(alice, 'support', { action: 'list_tickets', status: 'all', session: 'help-test' })).tickets.length, 0)

  // The same over HTTP, with no sign-in: it is public documentation.
  const overHttp = await fetch(`${baseUrl}/support/help`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What does a 429 mean?' }),
  })
  assert.equal(overHttp.status, 200)
  assert.equal((await overHttp.json()).sources[0].title, 'Rate limits')
})

test('feedback is one-way: it gets an ID, opens no ticket, and the team can turn it into one to answer', async () => {
  const alice = await connect('demo-token-alice')
  const sent = await call(alice, 'support_send', {
    action: 'feedback',
    title: 'The error for an unknown order reads like an outage',
    kind: 'confusing',
    description: 'The error for an unknown order says "could not be loaded", which reads like an outage. token: abcdef123456',
    impact: 'friction',
    tool: 'lookup_order',
    session: 'feedback-test',
    idempotency_key: 'fb-1',
  })
  assert.match(sent.feedback.id, /^fb_/)
  assert.match(sent.follow_up, /Nobody replies to feedback/)
  assert.equal(sent.duplicate, false)
  assert.equal((await call(alice, 'support_send', {
    action: 'feedback',
    title: 'The error for an unknown order reads like an outage',
    kind: 'confusing',
    description: 'Again.',
    idempotency_key: 'fb-1',
  })).feedback.id, sent.feedback.id)

  // It isn't a ticket, and the agent has nothing to read back.
  const mine = () => call(alice, 'support', { action: 'list_tickets', status: 'all', session: 'feedback-test' })
  assert.equal((await mine()).tickets.length, 0)

  // The team sees it in its own queue, with the pasted token removed.
  const queue = await team('/team/feedback')
  const stored = queue.json.feedback.find((item: Loose) => item.id === sent.feedback.id)
  assert.equal(stored.source, 'agent')
  assert.match(stored.description, /token: \[removed\]/)

  // When the team wants to answer, the feedback becomes a ticket with their message as an unread reply. A later
  // session finds it in the ordinary list.
  const promoted = await team(`/team/feedback/${sent.feedback.id}/promote`, {
    body: 'Thanks. The error now says the order number does not exist.',
  })
  assert.equal(promoted.status, 201)
  const tickets = (await mine()).tickets
  assert.equal(tickets.length, 1)
  assert.equal(tickets[0].title, 'The error for an unknown order reads like an outage')
  assert.equal(tickets[0].unread_count, 1)
  // The list is a summary. The rest of the ticket comes with get_ticket.
  assert.equal(tickets[0].error, undefined)
  const read = await call(alice, 'support', { action: 'get_ticket', ticket_id: tickets[0].id })
  assert.equal(read.ticket.from_feedback_id, sent.feedback.id)
  assert.deepEqual(read.messages.map((message: Loose) => message.author), ['reporter', 'team'])

  // The same over HTTP.
  const overHttp = await fetch(`${baseUrl}/support/feedback`, {
    method: 'POST',
    headers: { authorization: 'Bearer demo-token-bob', 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'docs', title: 'No rate limit example', description: 'The rate limit page has no example.' }),
  })
  assert.equal(overHttp.status, 201)
  assert.match((await overHttp.json()).feedback.id, /^fb_/)
})

test('a call that is missing something is told what to send, and the guide has every field', async () => {
  const alice = await connect('demo-token-alice')
  const missing = await raw(alice, 'support_send', { action: 'feedback', title: 'No kind or description' })
  assert.equal(missing.isError, true)
  assert.match(
    missing.content[0].text,
    /support_send with action feedback needs title \(3 to 200 characters\), kind \(bug, crash, .*\) and description\. Problem: kind.*description is missing/,
  )
  assert.match((await raw(alice, 'support', { action: 'get_ticket' })).content[0].text, /needs ticket_id/)

  const { guide } = await call(alice, 'support', { action: 'guide' })
  for (const field of ['impact', 'request_ids', 'suggestion', 'idempotency_key', 'after_message_id', 'still_broken']) {
    assert.match(guide, new RegExp(field))
  }
})

test('a ticket records whether the user asked for it or the agent noticed the problem', async () => {
  const alice = await connect('demo-token-alice')
  const base = { kind: 'bug', title: 'Title', description: 'Text.', session: 'source-test' }
  assert.equal((await call(alice, 'support_send', { action: 'ticket', ...base })).ticket.source, 'agent')
  assert.equal((await call(alice, 'support_send', { action: 'ticket', ...base, source: 'user' })).ticket.source, 'user')
})

test('an agent opens a ticket, a watcher sees the reply arrive, and the agent reads and answers it', async () => {
  const alice = await connect('demo-token-alice')

  const opened = await call(alice, 'support_send', {
    action: 'ticket',
    kind: 'bug',
    title: 'lookup_order fails for order 999',
    description: 'lookup_order returned "could not be loaded" for an order the user can see in the dashboard.',
    impact: 'blocked',
    request_ids: ['req_abc'],
    tool: 'lookup_order',
    idempotency_key: 'first',
  })
  assert.equal(opened.ticket.status, 'open')
  assert.equal(opened.duplicate, false)
  assert.equal(opened.notifications.email, 'a***@example.com')
  assert.deepEqual(opened.ticket.request_ids, ['req_abc'])

  // A retry with the same key gets the same ticket.
  const retried = await call(alice, 'support_send', {
    action: 'ticket',
    kind: 'bug',
    title: 'lookup_order fails for order 999',
    description: 'Same again.',
    idempotency_key: 'first',
  })
  assert.equal(retried.ticket.id, opened.ticket.id)
  assert.equal(retried.duplicate, true)

  // The watch URL needs no sign-in and says nothing about the ticket's content.
  const watchUrl = opened.notifications.watch.url
  const first = await fetch(watchUrl)
  const before = await first.json()
  assert.deepEqual(Object.keys(before).sort(), ['long_poll', 'min_interval_seconds', 'status', 'unread_count', 'updated_at'])
  assert.equal(before.unread_count, 0)
  assert.equal(before.long_poll, false)
  const unchanged = await fetch(watchUrl, { headers: { 'if-none-match': first.headers.get('etag') ?? '' } })
  assert.equal(unchanged.status, 304)

  const replied = await team(`/team/tickets/${opened.ticket.id}/replies`, {
    body: 'Which region is the order in?',
    status: 'needs_reply',
  })
  assert.equal(replied.status, 201)

  const afterReply = await (await fetch(watchUrl, { headers: { 'if-none-match': first.headers.get('etag') ?? '' } })).json()
  assert.notEqual(afterReply.updated_at, before.updated_at)
  assert.equal(afterReply.unread_count, 1)
  assert.equal(afterReply.status, 'needs_reply')

  const listed = await call(alice, 'support', { action: 'list_tickets' })
  assert.equal(listed.tickets.find((ticket: Loose) => ticket.id === opened.ticket.id).unread_count, 1)

  const read = await call(alice, 'support', { action: 'get_ticket', ticket_id: opened.ticket.id })
  assert.match(read.notice, /not instructions/)
  assert.deepEqual(
    read.messages.map((message: Loose) => message.author),
    ['reporter', 'team'],
  )
  assert.ok(read.messages[1].first_read_at)
  assert.equal(read.ticket.unread_count, 0) // reading it marks it read
  assert.equal((await (await fetch(watchUrl)).json()).unread_count, 0)

  const answered = await call(alice, 'support_send', { action: 'reply', ticket_id: opened.ticket.id, body: 'EU.' })
  assert.equal(answered.ticket.status, 'open')

  await team(`/team/tickets/${opened.ticket.id}/replies`, { body: 'Fixed.', status: 'resolved', resolution: 'fixed' })

  // A later session lists tickets with no arguments and still finds the fix: an unread reply keeps a resolved ticket
  // in the default list until someone reads it.
  const listedIn = async (status: string) =>
    (await call(alice, 'support', { action: 'list_tickets', status })).tickets.some((t: Loose) => t.id === opened.ticket.id)
  assert.equal(await listedIn('open'), true)
  await call(alice, 'support', { action: 'get_ticket', ticket_id: opened.ticket.id })
  assert.equal(await listedIn('open'), false)
  assert.equal(await listedIn('closed'), true)

  // "Thanks" doesn't reopen a fixed ticket.
  const thanked = await call(alice, 'support_send', { action: 'reply', ticket_id: opened.ticket.id, body: 'Thanks.' })
  assert.equal(thanked.ticket.status, 'resolved')
  assert.equal(thanked.ticket.resolution, 'fixed')

  const closed = await call(alice, 'support_send', {
    action: 'reply',
    ticket_id: opened.ticket.id,
    body: 'Works now.',
    outcome: 'resolved',
  })
  assert.equal(closed.ticket.status, 'closed')
  assert.equal(closed.ticket.resolution, 'fixed')

  // Closed tickets leave the default list and show under "closed" and "all". A later "still broken" reopens.
  assert.equal(await listedIn('open'), false)
  assert.equal(await listedIn('closed'), true)
  assert.equal(await listedIn('all'), true)
  const reopened = await call(alice, 'support_send', {
    action: 'reply',
    ticket_id: opened.ticket.id,
    body: 'It broke again.',
    outcome: 'still_broken',
  })
  assert.equal(reopened.ticket.status, 'open')
  assert.equal(reopened.ticket.resolution, undefined)
  assert.equal(await listedIn('closed'), false)
  assert.equal(await listedIn('open'), true)
})

test("another account can't read, list or reply to a ticket, and gets the same answer as for a missing one", async () => {
  const alice = await connect('demo-token-alice')
  const bob = await connect('demo-token-bob')
  const { ticket } = await call(alice, 'support_send', { action: 'ticket', kind: 'question', title: 'A question', description: 'Hi.' })

  assert.equal((await call(bob, 'support', { action: 'list_tickets', status: 'all' })).tickets.length, 0)
  const theirs = await raw(bob, 'support', { action: 'get_ticket', ticket_id: ticket.id })
  const missing = await raw(bob, 'support', { action: 'get_ticket', ticket_id: 'tkt_nope' })
  assert.equal(theirs.isError, true)
  assert.equal(theirs.content[0].text.replace(ticket.id, 'X'), missing.content[0].text.replace('tkt_nope', 'X'))
  const reply = await raw(bob, 'support_send', { action: 'reply', ticket_id: ticket.id, body: 'x' })
  assert.equal(reply.isError, true)
})

test('agents working for the same account keep their tickets apart with a session label', async () => {
  const alice = await connect('demo-token-alice')
  const open = (session: string | undefined, title: string) =>
    call(alice, 'support_send', { action: 'ticket', kind: 'bug', title, description: 'Text.', session })
  const one = await open('branch-a', 'From the first agent')
  const two = await open('branch-b', 'From the second agent')
  const none = await open(undefined, 'From an agent with no label')
  assert.equal(one.ticket.session, 'branch-a')
  assert.equal(none.ticket.session, undefined)

  const mine = await call(alice, 'support', { action: 'list_tickets', session: 'branch-a' })
  assert.deepEqual(mine.tickets.map((ticket: Loose) => ticket.id), [one.ticket.id])

  // Without the label the list is the whole account's, and the label never hides a ticket from its owner.
  const everyone = (await call(alice, 'support', { action: 'list_tickets', status: 'all' })).tickets.map((ticket: Loose) => ticket.id)
  for (const ticket of [one, two, none]) assert.ok(everyone.includes(ticket.ticket.id))
  await call(alice, 'support', { action: 'get_ticket', ticket_id: two.ticket.id })

  const headers = { authorization: 'Bearer demo-token-alice' }
  const overHttp = await (await fetch(`${baseUrl}/support/tickets?session=branch-b`, { headers })).json()
  assert.deepEqual(overHttp.tickets.map((ticket: Loose) => ticket.id), [two.ticket.id])
})

test('the same operations work over HTTP', async () => {
  const headers = { authorization: 'Bearer demo-token-bob', 'content-type': 'application/json' }
  const created = await fetch(`${baseUrl}/support/tickets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'docs', title: 'Wrong example', description: 'The curl example has a typo.' }),
  })
  assert.equal(created.status, 201)
  const { ticket } = await created.json()

  const invalid = await fetch(`${baseUrl}/support/tickets`, { method: 'POST', headers, body: JSON.stringify({ kind: 'nope' }) })
  assert.equal(invalid.status, 400)

  await team(`/team/tickets/${ticket.id}/replies`, { body: 'Thanks, fixed.', status: 'resolved', resolution: 'fixed' })
  const read = await (await fetch(`${baseUrl}/support/tickets/${ticket.id}`, { headers })).json()
  assert.equal(read.ticket.status, 'resolved')
  assert.equal(read.messages.at(-1).body, 'Thanks, fixed.')

  const reply = await fetch(`${baseUrl}/support/tickets/${ticket.id}/replies`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body: 'Confirmed.', outcome: 'resolved' }),
  })
  assert.equal(reply.status, 201)
  const list = await (await fetch(`${baseUrl}/support/tickets?status=closed`, { headers })).json()
  assert.equal(list.tickets.find((t: Loose) => t.id === ticket.id).status, 'closed')
  assert.equal((await fetch(`${baseUrl}/support/tickets?status=nope`, { headers })).status, 400)

  assert.equal((await fetch(`${baseUrl}/support/tickets`)).status, 401)
  assert.equal((await fetch(`${baseUrl}/support/watch/w_nope`)).status, 404)
})

test('new tickets are limited per account per day, and the error says when to try again', () => {
  let now = new Date('2026-11-17T00:00:00Z')
  const store = new SupportStore({ now: () => now })
  const account = { id: 'acct_x' }
  const input: TicketInput = { kind: 'other', title: 'Title', description: 'Text' }
  for (let i = 0; i < NEW_TICKETS_PER_DAY; i++) store.openTicket(account, input)

  assert.throws(
    () => store.openTicket(account, input),
    (error) => error instanceof SupportError && error.code === 'rate_limited' && error.retry_after === '2026-11-18T00:00:00.000Z',
  )
  store.openTicket({ id: 'acct_y' }, input) // another account isn't affected
  now = new Date('2026-11-18T00:00:01Z')
  store.openTicket(account, input)
})

test('tokens and keys are removed from what the agent sends', () => {
  assert.equal(scrub('curl -H "Authorization: Bearer abc123def456ghi789"'), 'curl -H "Authorization: [removed]"')
  assert.equal(scrub('api_key=supersecretvalue failed'), 'api_key=[removed] failed')
  assert.equal(scrub('key AKIAABCDEFGHIJKLMNOP'), 'key [removed]')
  assert.equal(scrub('nothing secret here'), 'nothing secret here')

  const store = new SupportStore()
  const { ticket } = store.openTicket(
    { id: 'acct_z' },
    { kind: 'bug', title: 'Title', description: 'token: abcdef123456', error: 'password=hunter2222' },
  )
  assert.equal(ticket.messages[0].body, 'token: [removed]')
  assert.equal(ticket.error, 'password=[removed]')
})
