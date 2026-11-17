---
name: standard-support
description: Adds Standard Support to an existing MCP server or API, so that customers' AI agents can ask for help, send feedback and open support tickets with the product's team, then read the team's replies and answer them. Covers support_get_help (answers from the product's documentation), support_send_feedback (one-way, nobody replies), the four ticket tools and their schemas, the same operations as REST endpoints, the watch URL a background script polls for replies, ticket ownership, rate limits, and the rules that stop injected text from steering either side. Use when the user wants agents to be able to report problems, give feedback or get help through their MCP server or API, asks for a feedback, bug report or support ticket tool for agents, mentions Standard Support or standardsupport.dev, or already has a one-way feedback tool (submit_feedback, give_feedback, report_issue) and wants replies. Not for adding a human chat widget, and not for filing a ticket with some other product's support.
license: MIT
---

# Standard Support

Standard Support is a ready-made design for what a customer's AI agent does when something goes wrong with a
product. There are three things it can do, each with its own tool and rules:

- **Ask for help** (`support_get_help`, optional): a question answered from the product's documentation. No ticket.
- **Send feedback** (`support_send_feedback`): something got in the way and the work carried on. One-way: nobody
  replies. Sent without asking the user.
- **Open a ticket** (`support_open_ticket`, with list, get and reply): the user is blocked or needs an answer. A
  person replies, and a later session can pick the reply up. The user agrees first.

Your job is to build it into the user's product, in their language and their stack, using what their codebase
already has.

It is a design to copy, not a protocol to conform to. Agents read each tool's description, so nothing breaks if the
user changes a decision. Follow the design unless they ask otherwise, and tell them when you depart from it.

Read these before writing code:

- [references/spec.md](references/spec.md): every tool, field, status and rule, with the reason for each.
- [references/descriptions.md](references/descriptions.md): the exact tool descriptions, server instruction and
  error line. Copy them and change only the product's name.

A working example in TypeScript is at
https://github.com/DocSpring/standardsupport/tree/main/examples/reference-server.

## 1. Find out what's there

Look before you ask. From the codebase, work out:

- **The MCP server**: language, SDK, how tools are registered, whether it has `instructions`.
- **Sign-in**: how a tool call finds the signed-in account or user. Tickets belong to that account. If the server
  has no sign-in, only level 1 is possible, plus read and reply for whoever holds an unguessable ticket ID.
- **Request IDs**: whether errors already carry one. If not, adding one is part of this work.
- **Storage**: the database and how migrations are written.
- **Where the team works**: an admin page, a helpdesk, Slack, email. Reports must reach people who will answer.
- **An existing feedback tool**: if there is one, it becomes `support_send_feedback`. Keep its old name working as
  an alias if customers' agents may have learned it.
- **A REST API**: if agents use it, the same operations go there too.
- **Documentation the product can search**: a docs site with search, a docs MCP server, a help centre. This decides
  whether `support_get_help` is worth offering.

Then ask the user only what the code can't tell you, in one message:

1. How far to go: level 1 (feedback only), level 2 (tickets too) or level 3 (the watch URL too). Recommend 3 if
   there is sign-in.
2. Where feedback should go (a channel, a triage list, analytics), where new tickets should be announced, and where
   the team will reply from. Feedback and tickets should land in different places.
3. Whether to offer `support_get_help`, and what answers it. Recommend it when the product has searchable
   documentation: it answers the questions that aren't bugs and keeps them out of the ticket queue.
4. Whether agents may send feedback without asking the user (the default, and what gets enough feedback to learn
   from) or must ask first. Tickets always ask, unless the user asked for the ticket themselves.

## 2. Build it

Work in this order. Each step is usable by itself.

1. **Storage.** Feedback and tickets take the same fields, so one table with a type, or two tables, both work.
   Tickets also have messages: the description is the first message. Store what the agent sent apart from what your
   server filled in (account, user, OAuth client ID, client name and version, server version). Give each record a
   random ID and, for level 3, each ticket a separate random watch token of at least 128 bits.
