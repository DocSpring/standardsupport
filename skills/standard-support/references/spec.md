# Standard Support (draft 0.5)

Three things a customer's AI agent can do when something goes wrong with your product: ask for help, send
feedback, or open a ticket.

| Operation                    | What the agent does with it                                                 | Asks the user first?          | Level    |
| ---------------------------- | --------------------------------------------------------------------------- | ----------------------------- | -------- |
| `help`                       | Asks a question, answered at once from your documentation                   | No                            | optional |
| `feedback`                   | Reports something that got in the way. One-way: nobody replies              | No. It tells them afterwards  | 1        |
| `ticket`                     | Opens a ticket when the user needs an answer. A person on your team replies | Yes, unless they asked for it | 2        |
| `list_tickets`               | Lists this account's tickets                                                | No                            | 2        |
| `get_ticket`                 | Reads one ticket and its messages                                           | No                            | 2        |
| `reply`                      | Adds a message; says whether it's fixed or still broken                     | Yes                           | 2        |
| a `watch_url` on each ticket | A status URL that a background script polls for changes                     |                               | 3        |

An MCP server offers these through two tools, each taking an `action`: `support` for the three that read (`help`,
`list_tickets`, `get_ticket`) and `support_send` for the three that send (`feedback`, `ticket`, `reply`). Together
they add about 700 tokens to a server's tool list. An API offers the same operations as endpoints.

You can stop at any level. Level 1 alone is the one-way feedback tool that many MCP servers gained during 2026
under different names (`submit_feedback`, `give_feedback`, `send_feedback`, `report_issue`). Help can go with any
level.

Help, feedback and tickets are kept apart on purpose, because they each have their own risks. Help is a question
answered from your own documentation: nothing private goes in and no person is involved, so you can automate it end
to end. Feedback goes one way: nothing comes back to the customer's agent, and nobody on your side is on the hook
to reply, so you can invite a lot of it. A ticket carries a customer's problem to your team and your answer back:
a person agreed to send it, and a person on your side should at least be watching what happens to it.

It is written with developer tools in mind, where an AI coding agent builds an integration with a product, but
it works for any product with an MCP server or an API and any AI tool that uses one.

This is a design to copy, not a protocol to conform to. Each decision below comes with its reason, so you can
disagree with one and keep the rest.

## Two tools

A client sends every tool's definition to the model on every turn, whether or not the agent ever needs support. So
what these tools add to your tool list is a cost that every customer's agent pays, all the time, and it comes out
of the room your own tools have. Earlier drafts had one tool per operation with every field described, and the six
came to about 4,100 tokens. These two come to about 700.

- **`support` reads and `support_send` sends.** The split is the one that matters to a client: `support` is marked
  read-only, so asking a question or reading a reply never interrupts the user, and `support_send` is a write, so
  a client that confirms writes asks before anything leaves the user's machine. One tool for everything would be a
  little smaller, and would lose that.
- **Each takes an `action`**, and the action's fields beside it at the top level. The schema lists every field by
  name and type, with the choices where there are any (`kind`, `impact`), and marks only `action` as required. It
  has no field descriptions, no length limits and no output schema. Don't use `oneOf` to give each action its own
  shape: several clients reject it at the top level of a tool's input.
- **The description holds the rules and nothing else.** What an agent has to get right even if it reads nothing
  more: when to use each action, the fields it must send, that feedback gets no reply, that a ticket needs the
  user's yes, and that no secrets or user's data go in.
- **The rest comes when it's needed.** `support` with action `guide` returns every field and rule as text, for the
  agent that is about to send something and wants the optional fields. Return it as plain text, not as a string
  inside JSON, so its line breaks arrive as line breaks. A server that only takes feedback has
  nothing to read and offers only `support_send`.
- **A wrong call is told what to send.** Check each call against the action's full shape on your server. When
  something is missing, say exactly what that action needs: "support_send with action feedback needs title (3 to
  200 characters), kind (bug, crash, ...) and description. Problem: kind is missing." The agent's next call is
  right, and it never had to carry the manual. Your MCP library may refuse a call before your code sees it, when
  `action` is missing or a value is outside its list of choices, and that error will be the library's own. Yours
  covers everything the schema leaves optional.
