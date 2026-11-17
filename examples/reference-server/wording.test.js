// The wording agents see lives in two places: this server's code and the skill's descriptions.md. This fails when
// they drift apart.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { SupportStore } from './store.js'
import { errorNudge, registerSupportTools, supportInstructions } from './tools.js'

test("the skill's descriptions.md has the same wording as the tools this server registers", async () => {
  const markdown = await readFile(
    new URL('../../skills/standard-support/references/descriptions.md', import.meta.url),
    'utf8',
  )
  // Every quoted block ("> ...") in the document, as one line each.
  const quoted = [...markdown.matchAll(/(?:^> .*\n?)+/gm)].map((match) =>
    match[0].replace(/^> ?/gm, '').replace(/\s+/g, ' ').trim(),
  )
  const asWritten = (text) => text.replace(/\s+/g, ' ').trim().replaceAll('Acme', '{product}')

  const registered = {}
  registerSupportTools({ registerTool: (name, config) => (registered[name] = config) }, new SupportStore(), {
    product: 'Acme',
    baseUrl: 'https://example.com',
    account: () => undefined,
    help: async () => undefined,
  })

  // The document quotes the full versions (with help and tickets). A server without one of them drops its sentence.
  const inCode = {
    'the server instructions': supportInstructions('Acme', { help: true }),
    'the error line': errorNudge('Acme', '{request_id}', { help: true }),
    ...Object.fromEntries(Object.entries(registered).map(([name, config]) => [name, config.description])),
  }
  assert.equal(Object.keys(registered).length, 6)
  for (const [name, text] of Object.entries(inCode)) {
    assert.ok(quoted.includes(asWritten(text)), `descriptions.md is out of date for ${name}: ${asWritten(text)}`)
  }
})
