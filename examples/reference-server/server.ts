// A small product with Standard Support added: an MCP server at /mcp with one tool of its own (lookup_order) and the
// support_* tools, the same support operations as HTTP endpoints, the watch URL, and endpoints for the team.
//
//   node server.ts
//
// Sign-in here is a fixed table of demo tokens. Replace `accountFromToken` with your own.

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

import { answerFromDocs } from './help.ts'
import { helpInput, listInput, promoteInput, replyInput, reportInput, teamReplyInput, ticketInput } from './schemas.ts'
import { SupportError, SupportStore, maskEmail, presentMessage, presentTicket } from './store.ts'
import type { Account, SupportErrorCode, Ticket } from './store.ts'
import { errorNudge, getHelp, registerSupportTools, supportInstructions } from './tools.ts'

const PRODUCT = 'Acme Orders'

const DEMO_ACCOUNTS: Record<string, Account> = {
  'demo-token-alice': { id: 'acct_alice', email: 'alice@example.com' },
  'demo-token-bob': { id: 'acct_bob', email: 'bob@example.com' },
}
const DEMO_TEAM_KEY = 'demo-team-key'

function accountFromToken(token: string | undefined): Account | undefined {
  return token === undefined ? undefined : DEMO_ACCOUNTS[token]
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
}

