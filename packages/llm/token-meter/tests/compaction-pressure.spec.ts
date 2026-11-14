import { expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { estimateMessage } from '../src/estimate.ts'
import { contextPressureProjectionDefinition as projection } from '../src/usage-projection.ts'

it('prices regenerated context once when a compaction shadows its latest snapshot', () => {
  const oldCatalog = createUserMessage({
    source: { kind: 'runtime-context', form: 'snapshot', sections: [] } as UserMessage['source'],
    content: [{ type: 'text', text: 'old catalog '.repeat(100) }],
  })
  const refreshedCatalog = createUserMessage({
    source: { kind: 'runtime-context', form: 'snapshot', sections: [] } as UserMessage['source'],
    content: [{ type: 'text', text: 'fresh catalog '.repeat(110) }],
  })
  const summary = createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'summary' }],
  })
  const oldPrice = estimateMessage(oldCatalog)
  const newPrice = estimateMessage(refreshedCatalog)
  const summaryPrice = estimateMessage(summary)
  const start = SessionSeq(1)
  const append = (seq: number, message: typeof oldCatalog): SessionEvent => ({
    seq: SessionSeq(seq), time: 0, type: 'user/message', data: message, surfaceOp: 'append',
  })
  const usage = (seq: number, tokens: number): SessionEvent => ({
    seq: SessionSeq(seq), time: 0, type: 'assistant/attempt',
    data: { turn: 1, step: 1, stream: [
      { type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: tokens, outputTokens: 10 } } },
    ] },
  })
  const events: SessionEvent[] = [
    append(1, oldCatalog),
    usage(2, 2000),
    {
      seq: SessionSeq(3), time: 0, type: 'compaction/summary',
      data: {
        compactionId: CompactionId('pressure-regeneration'),
        summary: summary.content,
        shadowedRange: { start, end: start },
        shadowedSeqs: [start],
        shadowedTokenCount: oldPrice,
        provider: 'mock',
        model: 'mock',
      },
    },
    {
      seq: SessionSeq(4), time: 0, type: 'user/message', data: summary,
      surfaceOp: { op: 'replace', startSeq: start, endSeq: start }, sourceEventSeqs: [start],
    },
    append(5, refreshedCatalog),
    usage(6, 2020),
  ]
  let state = projection.init()
  const outputs = events.map((event) => {
    state = projection.apply(state, event)
    return projection.wire.view(state)
  })
  expect(outputs[2]?.projectedTokens).toBe(2000)
  expect(outputs[3]).toEqual({ pressureTokens: 2000, projectedTokens: 2000 + summaryPrice })
  expect(outputs[4]).toEqual({ pressureTokens: 2000, projectedTokens: 2000 - oldPrice + summaryPrice + newPrice })
  expect(outputs[5]).toEqual({ pressureTokens: 2020, projectedTokens: 2020 })
})
