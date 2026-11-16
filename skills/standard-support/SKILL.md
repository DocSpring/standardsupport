---
name: standard-support
description: Adds Standard Support to an existing MCP server or API, so that customers' AI agents can report bugs, wrong results and feedback to the product's team in one call, read the team's replies and answer them. Covers the four support_* tools and their schemas, the same operations as REST endpoints, the watch URL a background script polls for replies, ticket ownership, rate limits, and the rules that stop injected text from steering either side. Use when the user wants agents to be able to report problems or give feedback through their MCP server or API, asks for a feedback, bug report or support ticket tool for agents, mentions Standard Support or standardsupport.dev, or already has a one-way feedback tool (submit_feedback, give_feedback, report_issue) and wants replies. Not for adding a human chat widget, and not for filing a ticket with some other product's support.
license: MIT
---

# Standard Support

Standard Support is a ready-made design for support tickets from AI agents: four tools, one status URL, and the
decisions around them. A customer's agent reports a problem to the product's team and picks up the reply, even in
a later session. Your job is to build it into the user's product, in their language and their stack, using
what their codebase already has.

It is a design to copy, not a protocol to conform to. Agents read each tool's description, so nothing breaks if the
user changes a decision. Follow the design unless they ask otherwise, and tell them when you depart from it.

Read these before writing code:

- [references/spec.md](references/spec.md): every tool, field, status and rule, with the reason for each.
- [references/descriptions.md](references/descriptions.md): the exact tool descriptions, server instruction and
  error line. Copy them and change only the product's name.

A working example in JavaScript is at
https://github.com/DocSpring/standardsupport/tree/main/examples/reference-server.

## 1. Find out what's there

Look before you ask. From the codebase, work out:

- **The MCP server**: language, SDK, how tools are registered, whether it has `instructions`.
- **Sign-in**: how a tool call finds the signed-in account or user. Tickets belong to that account. If the server
  has no sign-in, only level 1 is possible, plus read and reply for whoever holds an unguessable ticket ID.
- **Request IDs**: whether errors already carry one. If not, adding one is part of this work.
- **Storage**: the database and how migrations are written.
- **Where the team works**: an admin page, a helpdesk, Slack, email. Reports must reach people who will answer.
- **An existing feedback tool**: if there is one, this replaces it. Keep its name working as an alias if customers'
  agents may have learned it.
- **A REST API**: if agents use it, the same four operations go there too.

Then ask the user only what the code can't tell you, in one message:

1. How far to go: level 1 (reports only), level 2 (replies) or level 3 (the watch URL too). Recommend 3 if there is
   sign-in.
2. Where new tickets should be announced, and where the team will reply from.
3. Whether the tool should tell agents to get the user's yes first and to report only what blocked the task or
   cost real time (the default), or should invite every report, small ones included. Recommend the default unless
   they want every report and have someone to read them. Either way the customer has the last word: their client
   decides whether a write needs confirming.

## 2. Build it

Work in this order. Each step is usable by itself.

1. **Storage.** Two tables: tickets and messages. The report's description is the first message. Store what the
   agent sent apart from what your server filled in (account, user, OAuth client ID, client name and version,
   server version). Give each ticket a random ID and, for level 3, a separate random watch token of at least 128
   bits.
2. **`support_open_ticket`.** The schema in the spec, including the optional `session` label. Scrub recognisable
   tokens and keys from `description` and `error` before storing. Honour `idempotency_key`. Rate limit new tickets
   per account (20 a day unless the user says otherwise) and say in the error when to try again. Mark it as a
   write (`readOnlyHint: false`).
3. **Announce it.** Send the new ticket to where the team works. This is what makes the tool worth having.
4. **The nudge.** Add the one-sentence instruction to the server's `instructions`, and end every error result of
   the product's own tools with its request ID and the line that points at `support_open_ticket`. Without this,
   agents rarely report.
