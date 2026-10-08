import { describe, expect, test } from 'bun:test'
import { INSTRUCTION_VERSION } from './contract.ts'
import type { Chunk } from './corpus/chunks.ts'
import { planRefresh } from './refresh-plan.ts'

const chunk = (id: string): Chunk => ({
  id,
  path: 'doc:project/p/doc',
  identity: { kind: 'doc', scope: 'project', subject: 'p', slug: 'doc' },
  startLine: 1,
  endLine: 1,
  text: id,
  docTitle: 'Doc',
  headingPath: [],
})

const stored = (
  chunkId: string,
  contentHash: string,
  overrides: Partial<{ model: string; dimension: number; instructionVersion: string }> = {},
) => ({
  chunkId,
  contentHash,
  model: 'Qwen/Qwen3-Embedding-0.6B',
  dimension: 1_024,
  instructionVersion: INSTRUCTION_VERSION,
  ...overrides,
})

describe('retrieval refresh plan', () => {
  test('plans new, changed, vanished, unchanged, and contract-mismatch rows', () => {
    const current = [
      { chunk: chunk('new'), contentHash: 'new-hash' },
      { chunk: chunk('changed'), contentHash: 'changed-hash' },
      { chunk: chunk('same'), contentHash: 'same-hash' },
      { chunk: chunk('contract'), contentHash: 'contract-hash' },
    ]
    const plan = planRefresh(current, [
      stored('changed', 'old-hash'),
      stored('same', 'same-hash'),
      stored('contract', 'contract-hash', { instructionVersion: 'old' }),
      stored('vanished', 'gone'),
    ])

    expect(
      plan.embed.map(({ chunk: value, observed }) => ({
        id: value.id,
        observed,
      })),
    ).toEqual([
      {
        id: 'changed',
        observed: {
          contentHash: 'old-hash',
          model: 'Qwen/Qwen3-Embedding-0.6B',
          dimension: 1_024,
          instructionVersion: INSTRUCTION_VERSION,
        },
      },
      {
        id: 'contract',
        observed: {
          contentHash: 'contract-hash',
          model: 'Qwen/Qwen3-Embedding-0.6B',
          dimension: 1_024,
          instructionVersion: 'old',
        },
      },
      { id: 'new', observed: null },
    ])
    const { chunkId: _, ...vanishedIdentity } = stored('vanished', 'gone')
    expect(plan.delete).toEqual([{ chunkId: 'vanished', observed: vanishedIdentity }])
    expect(plan.unchanged).toEqual(['same'])
  })
})