- **A budget.** Decide how much these tools may add to your tool list, and have a test fail above it. As a guide,
  the standard actions at level 3 with help fit in about 3,500 characters of JSON, about 800 tokens. Your own
  actions, fields and lists of choices come on top of that: don't drop something an agent needs to fit a number.
  To measure, `JSON.stringify` the two entries of your `tools/list` result and count.
- **Results are small too.** Return compact JSON. `list_tickets` returns a summary of each ticket (`id`, `title`,
  `kind`, `status`, `resolution`, `unread_count`, `updated_at`, `session`), and the long text comes with
  `get_ticket`.

## Names

- **Both names start with `support`.** They sort together, and they can't collide with your own tools: a helpdesk
  product's MCP server already has a `list_tickets`. A client that loads tools lazily shows the agent little more
  than the names, and `support` and `support_send` say what they are for.
- **Lowercase snake_case, 25 characters at most.** Some clients reject dots or hyphens in tool names, and several
  cap the server name plus the tool name at about 60 characters.
- **No product name in the tool name.** The description names the product and says the tool is only for problems
  with this product.
- **"Feedback" and "ticket" mean different things.** Feedback tells the agent that nobody will reply. Ticket tells
  it that a person will read this and answer.

## Schemas

Each operation below is an `action` of one of the two tools, and an endpoint over HTTP. The fields and their limits
are what your server checks, not what the tool's schema spells out. The field names are the design. The limits
are defaults: use your own where your product already has them, and state yours in the guide and in errors. Results are structured (`structuredContent`,
with no `outputSchema`) and repeated as compact JSON text for clients that only read text. Timestamps are ISO 8601 with an offset. Readers ignore fields they don't know, so the schemas can grow.

### `help` (optional)

Takes `question` (3-2000), and optionally the `tool` involved and the exact `error` text. Returns `answered`
(whether your documentation had anything), `answer`, `sources[]` (`{title, url}`) and `next`, a fixed line telling
the agent to send feedback or offer a ticket if the answer didn't solve the problem.

- **It is the first stop.** Much of what looks like a bug is an agent that didn't read the documentation. An answer
  on the spot is better for everyone than a ticket, and "let your agent ask for help" is an easier thing to say yes
  to than "let your agent open tickets".
- **It opens no ticket and reaches no person**, so the agent doesn't ask the user first, and the tool is marked
  read-only. You can log the questions: they show you what your documentation is missing.
- **There are two ways to build it.** The simple one is a search: index your documentation with vector embeddings
  and return the passages that best match the question, with their links. The fuller one puts a model on top: it
  retrieves the same passages and writes an answer from them. Start with the search. It can't say anything your
  documentation doesn't, it costs almost nothing to run, and an agent is good at reading passages for itself.
- **It answers from documentation and known issues only.** Whatever produces the answer, a search or an agent of
  yours, sees the question and public documentation and nothing else: no account data, no credentials, no tools.
  That is what makes it safe to leave unattended (see Safety rules).
- **It needs no sign-in**, since it reveals nothing private. Rate limit it.
- **When you have it, point at it.** The server instructions and the line on each error send the agent here first.

### `feedback`

For something that got in the way while the work still got done: a confusing error, a missing feature, wrong
documentation, a bug the agent worked around, an idea.