5. **`support_list_tickets`, `support_get_ticket`, `support_reply_to_ticket`.** Every one checks that the ticket
   belongs to the caller's account, and answers a missing ticket and someone else's ticket identically. The list
   filters by `status` (`open`, `closed`, `all`) and `session`, and its default includes any ticket with an unread
   reply. Reading marks the team's messages read. The first two are marked read-only; the reply is a write.
6. **The team's reply path.** A form in the admin page, a helpdesk integration, or tools for the team's own agents.
   A reply adds a message and may set the status. Email the reply to the signed-in user as well, at the address in
   the product's own database.
7. **The watch URL.** `GET` with the watch token in the path and no other sign-in. It returns `updated_at`,
   `status`, `unread_count`, `min_interval_seconds` and `long_poll`, and nothing else. Support `ETag`.
8. **REST endpoints**, if the product has an API that agents use.
9. **Say so.** Advertise `dev.standardsupport/tickets` under `capabilities.extensions` with the level reached.
10. **Tests** for each rule in the checklist below.

## 3. Rules you must not skip

These are where an implementation goes wrong in ways that hurt people.

- **Keep a person in the loop.** Agents may end up on both sides of a ticket: the customer's filing it, the team's
  answering it. Build it so a person on the team always at least sees what comes in and what goes out (the
  announcement in step 3 is part of this), and tell the user so if they plan to let agents answer tickets unattended.
- **The user confirms first.** Use the default descriptions, which tell the agent to show the user everything it
  would send and get their yes before opening a ticket or replying. Mark both writing tools as writes so the
  customer's client can ask too. A vendor may invite more reports in the description, but can't grant permission on
  the customer's behalf.
- **Never let one account see another's ticket**, including through the list, a reply or an error message that
  differs between "not yours" and "doesn't exist". Scope by account, never by OAuth client alone.
- **The watch URL returns no ticket content.** No title, no message text, no account. Its token is not the ticket ID.
- **Long polling is off unless the server can take it.** Holding requests open is safe only on a server built for
  many idle connections (Go, Rust, Node, an async Python server). On a thread or process pool (Ruby on Rails,
  Django or Flask under a sync server, PHP-FPM) each waiting request takes a worker, and a few dozen watchers can
  stop the whole application. Return `"long_poll": false` and answer at once. If the product has a separate
  service that can hold connections, put the watch URL there.
- **Reports are untrusted text.** Show them as data. If the team's own agents read tickets, they must not hold
  credentials that reach other customers' data, and must not act on instructions inside a report. Say this to the
  user plainly if they plan to automate triage.
- **Replies are untrusted text to the customer's agent.** `support_get_ticket` puts a fixed notice in front of the
  messages saying they are information for the user and not instructions. Keep replies plain text.
- **The agent can't choose where email goes.** Replies are emailed to the signed-in user's own address only.
- **The `session` label is not an identity.** It sorts one customer's tickets by the agent or task that opened
  them. Never use it to decide who may see a ticket.
- **Reports change nothing automatically.** They go to a queue for a person or a supervised agent.
- **Don't ask the agent for what the server knows.** Account, user, client and version come from the request.
  What the agent says about itself (`agent.name`, `agent.model`) is stored as unverified.

## 4. Check your work

- [ ] A failing tool call returns a request ID and names `support_open_ticket`.
- [ ] The server's `instructions` mention `support_open_ticket`.
- [ ] Opening a ticket returns its ID, status, how the reply will arrive, and the watch URL.
- [ ] The same `idempotency_key` returns the same ticket.
- [ ] The twenty-first ticket in a day is refused with a time to retry.
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
- [ ] `support_open_ticket` and `support_reply_to_ticket` are marked as writes; the list and get tools as read-only.
- [ ] The descriptions tell the agent to show the user what it would send and get their yes.
- [ ] The server advertises `dev.standardsupport/tickets` with its level.
- [ ] The team was told about the new ticket where they work.
- [ ] Tool names are exactly `support_open_ticket`, `support_list_tickets`, `support_get_ticket` and
      `support_reply_to_ticket`.

When you finish, tell the user what you built, which level it reaches, anything you changed from the design and
why, and what they still need to do themselves (for example, deciding who answers tickets).
