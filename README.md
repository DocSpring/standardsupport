# Standard Support

A convention for how AI agents ask for support. Let a customer's AI agent ask for help, send feedback, or open a ticket
with your team and pick up the reply, even in a later session.

**Read it at [standardsupport.dev](https://standardsupport.dev).** The whole thing is on one page: an example, why,
the spec, questions and adopters.

When a customer's agent uses your product through its MCP server or API and hits a bug, a wrong result or a tool
that can't do what was asked, it works around the problem or gives up. Standard Support is a written-down set of
decisions for fixing that: what to call the tools, which fields to ask for, how a reply reaches an agent that
usually has no inbox, who owns a ticket, and how to keep injected text from steering either side.

An agent can do three things, each with its own rules:

- **Ask for help** (optional): a question answered from your documentation. No ticket.
- **Send feedback**: something got in the way and the work carried on. Nobody replies.
- **Open a ticket**, then list tickets, read one and reply: the user is blocked or needs an answer, and a person on your team replies.

An MCP server offers all of it through two small tools, `support` (reads) and `support_send` (sends), which add
about 700 tokens to its tool list. The same operations work over HTTP, and each ticket has a status URL that a background script can poll. You can stop
after the feedback tool.

Nothing breaks if you implement this differently. Agents read each tool's description, so this doesn't need
everyone to agree. You can adopt what works for your product and extend it however you like.

**Status: draft 0.5, published early for feedback.** Names and fields may still change. DocSpring is the first
adopter ([ADOPTERS.md](ADOPTERS.md)). What changed between drafts is in the spec's
[Changes](spec/README.md#changes) section.

## What's here

| Path                         | Contents                                                         | Licence |
| ---------------------------- | ---------------------------------------------------------------- | ------- |
| `spec/`                      | The design: tools, fields, the watch URL, safety rules, and why  | CC0     |
| `skills/standard-support/`   | An agent skill that builds Standard Support into your MCP server | MIT     |
| `examples/reference-server/` | A small working server in TypeScript, with tests                 | MIT     |
| `site/`                      | The source of standardsupport.dev: one page, built from the spec | MIT     |
| `ADOPTERS.md`                | Products that have shipped it; add yours by pull request         |         |

## Add it to your product

Point your coding agent at the skill (`skills/standard-support/`) and ask it to add Standard Support to your MCP
server. It reads your codebase, asks what it can't work out, and builds the tools, the storage, the watch URL and the
tests in your own stack.

Or read the [spec](spec/README.md) and the [reference server](examples/reference-server/) and build it yourself.

## Feedback

This is a draft, and we want to know what is wrong with it, what is missing and what you would do differently:

- Open an issue here
- Reply in the [Hacker News thread](https://news.ycombinator.com/item?id=50524768)
- Mention [@DocSpring](https://x.com/DocSpring) on X
- Write to hello@standardsupport.dev

Changes that came from feedback are credited in the spec's [Changes](spec/README.md#changes) section.

## Working on this repo

- **The spec** is `spec/README.md`. The skill carries a copy so that it works when installed by itself: after
  changing the spec, run `scripts/sync_skill_spec`.
- **The wording agents see** (tool descriptions, the server instruction, the error line) lives in
  `examples/reference-server/tools.ts` and `skills/standard-support/references/descriptions.md`. Change both
  together: a test fails when they differ.
- **The reference server**: `cd examples/reference-server && npm install && npm test && npm run typecheck`. It
  needs Node 24 (`mise.toml` pins it), which runs the TypeScript files directly.
- **The site**: `cd site && npm install && npm run build` writes `site/dist/`, and `npm run serve` shows it at
  http://127.0.0.1:4321/. It renders `spec/README.md` and `ADOPTERS.md` into the page, so neither is copied by hand,
  and writes the whole page as Markdown too (`/index.md`). The Hacker News and X links in the Feedback section come
  from `site/src/links.json`. The link preview image is `site/og/og.html`, rendered to `site/src/og.png` by
  `site/og/render`. The fonts in `site/src/fonts/` are under the SIL Open Font License.
- **Publishing**: every push to `main` runs the checks and publishes the site to standardsupport.dev through GitHub
  Pages (`.github/workflows/site.yml`).

Made by [DocSpring](https://docspring.com).
