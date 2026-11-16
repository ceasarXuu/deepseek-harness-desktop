import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolActivationContext, ToolDefinition } from './contracts.ts'
import { defineTool } from './schema.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-discovery': { kind: 'tool-discovery'; names: readonly string[] }
  }
}

export function discoveredTools(context: ToolActivationContext): Set<string> {
  const names = new Set<string>()
  for (const message of [...context.agent.session.deriveMessages(), ...context.messages ?? []]) {
    if (message.role !== 'user' || message.source.kind !== 'tool-discovery') continue
    if (!Array.isArray(message.source.names)) continue
    for (const name of message.source.names) if (typeof name === 'string') names.add(name)
  }
  return names
}

export function createToolSearch(candidates: (context: ToolActivationContext['agent']) => readonly ToolDefinition[]) {
  return defineTool({
    name: 'tool_search',
    description: 'Search available MCP tools by name or task keywords. Matching tools become callable on the next step.',
    parameters: { query: { type: 'string', required: true, description: 'Keywords describing the tool needed.' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute({ query }, exec) {
      if (!exec.agent) return 'Tool search requires a session.'
      const normalizedQuery = query.trim().toLowerCase()
      const tools = candidates(exec.agent)
      const exact = tools.find(tool => tool.name.toLowerCase() === normalizedQuery)
      const words = [...new Set(normalizedQuery.match(/[\p{L}\p{N}]+/gu) ?? [])]
      const ranked = exact ? [{ name: exact.name, score: 1 }] : tools.map((tool) => {
        const name = tool.name.toLowerCase()
        const metadata = tool.description.toLowerCase()
        const score = words.reduce((sum, word) => sum + (name.includes(word) ? 3 : metadata.includes(word) ? 1 : 0), 0)
        return { name: tool.name, score }
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      const best = ranked[0]?.score ?? 0
      const names = ranked.filter(item => item.score >= best / 2).slice(0, 8).map(item => item.name)
      if (names.length === 0) return 'No matching MCP tools.'
      const text = `MCP tools available on the next step: ${names.join(', ')}`
      exec.deferContext(createUserMessage({
        source: { kind: 'tool-discovery', names },
        content: [{ type: 'text', text }],
      }))
      return text
    },
  })
}
