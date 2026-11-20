// What each operation takes, written once as zod shapes. The MCP tools and the HTTP endpoints check what they are
// sent against the same shapes.

import { z } from 'zod'

import { IMPACTS, KINDS, LIST_STATUSES, RESOLUTIONS, STATUSES } from './store.ts'

// What the two MCP tools show an agent: every field by name and type, the choices where there are any, and no
// descriptions or limits. A client sends this to the model on every turn, so it stays small. The full shapes below
// check each call, and a call that's missing something is told what to send.
export type ReadAction = 'help' | 'list_tickets' | 'get_ticket' | 'guide'
export type SendAction = 'feedback' | 'ticket' | 'reply'

const text = z.string().optional()

export function readInput(actions: ReadAction[]) {
  const tickets = actions.includes('list_tickets')
  return {
    action: z.enum(actions as [ReadAction, ...ReadAction[]]),
    ...(actions.includes('help') ? { question: text, tool: text, error: text } : {}),
    ...(tickets
      ? {
          ticket_id: text,
          after_message_id: text,
          status: z.enum(LIST_STATUSES).optional(),
          session: text,
          updated_since: text,
          limit: z.number().optional(),
          cursor: text,
        }
      : {}),
  }
}

export function sendInput(actions: SendAction[]) {
  return {
    action: z.enum(actions as [SendAction, ...SendAction[]]),
    title: text,
    kind: z.enum(KINDS).optional(),
    description: text,
    impact: z.enum(IMPACTS).optional(),
    source: z.enum(['agent', 'user']).optional(),
    task: text,
    request_ids: z.array(z.string()).optional(),
    tool: text,
    error: text,
    suggestion: text,
    session: text,
    agent: z.looseObject({}).optional(),
    idempotency_key: text,
    ...(actions.includes('reply') ? { ticket_id: text, body: text, outcome: z.enum(['resolved', 'still_broken']).optional() } : {}),
  }
}

export const helpInput = {
  question: z.string().min(3).max(2000).describe('What you want to know, in a sentence or two.'),
  tool: z.string().max(100).optional().describe('The tool involved, if any.'),
  error: z.string().max(4000).optional().describe('The exact error text, if any.'),
}

// What a piece of feedback and a ticket both carry.
export function reportInput(product: string) {
  return {
    title: z.string().min(3).max(200).describe('One line, written like an issue title.'),
    kind: z.enum(KINDS).describe('What kind of problem this is.'),
    description: z.string().min(1).max(4000).describe('What you tried, what you expected and what happened.'),
    impact: z
      .enum(IMPACTS)
      .optional()
      .describe('blocked: the task could not be done. worked_around: done another way. friction: only slower.'),
    task: z.string().max(200).optional().describe('What the user asked you to do, in a short phrase.'),
    request_ids: z
      .array(z.string().max(200))
      .max(10)
      .optional()
      .describe(`Request IDs from ${product}'s error messages or results.`),
    tool: z.string().max(100).optional().describe('The tool involved.'),
    error: z.string().max(4000).optional().describe('The exact error text.'),
    suggestion: z.string().max(2000).optional().describe('What would have helped.'),
    source: z
      .enum(['agent', 'user'])
      .optional()
      .describe('user: the user asked you to send this. agent (default): you noticed the problem yourself.'),
    session: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('A label for the work you are doing, such as a session ID, a branch or a task name.'),
    agent: z
      .object({
        name: z.string().max(100).optional(),
        version: z.string().max(50).optional(),
        model: z.string().max(100).optional(),
      })
      .optional()
      .describe('The agent sending this.'),
    idempotency_key: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('A retry with the same key returns the same record.'),
  }
}

// A ticket takes the same fields as feedback.
export const ticketInput = reportInput

export const listInput = {
  status: z
    .enum(LIST_STATUSES)
    .optional()
    .describe(
      'open (default): not yet resolved or closed, plus any ticket with an unread reply. closed: the rest. all: every ticket.',
    ),
  session: z.string().max(100).optional().describe('Only tickets opened with this session label.'),
  updated_since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(100).optional().describe('next_cursor from the previous page.'),
}

export const replyInput = {
  body: z.string().min(1).max(4000),
  outcome: z
    .enum(['resolved', 'still_broken'])
    .optional()
    .describe('resolved: the problem is fixed, close the ticket. still_broken: it is not, reopen it.'),
  idempotency_key: z.string().min(1).max(64).optional(),
}

// The team's side.
export const teamReplyInput = {
  body: z.string().min(1).max(4000),
  status: z.enum(STATUSES).optional(),
  resolution: z.enum(RESOLUTIONS).optional(),
}

export const promoteInput = {
  // Defaults to the feedback's own title.
  title: z.string().min(3).max(200).optional(),
  body: z.string().min(1).max(4000).optional(),
}
