// The ticket store and its rules, with no MCP or HTTP in it, so the same code serves the MCP tools, the REST endpoints
// and the watch URL. It keeps everything in memory: swap the Maps for your database.

import { createHash, randomBytes } from 'node:crypto'

export const KINDS = ['bug', 'crash', 'wrong_result', 'confusing', 'missing_feature', 'docs', 'question', 'other']
export const IMPACTS = ['blocked', 'worked_around', 'friction']
export const STATUSES = ['open', 'needs_reply', 'resolved', 'closed']
export const RESOLUTIONS = ['fixed', 'answered', 'planned', 'duplicate', 'not_reproducible', 'wont_fix']

export const NEW_TICKETS_PER_DAY = 20
export const FEEDBACK_PER_DAY = 50
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
    this.feedback = new Map() // feedback id -> feedback
    this.watchTokens = new Map() // watch token -> ticket id
    this.idempotency = new Map() // "account:key" -> ticket id or message id
  }

  // Feedback is one-way: something got in the way, the work carried on, and nobody replies. It goes to its own queue,
  // apart from the tickets people are waiting on.
  // account: { id, email } from your own sign-in. context: what the server knows and the agent shouldn't be asked for
  // (client name and version, OAuth client ID, server version).
  sendFeedback(account, input, context = {}) {
    const key = input.idempotency_key && `${account.id}:feedback:${input.idempotency_key}`
    if (key && this.idempotency.has(key)) {
      return { feedback: this.feedback.get(this.idempotency.get(key)), duplicate: true }
    }
    this.#limit(
      [...this.feedback.values()].filter((item) => item.account_id === account.id).map((item) => item.received_at),
      FEEDBACK_PER_DAY,
      'pieces of feedback',
    )

    const feedback = {
      id: id('fb'),
      account_id: account.id,
      ...this.#report(input),
      context,
      received_at: this.now().toISOString(),
      // Set when the team turns this into a ticket.
      ticket_id: undefined,
    }
    this.feedback.set(feedback.id, feedback)
    if (key) this.idempotency.set(key, feedback.id)
    return { feedback, duplicate: false }
  }

  // A ticket is a conversation: a person on the team reads it and replies.
  openTicket(account, input, context = {}) {
    const key = input.idempotency_key && `${account.id}:ticket:${input.idempotency_key}`
    if (key && this.idempotency.has(key)) {
      return { ticket: this.tickets.get(this.idempotency.get(key)), duplicate: true }
    }
    this.#limit(
      [...this.tickets.values()].filter((ticket) => ticket.account_id === account.id).map((t) => t.created_at),
      NEW_TICKETS_PER_DAY,
      'tickets',
    )
    const ticket = this.#createTicket(account.id, input.title, this.#report(input), context)
    if (key) this.idempotency.set(key, ticket.id)
    return { ticket, duplicate: false }
  }

  // The fields a piece of feedback and a ticket share, with tokens and keys removed from the free text.
  #report(input) {
    return {
      kind: input.kind,
      category: input.category,
      description: scrub(input.description),
      impact: input.impact,
      task: input.task,
      request_ids: input.request_ids ?? [],
      tool: input.tool,
      error: scrub(input.error),
      suggestion: input.suggestion,
      // Who started it: the user asked for it, or the agent noticed the problem itself.
      source: input.source ?? 'agent',
      // A label the agent chose (a session ID, a branch, a task name). For sorting, never for deciding who sees what.
      session: input.session,
      // Self-reported by the agent: never use it for a security decision.
      agent: input.agent,
    }
  }

  #limit(timestamps, perDay, what) {
    const since = this.now().getTime() - DAY_MS
    const recent = timestamps.map((timestamp) => Date.parse(timestamp)).filter((time) => time > since)
    if (recent.length >= perDay) {
      throw new SupportError('rate_limited', `This account has sent ${perDay} ${what} in 24 hours.`, {
        retry_after: new Date(Math.min(...recent) + DAY_MS).toISOString(),
      })
    }
  }

  #createTicket(accountId, title, report, context, extra = {}) {
    const timestamp = this.now().toISOString()
    const { description, ...fields } = report
    const ticket = {
      id: id('tkt'),
      account_id: accountId,
      title,
      status: 'open',
      resolution: undefined,
      ...fields,
      ...extra,
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
      body: description,
      created_at: timestamp,
      first_read_at: undefined,
    })
    this.tickets.set(ticket.id, ticket)
    this.watchTokens.set(ticket.watch_token, ticket.id)
    return ticket
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

  teamFeedback() {
    return [...this.feedback.values()].sort((a, b) => b.received_at.localeCompare(a.received_at))
  }

  // How feedback gets an answer when the team wants to give one: it becomes a ticket on the same account, with the
  // team's message as an unread reply. The customer's next agent finds it in support_list_tickets, under the same
  // rules as any other ticket. Nothing comes back through the feedback tool itself.
  promoteFeedback(feedbackId, { title, body }) {
    const feedback = this.feedback.get(feedbackId)
    if (!feedback) throw new SupportError('not_found', `Feedback ${feedbackId} was not found.`)
    if (feedback.ticket_id) return { ticket: this.tickets.get(feedback.ticket_id) }
    const { id: _id, account_id, context, received_at: _received, ticket_id: _ticket, ...report } = feedback
    const ticket = this.#createTicket(account_id, title, report, context, { from_feedback: feedback.id })
    if (body) this.#addMessage(ticket, 'team', body)
    feedback.ticket_id = ticket.id
    return { ticket }
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
    from_feedback: ticket.from_feedback,
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
