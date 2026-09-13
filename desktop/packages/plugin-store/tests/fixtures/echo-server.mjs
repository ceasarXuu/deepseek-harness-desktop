/**
 * A dependency-free MCP server over stdio, the shape a real bundle ships: one
 * self-contained entry point, no node_modules, nothing but the protocol.
 *
 * It exists so the store's tests exercise the real install-then-mount path —
 * bundle validation, extraction, spawn, discovery, and a tool call across a
 * process boundary — without depending on a published package.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdio, MCP's own framing.
 */

const TOOLS = [
  {
    name: 'echo',
    description: 'Returns the text it was given.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to return' } },
      required: ['text'],
    },
  },
  {
    name: 'sum',
    description: 'Adds two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
]

/** Answer one tool call. */
function call(name, args) {
  if (name === 'echo') return `echo: ${String(args?.text ?? '')}`
  if (name === 'sum') return String(Number(args?.a ?? 0) + Number(args?.b ?? 0))
  throw new Error(`unknown tool ${name}`)
}

/** Write one JSON-RPC message. */
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline === -1) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line === '') continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    if (request.id === undefined) continue
    if (request.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'store-fixture', version: '1.0.0' },
        },
      })
      continue
    }
    if (request.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } })
      continue
    }
    if (request.method === 'tools/call') {
      const { name, arguments: args } = request.params ?? {}
      try {
        write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: call(name, args) }] } })
      } catch (error) {
        write({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true },
        })
      }
      continue
    }
    write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } })
  }
})
process.stdin.on('end', () => { process.exit(0) })
