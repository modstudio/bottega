import { expect, test } from 'bun:test'
import { builtInsIdentity } from './record-built-ins-identity.ts'

const catalogue = (question: string, slots: string) => ({
  lenses: [['correctness', 'Correctness', question, 'style']],
  lensSlots: slots,
  lensDefaultProfile: '{"body":"default"}',
  workflows: {
    stepCatalogue: { slug: 'shared', definition: '{"steps":[]}', reason: 'seed r1' },
    workflows: [{ slug: 'ship', definition: '{"a":1,"b":2}', reason: 'seed r1' }],
  },
})

test('the built-ins identity changes with content and ignores key order', () => {
  const base = builtInsIdentity(catalogue('Is it right?', '{"type":"object","extra":true}'))
  expect(builtInsIdentity(catalogue('Is it right?', '{"extra":true,"type":"object"}'))).toBe(base)
  expect(builtInsIdentity(catalogue('Is it wrong?', '{"type":"object","extra":true}'))).not.toBe(
    base,
  )
  const changedWorkflow = catalogue('Is it right?', '{"type":"object","extra":true}')
  changedWorkflow.workflows.workflows[0]!.definition = '{"a":1,"b":3}'
  expect(builtInsIdentity(changedWorkflow)).not.toBe(base)
})