| Field             | Type           | Required | Notes                                                                                       |
| ----------------- | -------------- | -------- | ------------------------------------------------------------------------------------------- |
| `title`           | string, 3-200  | yes      | One line, written like an issue title                                                       |
| `kind`            | enum           | yes      | `bug`, `crash`, `wrong_result`, `confusing`, `missing_feature`, `docs`, `question`, `other` |
| `description`     | string, 1-4000 | yes      | What was tried, what was expected, what happened                                            |
| `impact`          | enum           | no       | `blocked`, `worked_around`, `friction`                                                      |
| `task`            | string, ≤200   | no       | What the user asked the agent to do                                                         |
| `request_ids`     | string[], ≤10  | no       | IDs from your error responses or results                                                    |
| `tool`            | string, ≤100   | no       | The tool involved                                                                           |
| `error`           | string, ≤4000  | no       | The exact error text                                                                        |
| `suggestion`      | string, ≤2000  | no       | What would have helped                                                                      |
| `category`        | string, ≤50    | no       | Your own sub-kinds, listed as an enum in your schema                                        |
| `source`          | enum           | no       | `user`: the user asked for this to be sent. `agent` (default): the agent noticed it itself  |
| `session`         | string, ≤100   | no       | A label the agent chooses for its work: a session ID, a branch, a task name                 |
| `agent`           | object         | no       | `{name, version, model}`, self-reported, stored as unverified                               |
| `idempotency_key` | string, ≤64    | no       | A retry with the same key returns the first record                                          |

Returns `feedback` (`{id, received_at}`), `follow_up` (a fixed line saying that nobody replies and that a ticket is
the way to get an answer) and `duplicate`.

- **Nobody replies, and it says so.** The description and the result both tell the agent, so it can tell the user
  the truth.
- **The agent doesn't ask first.** No person is waiting on it and nothing comes back, so the stakes are low. It
  sends at most once per distinct problem, and tells the user afterwards what it sent. This is how the feedback
  tools on several vendors' MCP servers already work, and it is what gets you enough reports to learn from.
- **It is still a write.** Something leaves the user's machine, so the tool is marked as a write, and a customer
  whose client confirms writes keeps control. If you would rather agents asked every time, the wording reference
  has the sentence to change.
- **It has an ID and no status.** The ID is for your records and for deduplication. There is nothing for the agent
  to check later, on purpose: a status or a response that an agent could read back would be a second, unguarded
  channel into the customer's agent.
- **When you act on it, tell the person.** If a piece of feedback leads to a fix, you can email the user who sent
  it, at the address in your own database. No agent is involved.
- **When it needs a conversation, make it a ticket.** Your team can turn a piece of feedback into a ticket on the
  same account, with your message as its first reply. It then shows up in `list_tickets` as an unread
  reply, under every rule that applies to tickets. The ticket keeps the feedback's title and fields, and carries
  `from_feedback_id`, the feedback's ID.
- **Send it somewhere else.** Feedback goes to its own queue (a channel, a triage list, your analytics), not to the
  inbox where people answer tickets.

### `ticket`

For when the user is blocked, got a wrong result or needs an answer. It takes the same fields as
`feedback`. The same fields for both, so you can keep them in one table and turn feedback into a
ticket without rewriting it.