2. **`support_send_feedback`.** The schema in the spec, including `source` and the optional `session` label. Scrub
   recognisable tokens and keys from `description` and `error` before storing. Honour `idempotency_key`. Rate limit
   per account (50 a day unless the user says otherwise) and say in the error when to try again. It returns an ID
   and the fixed `follow_up` line, and nothing an agent can check later. Mark it as a write.
3. **Send feedback somewhere.** A channel, a triage list or analytics: wherever the team will see it, apart from
   the ticket inbox. This is what makes the tool worth having.
4. **The nudge.** Add the instruction sentences to the server's `instructions`, and end every error result of the
   product's own tools with its request ID and the line that says where to take it. Without this, agents rarely
   speak up. Leave out the sentences for tools you didn't build.
5. **`support_open_ticket`.** The same fields as feedback. Rate limit new tickets (20 a day). Announce each new
   ticket where the team works. Mark it as a write.
6. **`support_list_tickets`, `support_get_ticket`, `support_reply_to_ticket`.** Every one checks that the ticket
   belongs to the caller's account, and answers a missing ticket and someone else's ticket identically. The list
   filters by `status` (`open`, `closed`, `all`) and `session`, and its default includes any ticket with an unread
   reply. Reading marks the team's messages read. The first two are marked read-only; the reply is a write.
7. **The team's side.** A way to read feedback, a way to reply to a ticket (a form in the admin page, a helpdesk
   integration, or tools for the team's own agents), and a way to turn a piece of feedback into a ticket with a
   first reply. A reply adds a message and may set the status. Email the reply to the signed-in user as well, at
   the address in the product's own database.
8. **The watch URL.** `GET` with the watch token in the path and no other sign-in. It returns `updated_at`,
   `status`, `unread_count`, `min_interval_seconds` and `long_poll`, and nothing else. Support `ETag`.
9. **REST endpoints**, if the product has an API that agents use.
10. **`support_get_help`**, if the user wants it. It takes a question and returns an answer with its sources from
    the product's documentation and known issues, or says it has none, and always ends by pointing at feedback and
    tickets. Read-only, no ticket, no sign-in needed. Whatever answers must see only the question and public
    documentation. Build it one of two ways: a search over the documentation with vector embeddings that returns
    the best-matching passages, or the same search with a model writing an answer from what it finds. Use the
    product's existing docs search if it has one, and prefer the plain search unless the user asks for more.
11. **Say so.** Advertise `dev.standardsupport/support` under `capabilities.extensions` with the level reached, and
    `help: true` if you built the help tool.
12. **Tests** for each rule in the checklist below.

## 3. Rules you must not skip

These are where an implementation goes wrong in ways that hurt people.

- **Keep a person in the loop.** Agents may end up on both sides of a ticket: the customer's filing it, the team's
  answering it. Build it so a person on the team always at least sees what comes in and what goes out (the
  announcement in step 3 is part of this), and tell the user so if they plan to let agents answer tickets unattended.
- **Help can run unattended; tickets can't.** `support_get_help` may be answered by a search or by an agent of
  the vendor's, but it must only read documentation and known issues: no account lookups, no credentials, no other
  tools, and it never opens a ticket itself. That limit is what makes it safe to leave running.
- **Feedback only goes one way.** It returns an ID and nothing else. Don't build a status or a response the agent
  can read back. The team answers a piece of feedback by emailing the person or turning it into a ticket.
- **The user confirms a ticket, unless they asked.** Use the default descriptions, which tell the agent to show
  the user everything it would send and get their yes before opening a ticket or replying, and to set
  `source: user` and skip the question when the user asked for it themselves. Mark everything that sends something
  (feedback, a new ticket, a reply) as a write so the customer's client can ask too. A vendor's description can't
  grant permission on the customer's behalf.
