import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { observeRetrievalPins, staleRetrievalPinConditions } from './monitor-retrieval-pins.ts'

const stalePinReport = JSON.stringify({
  pins: [
    {
      queryId: 'stale-pin',
      doc: 'doc:project/sample/guide',
      docSlug: 'guide',
      excerpt: 'stale excerpt',
      revision: 'revision-8',
      current: false,
    },
  ],
})

describe('default checkout lookup', () => {
  let originalCwd = ''

  beforeEach(() => {
    originalCwd = process.cwd()
    process.chdir('/')
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  test('finds this checkout when the process runs outside it', () => {
    let runnerCalled = false
    const result = observeRetrievalPins(undefined, () => {
      runnerCalled = true
      return { exitCode: 0, stdout: JSON.stringify({ pins: [] }), stderr: '' }
    })

    expect(runnerCalled).toBe(true)
    expect(result).toEqual({ conditions: [], errors: [], notApplicable: [] })
  })
})

test('a distribution install reports retrieval pins as not applicable without spawning', () => {
  let runnerCalled = false
  const result = observeRetrievalPins(
    () => null,
    () => {
      runnerCalled = true
      return { exitCode: 0, stdout: stalePinReport, stderr: '' }
    },
  )

  expect(result).toEqual({
    conditions: [],
    errors: [],
    notApplicable: [
      'retrieval benchmark pin observation not applicable: this install has no source checkout, and document pin checking needs its benchmark fixtures',
    ],
  })
  expect(runnerCalled).toBe(false)
})

test('an empty stale-pin report carries the child stderr instead of a JSON parse error', () => {
  const result = observeRetrievalPins(
    () => '/checkout',
    () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'first detail\nerror: document pin checking needs its benchmark fixtures\n',
    }),
  )

  expect(result.conditions).toEqual([])
  expect(result.notApplicable).toEqual([])
  expect(result.errors).toHaveLength(1)
  expect(result.errors[0]).toContain('error: document pin checking needs its benchmark fixtures')
  expect(result.errors[0]).toContain(
    `cleared by: ${PLATFORM_SLUG} __retrieval-search --check-doc-pins`,
  )
  expect(result.errors[0]).not.toContain('Unexpected EOF')
})

test('exit one with a valid report remains a stale-pin condition', () => {
  const result = observeRetrievalPins(
    () => '/checkout',
    () => ({ exitCode: 1, stdout: stalePinReport, stderr: '' }),
  )

  expect(result.errors).toEqual([])
  expect(result.notApplicable).toEqual([])
  expect(result.conditions).toEqual([
    {
      kind: 'stale-retrieval-benchmark-pin',
      subject: 'stale-pin',
      since: null,
      ageMs: null,
      detail: 'stale-pin excerpt is absent from guide at revision revision-8: "stale excerpt"',
      action:
        'repin stale-pin by hand in retrieval/src/benchmark/queries.ts after deciding what the query should retrieve',
    },
  ])
})

test('stale retrieval pins become report-only monitor conditions', () => {
  expect(
    staleRetrievalPinConditions({
      pins: [
        {
          queryId: 'current-pin',
          doc: 'doc:project/sample/guide',
          docSlug: 'guide',
          excerpt: 'current excerpt',
          revision: 'revision-8',
          current: true,
        },
        {
          queryId: 'stale-pin',
          doc: 'doc:project/sample/guide',
          docSlug: 'guide',
          excerpt: 'stale excerpt',
          revision: 'revision-8',
          current: false,
        },
      ],
    }),
  ).toEqual([
    {
      kind: 'stale-retrieval-benchmark-pin',
      subject: 'stale-pin',
      since: null,
      ageMs: null,
      detail: 'stale-pin excerpt is absent from guide at revision revision-8: "stale excerpt"',
      action:
        'repin stale-pin by hand in retrieval/src/benchmark/queries.ts after deciding what the query should retrieve',
    },
  ])
})
