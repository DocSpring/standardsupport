// The ticket store and its rules, with no MCP or HTTP in it, so the same code serves the MCP tools, the REST endpoints
// and the watch URL. It keeps everything in memory: swap the Maps for your database.

import { createHash, randomBytes } from 'node:crypto'

export const KINDS = ['bug', 'crash', 'wrong_result', 'confusing', 'missing_feature', 'docs', 'question', 'other']
export const IMPACTS = ['blocked', 'worked_around', 'friction']
export const STATUSES = ['open', 'needs_reply', 'resolved', 'closed']
export const RESOLUTIONS = ['fixed', 'answered', 'planned', 'duplicate', 'not_reproducible', 'wont_fix']

export const NEW_TICKETS_PER_DAY = 20
export const MIN_WATCH_INTERVAL_SECONDS = 60
const DAY_MS = 24 * 60 * 60 * 1000

export class SupportError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

// Tokens and keys the agent may have pasted into a description or an error. Each input is at most 4,000 characters,
// so these patterns can't run away.
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bwhsec_[A-Za-z0-9+/=]{16,}\b/g,
]
// "api_key=...", "token: ...": the label stays, so the team can still see what was there.
const LABELLED_SECRET = /\b(api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi

export function scrub(text) {
  if (text === undefined) return undefined
  let result = text
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[removed]')
  return result.replace(LABELLED_SECRET, '$1$2[removed]')
}

function id(prefix, bytes = 16) {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`
}

export class SupportStore {
  constructor({ now = () => new Date() } = {}) {
    this.now = now
    this.tickets = new Map() // ticket id -> ticket
    this.watchTokens = new Map() // watch token -> ticket id
    this.idempotency = new Map() // "account:key" -> ticket id or message id
  }

  // account: { id, email } from your own sign-in. context: what the server knows and the agent shouldn't be asked for
  // (client name and version, OAuth client ID, server version).
  openTicket(account, input, context = {}) {
    const key = input.idempotency_key && `${account.id}:ticket:${input.idempotency_key}`
    if (key && this.idempotency.has(key)) {
      return { ticket: this.tickets.get(this.idempotency.get(key)), duplicate: true }
    }

    const since = this.now().getTime() - DAY_MS
    const recent = [...this.tickets.values()].filter(
      (ticket) => ticket.account_id === account.id && Date.parse(ticket.created_at) > since,
    )
    if (recent.length >= NEW_TICKETS_PER_DAY) {
      const oldest = Math.min(...recent.map((ticket) => Date.parse(ticket.created_at)))
      throw new SupportError('rate_limited', `This account has opened ${NEW_TICKETS_PER_DAY} tickets in 24 hours.`, {
        retry_after: new Date(oldest + DAY_MS).toISOString(),
      })
    }

    const timestamp = this.now().toISOString()
    const ticket = {
      id: id('tkt'),
      account_id: account.id,
      kind: input.kind,
      category: input.category,
      title: input.title,
      status: 'open',
      resolution: undefined,
      impact: input.impact,
      task: input.task,
      request_ids: input.request_ids ?? [],
      tool: input.tool,
      error: scrub(input.error),
      suggestion: input.suggestion,
      source: input.source ?? 'agent',
      // A label the agent chose (a session ID, a branch, a task name). For sorting, never for deciding who sees what.
      session: input.session,
      // Self-reported by the agent: never use it for a security decision.
      agent: input.agent,
      // Filled in by the server.
      context,
      created_at: timestamp,
      updated_at: timestamp,
      watch_token: id('w', 24),
      messages: [],
    }
    // The description is the first message, so a ticket reads as one conversation.
    ticket.messages.push({
      id: id('msg'),
      author: 'reporter',
      body: scrub(input.description),
      created_at: timestamp,
      first_read_at: undefined,
    })

    this.tickets.set(ticket.id, ticket)
    this.watchTokens.set(ticket.watch_token, ticket.id)
    if (key) this.idempotency.set(key, ticket.id)
    return { ticket, duplicate: false }
  }

  listTickets(account, { status = 'open', session, updated_since, limit = 20, cursor } = {}) {
    let tickets = [...this.tickets.values()]
      .filter((ticket) => ticket.account_id === account.id)
      .filter((ticket) => status === 'all' || needsAttention(ticket) === (status === 'open'))
      .filter((ticket) => session === undefined || ticket.session === session)
      .filter((ticket) => !updated_since || Date.parse(ticket.updated_at) > Date.parse(updated_since))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))

    if (cursor) {
      const index = tickets.findIndex((ticket) => ticket.id === cursor)
      tickets = index === -1 ? [] : tickets.slice(index + 1)
    }
    const page = tickets.slice(0, limit)
    return { tickets: page, next_cursor: tickets.length > limit ? page.at(-1).id : undefined }
  }

  // Marks the team's messages as read by this client: first_read_at shows the agent fetched a message, not that a
  // person saw it.
  getTicket(account, ticketId, { after_message_id } = {}) {
    const ticket = this.#find(account, ticketId)
    let messages = ticket.messages
    if (after_message_id) {
      const index = messages.findIndex((message) => message.id === after_message_id)
      messages = index === -1 ? messages : messages.slice(index + 1)
    }
    const timestamp = this.now().toISOString()
    for (const message of messages) {
      if (message.author === 'team' && !message.first_read_at) message.first_read_at = timestamp
    }
    return { ticket, messages }
  }

  reply(account, ticketId, { body, outcome, idempotency_key }) {
    const ticket = this.#find(account, ticketId)
    const key = idempotency_key && `${account.id}:reply:${ticketId}:${idempotency_key}`
    if (key && this.idempotency.has(key)) {
      const messageId = this.idempotency.get(key)
      return { ticket, message: ticket.messages.find((message) => message.id === messageId), duplicate: true }
    }

    const message = this.#addMessage(ticket, 'reporter', scrub(body))
    if (outcome === 'resolved') {
      ticket.status = 'closed'
      ticket.resolution ??= 'fixed'
    } else if (outcome === 'still_broken' || ticket.status === 'needs_reply') {
      // "Still broken" reopens a resolved or closed ticket, and an answer to the team's question hands it back.
      ticket.status = 'open'
      ticket.resolution = undefined
    }
    // Any other reply ("thanks") leaves a resolved or closed ticket as it is.
    if (key) this.idempotency.set(key, message.id)
    return { ticket, message, duplicate: false }
  }

  // The team's side: your support tool, admin page or your own agents call this. It takes no account, because the
  // team can see every ticket.
  teamReply(ticketId, { body, status, resolution }) {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) throw new SupportError('not_found', `Ticket ${ticketId} was not found.`)
    const message = this.#addMessage(ticket, 'team', body)
    if (status) ticket.status = status
    ticket.resolution = ticket.status === 'resolved' || ticket.status === 'closed' ? resolution : undefined
    return { ticket, message }
  }

  teamList() {
    return [...this.tickets.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  // The watch URL's answer. It has no title, no text and no account: a leaked URL shows only that something changed.
  watch(watchToken) {
    const ticket = this.tickets.get(this.watchTokens.get(watchToken))
    if (!ticket) throw new SupportError('not_found', 'Not found.')
    const body = {
      updated_at: ticket.updated_at,
      status: ticket.status,
      unread_count: unreadCount(ticket),
      min_interval_seconds: MIN_WATCH_INTERVAL_SECONDS,
      long_poll: false,
    }
    const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}"`
    return { body, etag }
  }

  #find(account, ticketId) {
    const ticket = this.tickets.get(ticketId)
    // A missing ticket and another account's ticket get the same answer.
    if (!ticket || ticket.account_id !== account.id) {
      throw new SupportError('not_found', `Ticket ${ticketId} was not found on this account.`)
    }
    return ticket
  }

  #addMessage(ticket, author, body) {
    const timestamp = this.now().toISOString()
    const message = { id: id('msg'), author, body, created_at: timestamp, first_read_at: undefined }
    ticket.messages.push(message)
    ticket.updated_at = timestamp
    return message
  }
}

