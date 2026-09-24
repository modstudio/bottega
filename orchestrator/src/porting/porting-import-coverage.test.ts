import { describe, expect, test } from 'bun:test'
import { planImport, sourceCoverage } from './porting-import.ts'

describe('port importer', () => {
  const fixture = (
    overrides: Partial<
      Record<'doctrine' | 'differences' | 'backports' | 'refs' | 'state' | 'projects', string>
    > = {},
  ) => ({
    doctrine:
      '# Doctrine\n\nPreface text.\n\n1. **Keep the whole rule** Opening sentence.\nContinuation line.\nA known final item at the end of the rule.\n',
    differences:
      '# Differences\n\n## Stack mapping (how to translate, not a reason to skip)\nMap body.\n\n## Per-project uniques\n\n### alpha-invented\nAlpha body.\n\n### Shared deployment constraint\nUnassigned body.\n\n### beta-invented\nBeta body.\n\n## Process differences\nProcess body.\n',
    backports:
      '# Backports\n\n## -> alpha-invented\n' +
      'A long backport body. '.repeat(20) +
      '\nKnown final checkbox.\n\n## -> beta-invented\nBeta backport.\n',
    refs: JSON.stringify({
      'BET-7': {
        source: 'alpha-invented',
        commits: ['abc'],
        paths: ['src/a.ts'],
        notes: 'Native notes.',
      },
    }),
    state: JSON.stringify({
      pairs: {
        'alpha-invented->beta-invented': {
          lastPortedSha: 'abc',
          scannedAt: '2026-01-01',
          skipped: [{ feature: 'old feature', reason: 'superseded', raiseAgain: false }],
        },
      },
    }),
    projects:
      '# Projects\n\n## Category map\nCategories.\n\n## Reference implementations (deepest instance = default port source)\nReferences.\n',
    ...overrides,
  })
  test('every non-whitespace source span in synthetic port files is accounted for', () => {
    const files = fixture({
      refs: JSON.stringify({
        _format: 'invented ledger shape',
        'BET-7': {
          source: 'alpha-invented',
          commits: ['abc'],
          paths: ['src/a.ts'],
          notes: 'Native notes.',
        },
        'BET-8': {
          source: 'alpha-invented + gamma-invented',
          commits: ['def'],
          paths: ['src/b.ts'],
          notes: 'Two sources.',
        },
      }),
    })
    const state = JSON.parse(files.state)
    state.pairs['gamma-invented->beta-invented'] = {
      lastPortedSha: 'def',
      scannedAt: '2026-01-02',
      skipped: [],
    }
    files.state = JSON.stringify(state)
    const projectNames = [
      ...new Set(Object.keys(state.pairs).flatMap((pair) => pair.split('->'))),
    ] as string[]
    const refs = JSON.parse(files.refs)
    const prefixes = [
      ...new Set(
        Object.keys(refs)
          .filter((key) => !key.startsWith('_'))
          .map((key) => key.split('-')[0])
          .filter((prefix): prefix is string => prefix !== undefined),
      ),
    ]
    const syntheticRegister = projectNames.map((name, index) => ({
      id: index + 1,
      name,
      path: `/fixture/${index}`,
      stack: null,
      canon: false,
      retiredAt: null,
      settings: index === 0 ? { keyPrefixes: prefixes } : {},
    }))
    const plan = planImport(files, syntheticRegister)
    expect(plan.refusals).toEqual([])
    expect(sourceCoverage(plan, files)).toEqual([])

    const wrongId = structuredClone(plan)
    wrongId.refs[0]!.sources[0]!.source_project_id = 999999
    expect(sourceCoverage(wrongId, files)).toContainEqual({
      file: 'refs.json',
      offset: 0,
      text: files.refs,
    })

    const duplicatedSource = structuredClone(plan)
    const multiSource = duplicatedSource.refs.find((ref) => ref.sources.length > 1)!
    multiSource.sources[0] = structuredClone(multiSource.sources[1]!)
    expect(sourceCoverage(duplicatedSource, files)).toContainEqual({
      file: 'refs.json',
      offset: 0,
      text: files.refs,
    })

    const repeatedSkipState = JSON.parse(files.state) as {
      pairs: Record<string, { skipped: unknown[] }>
    }
    const [repeatedPairKey, repeatedPair] = Object.entries(repeatedSkipState.pairs).find(
      ([, pair]) => Array.isArray(pair.skipped) && pair.skipped.length > 0,
    )!
    repeatedPair.skipped.push(structuredClone(repeatedPair.skipped[0]))
    const repeatedSkipFiles = { ...files, state: JSON.stringify(repeatedSkipState) }
    const missingRepeatedSkip = planImport(repeatedSkipFiles, syntheticRegister)
    const repeatedRows = missingRepeatedSkip.skips
      .map((skip, index) => ({ skip, index }))
      .filter(({ skip }) => skip.pairKey === repeatedPairKey)
    missingRepeatedSkip.skips.splice(repeatedRows.at(-1)!.index, 1)
    expect(sourceCoverage(missingRepeatedSkip, repeatedSkipFiles)).toContainEqual({
      file: 'state.json',
      offset: 0,
      text: repeatedSkipFiles.state,
    })

    plan.docs = plan.docs.filter((doc) => doc.slug !== 'port-import-source-context')
    expect(sourceCoverage(plan, files)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: expect.stringMatching(/\.md$/),
          offset: expect.any(Number),
          text: expect.any(String),
        }),
      ]),
    )

    const jsonPlan = planImport(files, syntheticRegister)
    jsonPlan.docs = jsonPlan.docs.filter((doc) => doc.slug !== 'port-state-metadata')
    expect(sourceCoverage(jsonPlan, files)).toContainEqual({
      file: 'state.json',
      offset: 0,
      text: files.state,
    })
    jsonPlan.docs = planImport(files, syntheticRegister).docs.filter(
      (doc) => doc.slug !== 'port-ref-metadata',
    )
    expect(sourceCoverage(jsonPlan, files)).toContainEqual({
      file: 'refs.json',
      offset: 0,
      text: files.refs,
    })
  })
})