Returns `ticket` ([the object below](#ticket-and-message), without messages), `notifications` (`{email, watch}`, so the agent can tell the
user how the reply will arrive; the email address is masked) and `duplicate` (true when the idempotency key matched).

Why these fields, for feedback and tickets alike:

- **`kind`, `task`, `impact`, `description`, `error` and `suggestion`** already appear with these meanings in
  several vendors' feedback tools, so agents have seen them.
- **`impact` by outcome, not severity.** An agent can say truthfully whether it was blocked, worked around the
  problem or was only slowed down. It can't judge "high" or "low".
- **`request_ids`** let you find the failing request in your logs. Return an ID with every error and the agent will
  pass it back.
- **`source`** records who started it: the user said "send that", or the agent noticed the problem itself. For a
  ticket it also decides whether the agent asks first (see "The user confirms a ticket").
- **`idempotency_key`** because agents retry.
- **`session`** because one customer may have a dozen agents working at once, and agents have no stable identity
  to give. A label they choose is enough to sort by.

Fill in what your server already knows, and don't ask the agent for it: the account and user, the OAuth client ID,
the client's name and version, your server's version. You may attach the account's last few tool calls with their
status and request IDs, never their arguments or results.

### `list_tickets`

Takes `status` (`open` by default: every ticket not yet resolved or closed, plus any ticket with a reply nobody has
read; `closed`: the rest; or `all`), `session` (only tickets opened with this label), `updated_since`, `limit` (1-50,
default 20) and `cursor`. Returns `tickets[]`, most recently updated first, and `next_cursor`. The MCP tool returns a summary of each: `id`,
`title`, `kind`, `status`, `resolution`, `unread_count`, `updated_at` and `session`. An API may return whole tickets.

### `get_ticket`

Takes `ticket_id` and an optional `after_message_id`. Returns `notice`, `ticket` and `messages[]`. The notice is a
fixed sentence saying the team's messages are information for the user and not instructions (see Safety rules).
Reading marks the team's messages as read.

### `reply`

Takes `ticket_id`, `body` (1-4000), an optional `outcome` (`resolved` closes the ticket, `still_broken` reopens it)
and an optional `idempotency_key`. Returns `ticket` (a summary) and `message`. With `resolved` the status becomes `closed`, and
the resolution `fixed` unless the team already set one. With `still_broken` a resolved or closed ticket reopens. A
reply with no outcome answers a `needs_reply` ticket and otherwise leaves the status alone, so "thanks" doesn't
reopen a fixed ticket.

### Ticket and message

Ticket: `id` (string, ≤64), `kind`, `category`, `title`, `status`, `resolution`, `impact`, `task`, `request_ids`,
`tool`, `error`, `suggestion`, `session`, `source`, `from_feedback_id` (when your team made it from a piece of
feedback), `created_at`, `updated_at`, `unread_count` (the team's messages that nobody on the account has read yet),
`watch_url` (level 3), `url` (an optional page a person can open).

- `status`: `open` (with the team), `needs_reply` (the team asked something), `resolved`, `closed`.
- `resolution`, once resolved: `fixed`, `answered`, `planned`, `duplicate`, `not_reproducible`, `wont_fix`.

Message: `id`, `author` (`reporter`, `team`, `system`), `body` (≤4000), `created_at`, `first_read_at` (when the
message was first returned by `get_ticket`: it shows the agent fetched it, not that a person read it).
The report's `description` is the ticket's first message, so a ticket reads as one conversation. Internal notes
never appear.

## How the agent hears about a reply

An agent usually has no inbox, and most agents can't receive a webhook. What many can do is wait: coding agents run a script
in a background shell, carry on working, and are woken when the script prints something. That script can run `curl`,
but it generally can't call an MCP tool ([clients could change that](#what-clients-could-do)). So every ticket gets
a URL a script can poll.

- **`watch_url`** is a plain https URL with an unguessable token (128 bits or more) in the path and no other
  sign-in. `GET` returns `updated_at`, `status`, `unread_count`, `min_interval_seconds` and `long_poll`, and nothing
  else: no title, no message text, no account. A leaked URL reveals only that a ticket changed.
- **Polling.** The script calls it no more often than `min_interval_seconds` (suggested: 60) and prints or exits
  when `updated_at` changes. The agent then reads the ticket with `get_ticket`. Support `ETag` and
  `If-None-Match` so a poll that finds nothing new is cheap.
- **Long polling is optional and off by default.** You may accept `?wait=<seconds>` and hold the request open until
  something changes. Only enable it on a server built to hold many idle connections at once, such as one written
  in Go or Rust. On a server with a fixed pool of threads or processes (Ruby on Rails, and most Python and PHP
  setups), each waiting request occupies a worker, so a few dozen watchers can stop your whole application from
  answering. A server without it ignores the parameter, answers at once and returns `"long_poll": false`, so a
  script never assumes the request will wait.
- **Tell the agent how.** Opening a ticket returns `notifications.watch` with the URL, the interval and one
  sentence the agent can act on: "To be told when the team replies, poll this URL in the background and call
  read the ticket (support, action get_ticket) when updated_at changes."
- **Email the person too.** The reply also goes to the signed-in user's address, so they hear when no agent is
  watching. The email address should come from your own database, never from the tool call, so the tool can't be used to send
  mail to anyone else.
- **Without either,** an agent calls `list_tickets` the next time it works with your product, and
  `unread_count` shows what changed. It doesn't have to be the agent that opened the ticket: tickets belong to the
  customer, not to an agent's session, so a later session can pick up a reply that arrived after the first one
  ended.

### What clients could do

The watch URL exists because of what coding agents can do today. A client could make it unnecessary. A coding agent
could keep an MCP tool call polling in the background, and wake up when the result changes. With that, an agent would watch a ticket by polling `list_tickets` with
`updated_since`, or `get_ticket`, signed in as usual, and no separate URL or token would be needed.

Nothing in this design has to change for that: `updated_at`, `status` and `unread_count` are already in every
ticket the tools return. Keep the watch URL for the clients that can't do it.

Webhooks and MCP's own server-sent events can be added as channels too, when clients are able to receive them.
Neither is in this version.

## Who owns a ticket

- Tickets belong to the signed-in account (you decide whether that means the user or the whole workspace), never to
  the OAuth client alone: two people using the same client must not see each other's tickets.
- Tickets are not tied to an agent or a session. Every agent working for the same customer sees the same list. An
  agent knows which tickets it opened from the IDs it was given, and watches those.
- "Read" is per account too. Once any agent has fetched a reply it no longer counts as unread, so the agent that
  fetches a reply is the one that must tell the user about it.
- When a customer runs many agents at once, the optional `session` label keeps their tickets apart: an agent sends
  the same label with each ticket it opens and filters the list by it. It is a label for sorting, chosen by the
  agent. It is not an identity: never use it to decide who may see a ticket.
- A missing ticket and another account's ticket return the same error.
- A server without sign-in can offer level 1 and, with unguessable ticket IDs (128 bits or more), let whoever holds
  an ID read and reply. It can't offer `list_tickets`.

## Getting agents to speak up

Agents rarely report unprompted, and clients that load tools lazily show them only the tools' names until they go
looking.

- **Server instructions** carry a sentence for each thing the agent can do: call `support` with action `help`
  first when a tool fails or it isn't sure how to do something; send what got in its way with `support_send`,
  action `feedback`; and when the user is blocked or needs an answer, tell them and offer to open a ticket.
- **Every error result** ends with its request ID and a line saying the same.
- **The descriptions** say: one per distinct problem; only for this product; no secrets, credentials or the
  user's data; if the call fails, carry on with the task and don't retry.

## The user confirms a ticket

A ticket lands in front of a person on your team and starts a conversation in the user's name, so the user should
have agreed to it. Feedback is different: nothing comes back and nobody is waiting, so the agent sends it and tells
the user afterwards.

- **The agent asks before it opens a ticket**, unless the user asked for it. When the agent noticed the problem
  itself, it tells the user what happened, shows every piece of text it would send (the title and description, and
  the error, task and suggestion if it filled them in), and waits for a yes. When the user said "report that", they
  have already agreed, and the agent sends it with `source: user`.
- **The same for a reply.** The agent shows the user the message before it sends a `reply`.
- **Everything that sends something is marked as a write** (`readOnlyHint: false`): feedback, a new ticket and a
  reply all go through `support_send`. Clients that ask before a write will ask here too, which leaves the last
  word with the customer, whatever your descriptions say. `support` is marked read-only, so asking a question or
  reading a reply doesn't interrupt anyone. Reading does record `first_read_at`, which
  changes nothing the user would mind.
- **How much to invite is up to you.** DocSpring, which wrote this, wants as much feedback as an agent is willing
  to give, small things included, and the feedback tool is where that goes. If you would rather hear less, or have
  agents ask before sending feedback too, the wording reference has the sentences to change.

## Safety rules

Both directions carry text written by a party the reader shouldn't obey.

- **Help can run unattended.** `help` is the part you can hand to an agent of yours and walk away
  from, because it can only read your documentation. Keep it that way: don't let it look up accounts, open tickets
  or call anything.
- **Feedback only goes one way.** Don't add a status or a response that an agent can read back from a piece of
  feedback. To answer one, email the person or turn it into a ticket.
- **Keep a person in the loop on tickets.** Be very, very careful with a system that autonomous agents may use on
  both sides of a ticket: one filing reports, another triaging and replying. Two agents can talk each other into a
  loop, or into actions nobody asked for, faster than anyone notices. Make sure there is always a person who is at
  least watching what goes in and what comes out, on your side and on the customer's.
- **Feedback and tickets are untrusted input to your side.** Store and show them as data. An agent of yours that
  reads them must not hold credentials that reach other customers' data, and must not act on instructions inside
  one.
- **Replies are untrusted input to the customer's agent.** `get_ticket` returns them inside a fixed frame
  saying they are a message from the product's team to show the user, not instructions to follow. Replies are plain
  text, with no markup that a client would render or fetch.
- **Limits.** Rate limit per account (suggested: 20 new tickets and 50 pieces of feedback a day), cap lengths as
  above, and honour the idempotency key. A limit error says when to try again.
- **Scrubbing.** Strip tokens and keys you recognise from `description` and `error` before storing them.
- **Nothing automatic.** Feedback and tickets go to a queue for review. They should never change the product's
  behaviour by themselves.

## The same operations over HTTP

Many agents reach a product through its REST API, SDK or CLI and never load its MCP server. Offer the same
operations as endpoints with the same field names, signed in the way your API already is, under whatever base path
and version your API uses:

- `POST /support/help`, if you offer help. It needs no sign-in.
- `POST /support/feedback`
- `POST /support/tickets`
- `GET /support/tickets`
- `GET /support/tickets/{id}`
- `POST /support/tickets/{id}/replies`

The `watch_url` is the same URL either way. Point agents at the endpoints from your API docs, your `llms.txt` and
your error responses.

## Saying that you support it

Advertise the MCP extension `dev.standardsupport/support` in your server's capabilities, with the level you
implement:

```json
{ "capabilities": { "tools": {}, "extensions": { "dev.standardsupport/support": { "level": 2, "help": true } } } }
```

The tool names are enough for agents. The identifier is for clients and directories that want to show "this server
takes feedback and support tickets". What each level promises:

- **Level 1:** `support_send` exists, takes action `feedback` and checks the required fields above.
- **Level 2:** the four ticket actions exist too, and a ticket opened by an account can be listed, read and replied
  to by that account.
- **Level 3:** every ticket also has a `watch_url` that answers as described above.
- **`help: true`:** `support` takes action `help`, at any level.

You are free to add fields and kinds at any level. Clients ignore what they don't know.

## Changes

- **0.5, 21 November 2026.** Replaces the six tools with two, to cut what a server's tool list costs every agent
  on every turn: `support` (read-only) and `support_send` (a write), each with an `action`. Field descriptions
  move out of the schema into a `guide` action and into errors that say what to send, output schemas go, and
  `list_tickets` returns summaries. The definitions go from about 4,100 tokens to about 700, and there is now a
  budget. The operations, their fields and the HTTP endpoints are unchanged. From measurements on
  [Talira](https://talira.ai)'s MCP server.
- **0.4, 17 November 2026.** `support_send_feedback` now takes `title`, so feedback and tickets have the same
  fields. On a ticket, `from_feedback` is now `from_feedback_id`.
- **0.3, 17 November 2026.** Feedback and tickets are now separate. `support_send_feedback` is new: one-way, sent
  without asking, with an ID and no status. `support_open_ticket` is for when the user is blocked or needs an
  answer, and still asks first. Level 1 is now the feedback tool, and tickets are level 2. A team can turn a piece
  of feedback into a ticket to answer it. The extension identifier is now `dev.standardsupport/support`.
- **0.2, 17 November 2026.** Added `support_get_help`, an optional tool that answers a question from your
  documentation without opening a ticket. `source` now has consequences: a ticket the user asked for needs no
  further confirmation, and one the agent noticed itself does. `source` is returned on the ticket. Thanks to
  scottfalconer for [posting this feedback on Hacker News](https://news.ycombinator.com/item?id=50525068).
- **0.1, 17 November 2026.** The first draft.