// The list's filter. "open", the default, is what an agent should look at: every ticket not yet resolved or closed,
// and any ticket with a reply from the team that nobody has read, so a fix that arrived overnight isn't missed.
// "closed" is the rest.
export const LIST_STATUSES = ['open', 'closed', 'all']

function needsAttention(ticket) {
  return ticket.status === 'open' || ticket.status === 'needs_reply' || unreadCount(ticket) > 0
}

export function unreadCount(ticket) {
  return ticket.messages.filter((message) => message.author === 'team' && !message.first_read_at).length
}

// What a customer's agent sees of a ticket: no account, no server context, and the watch token only inside its URL.
export function presentTicket(ticket, { baseUrl }) {
  return {
    id: ticket.id,
    kind: ticket.kind,
    category: ticket.category,
    title: ticket.title,
    status: ticket.status,
    resolution: ticket.resolution,
    impact: ticket.impact,
    task: ticket.task,
    request_ids: ticket.request_ids,
    tool: ticket.tool,
    error: ticket.error,
    suggestion: ticket.suggestion,
    session: ticket.session,
    source: ticket.source,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    unread_count: unreadCount(ticket),
    watch_url: `${baseUrl}/support/watch/${ticket.watch_token}`,
  }
}

export function presentMessage(message) {
  return {
    id: message.id,
    author: message.author,
    body: message.body,
    created_at: message.created_at,
    first_read_at: message.first_read_at,
  }
}

export function maskEmail(email) {
  if (!email) return undefined
  const [name, domain] = email.split('@')
  return `${name.slice(0, 1)}***@${domain}`
}
