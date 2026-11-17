// A small product with Standard Support added: an MCP server at /mcp with one tool of its own (lookup_order) and the
// four support_* tools, the same support operations as REST endpoints, the watch URL, and a team endpoint to reply.
//
//   node server.js
//
// Sign-in here is a fixed table of demo tokens. Replace `accountFromToken` with your own.

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

import {
  IMPACTS,
  KINDS,
  LIST_STATUSES,
  RESOLUTIONS,
  STATUSES,
  SupportError,
  SupportStore,
  maskEmail,
  presentMessage,
  presentTicket,
} from './store.js'
import { answerFromDocs } from './help.js'
import { errorNudge, getHelp, registerSupportTools, supportInstructions } from './tools.js'

const PRODUCT = 'Acme Orders'

const DEMO_ACCOUNTS = {
  'demo-token-alice': { id: 'acct_alice', email: 'alice@example.com' },
  'demo-token-bob': { id: 'acct_bob', email: 'bob@example.com' },
}
const DEMO_TEAM_KEY = 'demo-team-key'

function accountFromToken(token) {
  return DEMO_ACCOUNTS[token]
}

function bearer(request) {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
}

// A new MCP server for each request: no sessions, so any instance can answer any request.
function buildMcpServer(store, baseUrl) {
  const server = new McpServer(
    { name: 'acme-orders', version: '0.1.0' },
    {
      instructions: `Look up Acme orders. ${supportInstructions(PRODUCT, { help: true })}`,
      // Tells clients and directories that this server takes support tickets, and how much of the design it has.
      capabilities: { extensions: { 'dev.standardsupport/support': { level: 3, help: true } } },
    },
  )

  // The product's own tool. Its errors carry a request ID and say where to take the problem.
  server.registerTool(
    'lookup_order',
    {
      title: 'Look up an order',
      description: 'Returns the status of an Acme order by its number.',
      inputSchema: { order_number: z.string().max(40) },
      annotations: { readOnlyHint: true },
    },
    async ({ order_number }) => {
      const requestId = `req_${randomBytes(8).toString('hex')}`
      // Only order 1001 loads. 999 isn't a real number (the documentation says so); 1002 is a fault on Acme's side.
      if (order_number !== '1001') {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Order ${order_number} could not be loaded. ${errorNudge(PRODUCT, requestId, { help: true })}`,
            },
          ],
        }
      }
      return { content: [{ type: 'text', text: 'Order 1001: shipped.' }] }
    },
  )

  registerSupportTools(server, store, {
    product: PRODUCT,
    baseUrl,
    account: (extra) => extra.authInfo?.extra?.account,
    // clientId is the verified OAuth client. A client's own name and version are self-reported.
    context: (extra) => ({ oauth_client_id: extra.authInfo?.clientId, server_version: '0.1.0' }),
    help: answerFromDocs,
  })
  return server
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new SupportError('too_large', 'The request body is too large.')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SupportError('invalid', 'The request body is not valid JSON.')
  }
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

const STATUS_BY_CODE = { not_found: 404, rate_limited: 429, invalid: 400, too_large: 413 }

// baseUrl: where the server is reached from outside, as a string or a function that returns one.
export function createApp({ store = new SupportStore(), baseUrl }) {
  const base = () => (typeof baseUrl === 'function' ? baseUrl() : baseUrl)
  const present = (ticket) => presentTicket(ticket, { baseUrl: base() })

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, base())
      const path = url.pathname
      // The watch URL: no sign-in, only the unguessable token in the path.
      const watch = path.match(/^\/support\/watch\/([A-Za-z0-9_]+)$/)
      if (watch && request.method === 'GET') {
        const { body, etag } = store.watch(watch[1])
        if (request.headers['if-none-match'] === etag) return send(response, 304, undefined, { etag })
        return send(response, 200, body, { etag, 'cache-control': 'no-store' })
      }

      // The team's side. In a real product this is your admin page, your helpdesk or your own agents.
      if (path.startsWith('/team/')) {
        if (bearer(request) !== DEMO_TEAM_KEY) return send(response, 401, { error: 'Not signed in.' })
        if (path === '/team/feedback' && request.method === 'GET') {
          return send(response, 200, { feedback: store.teamFeedback() })
        }
        // Turns a piece of feedback into a ticket, which is how the team answers one.
        const promote = path.match(/^\/team\/feedback\/([A-Za-z0-9_]+)\/promote$/)
        if (promote && request.method === 'POST') {
          const input = await readJson(request)
          if (typeof input.title !== 'string' || input.title.length < 3 || input.title.length > 200) {
            throw new SupportError('invalid', 'title must be 3 to 200 characters.')
          }
          if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 4000)) {
            throw new SupportError('invalid', 'body must be at most 4000 characters.')
          }
          return send(response, 201, { ticket: present(store.promoteFeedback(promote[1], input).ticket) })
        }
        if (path === '/team/tickets' && request.method === 'GET') return send(response, 200, { tickets: store.teamList() })
        const reply = path.match(/^\/team\/tickets\/([A-Za-z0-9_]+)\/replies$/)
        if (reply && request.method === 'POST') {
          const input = await readJson(request)
          if (typeof input.body !== 'string' || input.body.length < 1 || input.body.length > 4000) {
            throw new SupportError('invalid', 'body must be 1 to 4000 characters.')
          }
          if (input.status !== undefined && !STATUSES.includes(input.status)) {
            throw new SupportError('invalid', `status must be one of: ${STATUSES.join(', ')}.`)
          }
          if (input.resolution !== undefined && !RESOLUTIONS.includes(input.resolution)) {
            throw new SupportError('invalid', `resolution must be one of: ${RESOLUTIONS.join(', ')}.`)
          }
          const { ticket, message } = store.teamReply(reply[1], input)
          return send(response, 201, { ticket: present(ticket), message: presentMessage(message) })
        }
        return send(response, 404, { error: 'Not found.' })
      }

      // Help answers from public documentation, so it needs no sign-in. Rate limit it by address in a real product.
      if (path === '/support/help' && request.method === 'POST') {
        const input = await readJson(request)
        if (typeof input.question !== 'string' || input.question.length < 3 || input.question.length > 2000) {
          throw new SupportError('invalid', 'question must be 3 to 2000 characters.')
        }
        return send(response, 200, await getHelp(answerFromDocs, input))
      }

      const account = accountFromToken(bearer(request))
      if (!account) return send(response, 401, { error: 'Not signed in.' })

      if (path === '/mcp') {
        if (request.method !== 'POST') return send(response, 405, { error: 'Use POST.' }, { allow: 'POST' })
        const body = await readJson(request)
        // The SDK hands this to each tool as extra.authInfo.
        request.auth = { token: 'redacted', clientId: 'demo-client', scopes: [], extra: { account } }
        const server = buildMcpServer(store, base())
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        response.on('close', () => {
          transport.close()
          server.close()
        })
        await server.connect(transport)
        return await transport.handleRequest(request, response, body)
      }

      // The same four operations over HTTP, for agents that use the API, an SDK or a CLI and never load the MCP server.
      if (path === '/support/feedback' && request.method === 'POST') {
        const { feedback, duplicate } = store.sendFeedback(account, validateReport(await readJson(request)))
        return send(response, duplicate ? 200 : 201, {
          feedback: { id: feedback.id, received_at: feedback.received_at },
          duplicate,
        })
      }
      if (path === '/support/tickets' && request.method === 'POST') {
        const { ticket, duplicate } = store.openTicket(account, validateNewTicket(await readJson(request)))
        const presented = present(ticket)
        return send(response, duplicate ? 200 : 201, {
          ticket: presented,
          notifications: { email: maskEmail(account.email), watch: { url: presented.watch_url, min_interval_seconds: 60 } },
          duplicate,
        })
      }
      if (path === '/support/tickets' && request.method === 'GET') {
        const status = url.searchParams.get('status') ?? 'open'
        if (!LIST_STATUSES.includes(status)) {
          throw new SupportError('invalid', `status must be one of: ${LIST_STATUSES.join(', ')}.`)
        }
        const { tickets, next_cursor } = store.listTickets(account, {
          status,
          session: url.searchParams.get('session') ?? undefined,
          updated_since: url.searchParams.get('updated_since') ?? undefined,
          limit: Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20)),
          cursor: url.searchParams.get('cursor') ?? undefined,
        })
        return send(response, 200, { tickets: tickets.map(present), next_cursor })
      }
      const one = path.match(/^\/support\/tickets\/([A-Za-z0-9_]+)$/)
      if (one && request.method === 'GET') {
        const { ticket, messages } = store.getTicket(account, one[1], {
          after_message_id: url.searchParams.get('after_message_id') ?? undefined,
        })
        return send(response, 200, { ticket: present(ticket), messages: messages.map(presentMessage) })
      }
      const replies = path.match(/^\/support\/tickets\/([A-Za-z0-9_]+)\/replies$/)
      if (replies && request.method === 'POST') {
        const input = await readJson(request)
        if (typeof input.body !== 'string' || input.body.length < 1 || input.body.length > 4000) {
          throw new SupportError('invalid', 'body must be 1 to 4000 characters.')
        }
        if (input.outcome !== undefined && !['resolved', 'still_broken'].includes(input.outcome)) {
          throw new SupportError('invalid', 'outcome must be resolved or still_broken.')
        }
        const { ticket, message } = store.reply(account, replies[1], input)
        return send(response, 201, { ticket: present(ticket), message: presentMessage(message) })
      }

      return send(response, 404, { error: 'Not found.' })
    } catch (error) {
      if (!(error instanceof SupportError)) {
        console.error(error)
        if (!response.headersSent) send(response, 500, { error: 'Something went wrong.' })
        return
      }
      const headers = error.retry_after ? { 'retry-after': error.retry_after } : {}
      send(response, STATUS_BY_CODE[error.code] ?? 400, { error: error.message, retry_after: error.retry_after }, headers)
    }
  })
}

// The MCP tools get this checking from their zod schemas. The REST endpoints do the minimum by hand: use your own
// API's validation in a real product.
function validateReport(input) {
  const text = (name, min, max, required) => {
    const value = input[name]
    if (value === undefined && !required) return
    if (typeof value !== 'string' || value.length < min || value.length > max) {
      throw new SupportError('invalid', `${name} must be ${min} to ${max} characters.`)
    }
  }
  if (!KINDS.includes(input.kind)) throw new SupportError('invalid', `kind must be one of: ${KINDS.join(', ')}.`)
  if (input.impact !== undefined && !IMPACTS.includes(input.impact)) {
    throw new SupportError('invalid', `impact must be one of: ${IMPACTS.join(', ')}.`)
  }
  if (input.source !== undefined && !['agent', 'user'].includes(input.source)) {
    throw new SupportError('invalid', 'source must be agent or user.')
  }
  text('description', 1, 4000, true)
  text('task', 0, 200)
  text('tool', 0, 100)
  text('error', 0, 4000)
  text('suggestion', 0, 2000)
  text('idempotency_key', 1, 64)
  text('session', 1, 100)
  if (input.request_ids !== undefined) {
    const ids = input.request_ids
    if (!Array.isArray(ids) || ids.length > 10 || ids.some((value) => typeof value !== 'string' || value.length > 200)) {
      throw new SupportError('invalid', 'request_ids must be up to 10 strings.')
    }
  }
  return input
}

function validateNewTicket(input) {
  validateReport(input)
  if (typeof input.title !== 'string' || input.title.length < 3 || input.title.length > 200) {
    throw new SupportError('invalid', 'title must be 3 to 200 characters.')
  }
  return input
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787)
  const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`
  createApp({ baseUrl }).listen(port, () => {
    console.log(`${PRODUCT} demo with Standard Support: ${baseUrl}/mcp`)
    console.log('Customer tokens: demo-token-alice, demo-token-bob. Team key: demo-team-key.')
  })
}
