import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

it('discovers only visible MCP tools on a capable route and keeps execution guarded', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeExecutor)
    ctx.llm.registerAdapter(['openai-codex'], new class extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return {
          provider, id: model, name: model,
          ...model === 'capable' ? { codexToolSearch: true as const } : {},
        }
      }
      async * stream() { yield * [] }
    }())
    const id = SessionId('discovery')
    const session = Session.create(id)
    const agent = { id, session } as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
    let calls = 0
    const register = (name: string, discoverable?: true) => ctx.tools.register(defineTool({
      name, description: 'Read a synthetic inventory record.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { calls++; return 'done' },
    }), discoverable ? { discoverable } : {})
    register('read')
    register('mcp__inventory__read', true)
    register('mcp__inventory__hidden', true)
    scope.ctx.tools.restrict({ deny: ['mcp__inventory__hidden'] })
    const signal = new AbortController().signal
    const resolve = (model: string) => ctx.tools.resolve({ agent, modelSelection: { provider: 'openai-codex', model }, signal })
    const names = (set: Awaited<ReturnType<typeof resolve>>) => ctx.tools.schemas(agent, set).map(tool => tool.name)
    const initial = await resolve('capable')
    expect(names(initial).sort()).toEqual(['read', 'tool_search'])
    const execute = (name: string, toolSet: typeof initial, args = {}) => executeToolFixture(ctx, {
      callId: ToolCallId(name), name, arguments: args, signal, agent, toolSet,
    })
    expect((await execute('mcp__inventory__read', initial)).error?.info?.code).toBe('UNKNOWN_TOOL')
    const result = await execute('tool_search', initial, { query: 'inventory' })
    expect(result.isError).toBe(false)
    expect(result.additionalContexts).toHaveLength(1)
    for (const message of result.additionalContexts ?? []) {
      session.append('user/message', message, { surfaceOp: 'append' })
    }
    initial.dispose()
    const next = await resolve('capable')
    expect(names(next).sort()).toEqual(['mcp__inventory__read', 'read', 'tool_search'])
    expect((await execute('mcp__inventory__read', next)).isError).toBe(false)
    expect(calls).toBe(1)
    expect(names(await resolve('unsupported')).sort()).toEqual(['mcp__inventory__read', 'read'])
  } finally {
    await ctx.fiber.dispose()
  }
})
