# Reference server

A small made-up product, "Acme Orders", with Standard Support added. About 800 lines of JavaScript with no
framework, meant to be read and copied from.

| File              | What's in it                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `store.js`        | Tickets, messages and the rules: ownership, limits, idempotency, scrubbing, the watch data |
| `tools.js`        | The four `support_*` MCP tools, their descriptions and schemas                            |
| `server.js`       | `/mcp`, the same operations as REST endpoints, the watch URL, a team endpoint             |
| `watch.sh`        | The background watcher an agent runs to hear about a reply                                |
| `support.test.js` | Tests that use the server as an agent, a watcher and the team would                       |
| `wording.test.js` | Fails when the skill's wording and this server's tool descriptions drift apart            |

## Run it

```sh
npm install
npm start        # http://localhost:8787/mcp
npm test
```

Sign-in is a fixed table of demo tokens: `demo-token-alice` and `demo-token-bob` for customers, `demo-team-key` for
the team. Everything is kept in memory.

## Try it

Connect an MCP client to `http://localhost:8787/mcp` with the header `Authorization: Bearer demo-token-alice`, and
ask the agent to look up order 999. The lookup fails with a request ID and a line pointing at `support_open_ticket`.

Or use the HTTP endpoints:

```sh
# The customer's agent opens a ticket
curl -s localhost:8787/support/tickets \
  -H 'Authorization: Bearer demo-token-alice' -H 'Content-Type: application/json' \
  -d '{"kind":"bug","title":"lookup_order fails for order 999","description":"It says the order could not be loaded.","request_ids":["req_123"]}'

# ...and waits for a reply in the background
./watch.sh http://localhost:8787/support/watch/w_...

# The team replies
curl -s localhost:8787/team/tickets/tkt_.../replies \
  -H 'Authorization: Bearer demo-team-key' -H 'Content-Type: application/json' \
  -d '{"body":"Fixed, please try again.","status":"resolved","resolution":"fixed"}'
```

`watch.sh` polls once a minute, so it prints within a minute of the reply.

## What it leaves out

- **Real sign-in.** Replace `accountFromToken` in `server.js` with your own.
- **A database.** `SupportStore` keeps Maps in memory.
- **Email to the user** when the team replies. Send it from wherever `teamReply` is called.
- **Long polling** on the watch URL. This server answers at once and says `"long_poll": false`. Only add it on a
  server built to hold many idle connections.
- **A support inbox.** The `/team` endpoints stand in for your admin page or helpdesk.