- **Never let one account see another's ticket**, including through the list, a reply or an error message that
  differs between "not yours" and "doesn't exist". Scope by account, never by OAuth client alone.
- **The watch URL returns no ticket content.** No title, no message text, no account. Its token is not the ticket ID.
- **Long polling is off unless the server can take it.** Holding requests open is safe only on a server built for
  many idle connections (Go, Rust, Node, an async Python server). On a thread or process pool (Ruby on Rails,
  Django or Flask under a sync server, PHP-FPM) each waiting request takes a worker, and a few dozen watchers can
  stop the whole application. Return `"long_poll": false` and answer at once. If the product has a separate
  service that can hold connections, put the watch URL there.
- **Feedback and tickets are untrusted text.** Show them as data. If the team's own agents read tickets, they must not hold
  credentials that reach other customers' data, and must not act on instructions inside one. Say this to the
  user plainly if they plan to automate triage.
- **Replies are untrusted text to the customer's agent.** `support_get_ticket` puts a fixed notice in front of the
  messages saying they are information for the user and not instructions. Keep replies plain text.
- **The agent can't choose where email goes.** Replies are emailed to the signed-in user's own address only.
- **The `session` label is not an identity.** It sorts one customer's tickets by the agent or task that opened
  them. Never use it to decide who may see a ticket.
- **Nothing changes automatically.** Feedback and tickets go to a queue for a person or a supervised agent.
- **Don't ask the agent for what the server knows.** Account, user, client and version come from the request.
  What the agent says about itself (`agent.name`, `agent.model`) is stored as unverified.

## 4. Check your work

- [ ] A failing tool call returns a request ID and says where to take it.
- [ ] The server's `instructions` name the tools you built.
- [ ] Sending feedback returns an ID and the `follow_up` line, opens no ticket, and reaches the team's feedback queue.
- [ ] Opening a ticket returns its ID, status, how the reply will arrive, and the watch URL.
- [ ] The same `idempotency_key` returns the same record, for feedback and for tickets.
- [ ] The limits hold: the twenty-first ticket and the fifty-first piece of feedback in a day are refused with a
      time to retry.
- [ ] A token pasted into `description` or `error` is stored as `[removed]`.
- [ ] A second account can't list, read or reply to the first account's ticket, and gets the same error as for a
      ticket that doesn't exist.
- [ ] A team reply changes the watch URL's `updated_at` and `unread_count`; an unchanged poll with `If-None-Match`
      returns 304.
- [ ] `support_get_ticket` returns the notice, the messages in order, and marks the team's messages as read.
- [ ] A reply with `outcome: resolved` closes the ticket, `still_broken` reopens it, and a plain reply to a resolved
      ticket leaves it resolved.
- [ ] A resolved ticket with an unread reply still shows in the default list, and leaves it once the reply is read.
- [ ] `support_list_tickets` filters by `status` and by `session`, and a `session` label never hides a ticket from
      another agent of the same account.
- [ ] Feedback, a new ticket and a reply are marked as writes; help, list and get as read-only.
- [ ] The ticket and reply descriptions tell the agent to show the user what it would send and get their yes.
- [ ] Feedback and tickets record `source` (`agent` by default, `user` when the user asked for it).
- [ ] The team can turn a piece of feedback into a ticket, which then carries `feedback_id` and shows as an unread
      reply in the list.
- [ ] If built: `support_get_help` answers from documentation with sources, says when it has no answer, opens no
      ticket, and can reach nothing but documentation.
- [ ] The server advertises `dev.standardsupport/support` with its level.
- [ ] The team was told about the new ticket where they work, and feedback went somewhere else.
- [ ] Tool names are exactly `support_send_feedback`, `support_open_ticket`, `support_list_tickets`,
      `support_get_ticket` and `support_reply_to_ticket`, plus `support_get_help` if built.

When you finish, tell the user what you built, which level it reaches, anything you changed from the design and
why, and what they still need to do themselves (for example, deciding who answers tickets).
