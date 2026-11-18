# Who has adopted Standard Support

Products whose MCP server or API has the Standard Support tools, in alphabetical order. Entries are added by their
makers and have not been checked for conformance.

| Product                            | What it is                                                            | Level    | Since      | Proof                                                               |
| ---------------------------------- | --------------------------------------------------------------------- | -------- | ---------- | ------------------------------------------------------------------- |
| [DocSpring](https://docspring.com) | An API that fills PDFs, generates documents and collects e-signatures | 3 + help | 2026-11-18 | [Docs](https://docspring.com/docs/api-guide/support-for-ai-agents/) |

DocSpring wrote Standard Support and is its first adopter:
[how we built it](https://docspring.com/blog/posts/standard-support-ai-agent-tickets/). The spec is still a draft,
published early to see what other people think and collect feedback.

## Adding yours

Open a pull request that adds one row to the table, in alphabetical order:

- **Product**: its name, linked to its home page.
- **What it is**: a few plain words. No adjectives like "the best" or "leading".
- **Level**: 1 (feedback), 2 (tickets too) or 3 (the watch URL too). Add "+ help" if you have `support_get_help`.
- **Since**: the date it shipped, as `YYYY-MM-DD`.
- **Proof**: a link to the release notes, docs page or commit that shows the tools.

Only products that have shipped it. A row without a proof link won't be merged.
