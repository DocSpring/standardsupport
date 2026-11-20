// Prints the size of each support tool's definition as a client receives it from tools/list.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AddressInfo } from 'node:net'
import { createApp } from './server.ts'

let baseUrl = ''
const app = createApp({ baseUrl: () => baseUrl })
await new Promise<void>((resolve) => app.listen(0, resolve))
baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
const client = new Client({ name: 'measure', version: '0' })
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: 'Bearer demo-token-alice' } },
  }),
)
const { tools } = await client.listTools()
let total = 0
for (const tool of tools.filter((t) => t.name.startsWith('support'))) {
  const all = JSON.stringify(tool).length
  const noOut = JSON.stringify({ ...tool, outputSchema: undefined }).length
  total += all
  console.log(tool.name.padEnd(28), String(all).padStart(6), 'chars', String(noOut).padStart(6), 'without outputSchema', String(tool.description?.length).padStart(5), 'description')
}
console.log('total'.padEnd(28), String(total).padStart(6))
console.log('instructions', client.getInstructions()?.length)
if (process.argv[2]) (await import('node:fs')).writeFileSync(process.argv[2], JSON.stringify(tools.filter((t) => t.name.startsWith('support')), null, 1))
await client.close()
app.close()