// A new MCP server for each request: no sessions, so any instance can answer any request.
function buildMcpServer(store: SupportStore, baseUrl: string): McpServer {
  const server = new McpServer(
    { name: 'acme-orders', version: '0.1.0' },
    {
      instructions: `Look up Acme orders. ${supportInstructions(PRODUCT, { help: true })}`,
      // Tells clients and directories that this server takes feedback and tickets, and how much of the design it has.
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
    // The HTTP handler below put the signed-in account here.
    account: (extra) => extra.authInfo?.extra?.account as Account | undefined,
    // clientId is the verified OAuth client. A client's own name and version are self-reported.
    context: (extra) => ({ oauth_client_id: extra.authInfo?.clientId, server_version: '0.1.0' }),
    help: answerFromDocs,
  })
  return server
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
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

// Checks a request body against one of the shared shapes, and says which field is wrong.
function parse<Shape extends z.ZodRawShape>(shape: Shape, value: unknown): z.infer<z.ZodObject<Shape>> {
  const result = z.object(shape).safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const field = issue?.path.join('.') || 'body'
  throw new SupportError('invalid', `${field}: ${issue?.message ?? 'is not valid'}.`)
}

function send(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

const STATUS_BY_CODE: Record<SupportErrorCode, number> = { not_found: 404, rate_limited: 429, invalid: 400, too_large: 413 }

export interface AppOptions {
  store?: SupportStore
  // Where the server is reached from outside, as a string or a function that returns one.
  baseUrl: string | (() => string)
}

export function createApp({ store = new SupportStore(), baseUrl }: AppOptions): Server {
  const base = () => (typeof baseUrl === 'function' ? baseUrl() : baseUrl)
  const present = (ticket: Ticket) => presentTicket(ticket, { baseUrl: base() })
  const report = reportInput(PRODUCT)
  const newTicket = ticketInput(PRODUCT)

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', base())
      const path = url.pathname
      const method = request.method

      // The watch URL: no sign-in, only the unguessable token in the path.
      const watch = path.match(/^\/support\/watch\/([A-Za-z0-9_]+)$/)
      if (watch?.[1] && method === 'GET') {
        const { body, etag } = store.watch(watch[1])
        if (request.headers['if-none-match'] === etag) return send(response, 304, undefined, { etag })
        return send(response, 200, body, { etag, 'cache-control': 'no-store' })
      }

      // Help answers from public documentation, so it needs no sign-in. Rate limit it by address in a real product.
      if (path === '/support/help' && method === 'POST') {
        return send(response, 200, await getHelp(answerFromDocs, parse(helpInput, await readJson(request))))
      }

      // The team's side. In a real product this is your admin page, your helpdesk or your own agents.
      if (path.startsWith('/team/')) {
        if (bearer(request) !== DEMO_TEAM_KEY) return send(response, 401, { error: 'Not signed in.' })

        if (path === '/team/feedback' && method === 'GET') {
          return send(response, 200, { feedback: store.teamFeedback() })
        }
        // Turns a piece of feedback into a ticket, which is how the team answers one.
        const promote = path.match(/^\/team\/feedback\/([A-Za-z0-9_]+)\/promote$/)
        if (promote?.[1] && method === 'POST') {
          const { ticket } = store.promoteFeedback(promote[1], parse(promoteInput, await readJson(request)))
          return send(response, 201, { ticket: present(ticket) })
        }
        if (path === '/team/tickets' && method === 'GET') return send(response, 200, { tickets: store.teamList() })
        const reply = path.match(/^\/team\/tickets\/([A-Za-z0-9_]+)\/replies$/)
        if (reply?.[1] && method === 'POST') {
          const { ticket, message } = store.teamReply(reply[1], parse(teamReplyInput, await readJson(request)))
          return send(response, 201, { ticket: present(ticket), message: presentMessage(message) })
        }
        return send(response, 404, { error: 'Not found.' })
      }

      const account = accountFromToken(bearer(request))
      if (!account) return send(response, 401, { error: 'Not signed in.' })

      if (path === '/mcp') {
        if (method !== 'POST') return send(response, 405, { error: 'Use POST.' }, { allow: 'POST' })
        const body = await readJson(request)
        // The SDK hands this to each tool as extra.authInfo.
        const auth: AuthInfo = { token: 'redacted', clientId: 'demo-client', scopes: [], extra: { account } }
        const server = buildMcpServer(store, base())
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        response.on('close', () => {
          void transport.close()
          void server.close()
        })
        await server.connect(transport)
        return await transport.handleRequest(Object.assign(request, { auth }), response, body)
      }

      // The same operations over HTTP, for agents that use the API, an SDK or a CLI and never load the MCP server.
      if (path === '/support/feedback' && method === 'POST') {
        const { feedback, duplicate } = store.sendFeedback(account, parse(report, await readJson(request)))
        return send(response, duplicate ? 200 : 201, {
          feedback: { id: feedback.id, received_at: feedback.received_at },
          duplicate,
        })
      }
      if (path === '/support/tickets' && method === 'POST') {
        const { ticket, duplicate } = store.openTicket(account, parse(newTicket, await readJson(request)))
        const presented = present(ticket)
        return send(response, duplicate ? 200 : 201, {
          ticket: presented,
          notifications: { email: maskEmail(account.email), watch: { url: presented.watch_url, min_interval_seconds: 60 } },
          duplicate,
        })
      }
      if (path === '/support/tickets' && method === 'GET') {
        const query = Object.fromEntries(url.searchParams)
        const { tickets, next_cursor } = store.listTickets(
          account,
          parse(listInput, { ...query, limit: query.limit === undefined ? undefined : Number(query.limit) }),
        )
        return send(response, 200, { tickets: tickets.map(present), next_cursor })
      }
      const one = path.match(/^\/support\/tickets\/([A-Za-z0-9_]+)$/)
      if (one?.[1] && method === 'GET') {
        const { ticket, messages } = store.getTicket(account, one[1], {
          after_message_id: url.searchParams.get('after_message_id') ?? undefined,
        })
        return send(response, 200, { ticket: present(ticket), messages: messages.map(presentMessage) })
      }
      const replies = path.match(/^\/support\/tickets\/([A-Za-z0-9_]+)\/replies$/)
      if (replies?.[1] && method === 'POST') {
        const { ticket, message } = store.reply(account, replies[1], parse(replyInput, await readJson(request)))
        return send(response, 201, { ticket: present(ticket), message: presentMessage(message) })
      }

      return send(response, 404, { error: 'Not found.' })
    } catch (error) {
      if (!(error instanceof SupportError)) {
        console.error(error)
        if (!response.headersSent) send(response, 500, { error: 'Something went wrong.' })
        return
      }
      const headers: Record<string, string> = error.retry_after ? { 'retry-after': error.retry_after } : {}
      send(response, STATUS_BY_CODE[error.code], { error: error.message, retry_after: error.retry_after }, headers)
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787)
  const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`
  createApp({ baseUrl }).listen(port, () => {
    console.log(`${PRODUCT} demo with Standard Support: ${baseUrl}/mcp`)
    console.log('Customer tokens: demo-token-alice, demo-token-bob. Team key: demo-team-key.')
  })
}
