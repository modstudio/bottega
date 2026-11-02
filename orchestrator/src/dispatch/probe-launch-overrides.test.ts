import { expect, test } from 'bun:test'
import { readonlyInfrastructurePrompt } from '../run/run-readonly-infrastructure.ts'
import {
  decideProbeLaunchOverrides,
  probeContextLimitEnvironment,
  readerPromptFindings,
} from './probe-launch-overrides.ts'

const decide = (input: Partial<Parameters<typeof decideProbeLaunchOverrides>[0]> = {}) =>
  decideProbeLaunchOverrides({
    probe: true,
    contextLimit: undefined,
    readerSuites: false,
    agentHarness: 'goose',
    findings: true,
    ...input,
  })

test('probe launch overrides are accepted only for their approved launch shapes', () => {
  expect(decide({ probe: false, contextLimit: 'served' })).toMatchObject({
    accepted: false,
    refusal: expect.stringContaining('add --probe'),
  })
  expect(decide({ probe: false, readerSuites: true })).toMatchObject({
    accepted: false,
    refusal: expect.stringContaining('add --probe'),
  })
  expect(decide({ contextLimit: 'served' })).toEqual({
    accepted: true,
    contextLimit: 'served',
    readerSuites: false,
  })
  expect(decide({ readerSuites: true })).toEqual({
    accepted: true,
    contextLimit: undefined,
    readerSuites: true,
  })
  expect(decide({ contextLimit: '120000', agentHarness: 'codex' })).toMatchObject({
    accepted: false,
    refusal: expect.stringContaining('selected harness is codex'),
  })
  expect(decide({ contextLimit: '120000', agentHarness: null })).toMatchObject({
    accepted: false,
    refusal: expect.stringContaining('requires --agent'),
  })
  expect(decide({ readerSuites: true, findings: false })).toMatchObject({
    accepted: false,
    refusal: expect.stringContaining('requires a findings job'),
  })
  expect(decide({ contextLimit: 'twelve' })).toMatchObject({
    accepted: false,
    refusal: expect.stringContaining('positive integer'),
  })
})

test('reader suites switch only the findings reader preamble wording', () => {
  const infrastructure = {
    readsRepo: true,
    writesRepo: false,
    readonlyCreate: false,
    readOnlyBase: '/runs/probe',
    mainCheckout: '/projects/main',
    regularNotes: '',
    generatedNotes: '',
  }
  expect(
    readonlyInfrastructurePrompt({
      ...infrastructure,
      findings: readerPromptFindings(true, true),
    }),
  ).toContain('record what you could not run in could_not_verify')
})

test('served context overrides require and use the declared served window', () => {
  expect(probeContextLimitEnvironment('served', 200_000)).toEqual({
    GOOSE_CONTEXT_LIMIT: '200000',
  })
  expect(() => probeContextLimitEnvironment('served', null)).toThrow(
    'requires the selected Goose agent to declare its served window',
  )
})
