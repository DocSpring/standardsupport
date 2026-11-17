// The wording agents see lives in two places: this server's code and the skill's descriptions.md. This fails when
// they drift apart.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { SupportStore } from './store.ts'
import { errorNudge, registerSupportTools, supportInstructions } from './tools.ts'

test("the skill's descriptions.md has the same wording as the tools this server registers", async () => {
  const markdown = await readFile(
    new URL('../../skills/standard-support/references/descriptions.md', import.meta.url),
    'utf8',
  )
  // Every quoted block ("> ...") in the document, as one line each.
  const quoted = [...markdown.matchAll(/(?:^> .*\n?)+/gm)].map((match) =>
    match[0].replace(/^> ?/gm, '').replace(/\s+/g, ' ').trim(),
  )
  const asWritten = (text: string) => text.replace(/\s+/g, ' ').trim().replaceAll('Acme', '{product}')

  // Stands in for an MCP server and keeps what was registered on it.
  const registered: Record<string, string> = {}
  const recorder = {
    registerTool: (name: string, config: { description?: string }) => {
      registered[name] = config.description ?? ''
    },
  } as unknown as McpServer
  registerSupportTools(recorder, new SupportStore(), {
    product: 'Acme',
    baseUrl: 'https://example.com',
    account: () => undefined,
    help: async () => undefined,
  })

  // The document quotes the full versions (with help and tickets). A server without one of them drops its sentence.
  const inCode = {
    'the server instructions': supportInstructions('Acme', { help: true }),
    'the error line': errorNudge('Acme', '{request_id}', { help: true }),
    ...registered,
  }
  assert.equal(Object.keys(registered).length, 6)
  for (const [name, text] of Object.entries(inCode)) {
    assert.ok(quoted.includes(asWritten(text)), `descriptions.md is out of date for ${name}: ${asWritten(text)}`)
  }
})
