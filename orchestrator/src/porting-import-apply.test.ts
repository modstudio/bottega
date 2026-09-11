import { describe,expect,test } from 'bun:test'
import { ImportRefusalError,applyImport,baselineForPair,db,getDoc,ledgerRef,listDocRevisions,listDocs,listDoctrineRules,listPairs,listSkips,planImport,projects,setDoc,sourceCoverage,upsertProject } from '../test/fixture.ts'

describe('port importer', () => {
const registered = () => {
    upsertProject({ name: 'alpha-invented', path: '/w/alpha-invented', settings: { keyPrefixes: ['ALP'] } })
    upsertProject({ name: 'beta-invented', path: '/w/beta-invented', settings: { keyPrefixes: ['BET'] } })
    return projects()
  }
const fixture = (overrides: Partial<Record<'doctrine' | 'differences' | 'backports' | 'refs' | 'state' | 'projects', string>> = {}) => ({
    doctrine: '# Doctrine\n\nPreface text.\n\n1. **Keep the whole rule** Opening sentence.\nContinuation line.\nA known final item at the end of the rule.\n',
    differences: '# Differences\n\n## Stack mapping (how to translate, not a reason to skip)\nMap body.\n\n## Per-project uniques\n\n### alpha-invented\nAlpha body.\n\n### Shared deployment constraint\nUnassigned body.\n\n### beta-invented\nBeta body.\n\n## Process differences\nProcess body.\n',
    backports: '# Backports\n\n## -> alpha-invented\n' + 'A long backport body. '.repeat(20) + '\nKnown final checkbox.\n\n## -> beta-invented\nBeta backport.\n',
    refs: JSON.stringify({ 'BET-7': { source: 'alpha-invented', commits: ['abc'], paths: ['src/a.ts'], notes: 'Native notes.' } }),
    state: JSON.stringify({ pairs: { 'alpha-invented->beta-invented': { lastPortedSha: 'abc', scannedAt: '2026-01-01', skipped: [{ feature: 'old feature', reason: 'superseded', raiseAgain: false }] } } }),
    projects: '# Projects\n\n## Category map\nCategories.\n\n## Reference implementations (deepest instance = default port source)\nReferences.\n',
    ...overrides,
  })
test('plans complete long sections and classifies an unmatched differences heading globally', () => {
    const plan = planImport(fixture(), registered())
    expect(plan.refusals).toEqual([])
    const backport = plan.docs.find((doc) => doc.subject === 'alpha-invented' && doc.slug === 'port-backports')!
    expect(backport.body.length).toBeGreaterThan(backport.body.indexOf('\n') + 300)
    expect(backport.body).toContain('Known final checkbox.')
    expect(plan.doctrine[0]!.body).toContain('A known final item at the end of the rule.')
    expect(plan.docs.find((doc) => doc.slug === 'port-differences-unassigned')?.body)
      .toContain('Shared deployment constraint')
    expect(plan.docs.find((doc) => doc.subject === 'beta-invented' && doc.slug === 'port-differences')?.body)
      .not.toContain('Process body.')
  })
test('excludes incompatible baselines and unmapped fields while preserving bare skips losslessly', () => {
    const state = JSON.stringify({ pairs: {
      'alpha-invented->beta-invented': {
        lastPortedSha: null, scannedAt: '2026-01-01', skipped: ['bare candidate'],
        note: 'one', notes: 'two', scope: ['src'], staged: ['ALP-1'],
      },
    } })
    const plan = planImport(fixture({ state }), registered())
    expect(plan.exclusions.filter((r) => r.what.startsWith('pair field')).map((r) => r.what)).toEqual([
      'pair field "note"', 'pair field "notes"', 'pair field "scope"', 'pair field "staged"',
    ])
    expect(plan.exclusions.find((r) => r.what === 'baseline')?.where)
      .toBe('state.json pairs["alpha-invented->beta-invented"]')
    expect(plan.skips).toEqual([expect.objectContaining({
      candidate: 'bare candidate',
      reason: 'recorded in the source with no separate reason; the candidate text is the entire record',
    })])
    expect(plan.docs.find((doc) => doc.slug === 'port-import-exclusions')?.body)
      .toContain('Original value:\none')

    const missingSha = planImport(fixture({ state: JSON.stringify({ pairs: {
      'alpha-invented->beta-invented': { scannedAt: null, skipped: [] },
    } }) }), projects())
    expect(missingSha.exclusions.find((issue) => issue.what === 'baseline')?.why)
      .toBe('lastPortedSha is missing')
  })
test('splits declared multi-sources, preserves qualifiers, and refuses unresolved sources and task prefixes', () => {
    upsertProject({ name: 'alpha-invented', path: '/w/a', settings: { keyPrefixes: ['ALP'] } })
    upsertProject({ name: 'beta-invented', path: '/w/b', settings: { keyPrefixes: ['DUP'] } })
    upsertProject({ name: 'gamma-invented', path: '/w/c', settings: { keyPrefixes: ['DUP'] } })
    const refs = JSON.stringify({
      'ALP-1': { source: 'alpha-invented + beta-invented', commits: [], paths: [], notes: '' },
      'ALP-2': { source: 'alpha-invented (concept); new mechanism', commits: [], paths: [], notes: '' },
      'ALP-3': { source: 'missing-invented (unknown)', commits: [], paths: [], notes: '' },
      'NONE-2': { source: 'alpha-invented', commits: [], paths: [], notes: '' },
      'DUP-3': { source: 'alpha-invented', commits: [], paths: [], notes: '' },
    })
    const plan = planImport(fixture({ refs }), projects())
    expect(plan.refs.find((ref) => ref.taskKey === 'ALP-1')?.sources.map((source) => source.source_project_id))
      .toEqual([projects().find((p) => p.name === 'alpha-invented')!.id,
        projects().find((p) => p.name === 'beta-invented')!.id])
    expect(plan.refs.find((ref) => ref.taskKey === 'ALP-2')?.sources[0]?.note)
      .toBe(' (concept); new mechanism')
    expect(plan.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ where: 'refs.json ALP-3', what: 'project "missing-invented (unknown)"' }),
      expect.objectContaining({ where: 'refs.json NONE-2', why: expect.stringContaining('no registered project') }),
      expect.objectContaining({ where: 'refs.json DUP-3', why: expect.stringContaining('several registered projects') }),
    ]))

    const nonStringSource = planImport(fixture({ refs: JSON.stringify({
      'ALP-4': { source: ['alpha-invented'], commits: [], paths: [], notes: '' },
    }) }), projects())
    expect(nonStringSource.refusals.find((issue) => issue.where === 'refs.json ALP-4')?.why)
      .toBe('source must name registered projects')
  })
test('records the deliberately unimported register-derived sections as one exclusion', () => {
    const source = fixture({ projects: '# Projects\n\n## Resolving the workspace\nOld paths.\n\n## Stacks\nOld stacks.\n\n## Category map\nCategories.\n\n## Reference implementations (deepest instance = default port source)\nReferences.\n' })
    const plan = planImport(source, registered())
    expect(plan.exclusions.filter((r) => r.where === 'projects.md')).toEqual([
      expect.objectContaining({ what: 'workspace and stack sections' }),
    ])
  })
test('a refusal makes apply all-or-nothing', () => {
    const plan = planImport(fixture(), registered())
    plan.refusals.push({ kind: 'refusal', what: 'bad row', where: 'fixture row', why: 'cannot resolve it' })
    expect(() => applyImport(plan)).toThrow(ImportRefusalError)
    expect(listPairs()).toEqual([])
    expect(listDoctrineRules()).toEqual([])
    expect(getDoc('global', null, 'port-category-map')).toBeNull()
    const uncovered = sourceCoverage(plan, fixture())
    expect(uncovered).toHaveLength(6)
    expect(uncovered.map((gap) => gap.text)).toEqual(expect.arrayContaining(Object.values(fixture())))
  })
test('a destination refusal makes the plan report its whole input uncovered', () => {
    const files = fixture()
    applyImport(planImport(files, registered()))
    const refused = planImport(files, projects())
    expect(() => applyImport(refused)).toThrow(ImportRefusalError)
    expect(refused.refusals).toEqual([
      expect.objectContaining({ what: 'existing port data', kind: 'refusal' }),
    ])
    expect(sourceCoverage(refused, files)).toHaveLength(6)
  })
test('persists every exclusion and its original value inside the import transaction', () => {
    const state = JSON.stringify({ pairs: {
      'alpha-invented->beta-invented': {
        lastPortedSha: 'abc', scannedAt: '2026-01-01', skipped: [],
        note: 'Original text that must survive verbatim.',
      },
    } })
    const plan = planImport(fixture({ state }), registered())
    expect(plan.refusals).toEqual([])
    applyImport(plan)
    expect(getDoc('global', null, 'port-import-exclusions')).toMatchObject({
      title: 'Port import exclusions',
      body: expect.stringContaining('Original value:\nOriginal text that must survive verbatim.'),
    })
    expect(listDocRevisions('global', null, 'port-import-exclusions')[0]).toMatchObject({
      op: 'import', author: 'port-import', reason: 'port import from source corpus',
    })
  })
test('a second import refuses existing data and replace atomically rewrites it', () => {
    const plan = planImport(fixture(), registered())
    applyImport(plan)
    expect(() => applyImport(plan)).toThrow(ImportRefusalError)
    const replacement = planImport(fixture({ doctrine: '# Doctrine\n\nNew preface.\n\n2. **Replacement rule** Replacement body.\n' }), projects())
    applyImport(replacement, { replace: true })
    expect(listDoctrineRules().map((row) => row.number)).toEqual([2])
    expect(listPairs()).toHaveLength(1)
    expect(getDoc('global', null, 'port-doctrine-preface')?.body).toContain('New preface.')
    expect(listDocRevisions('global', null, 'port-doctrine-preface').map((revision) => revision.op))
      .toEqual(['import', 'delete', 'import'])
  })
test('an importer-owned doc alone makes the destination non-empty', () => {
    const plan = planImport(fixture(), registered())
    setDoc({ scope: 'global', subject: null, slug: 'port-category-map', title: 'Existing', body: 'Keep me.' })
    expect(() => applyImport(plan)).toThrow(ImportRefusalError)
    expect(getDoc('global', null, 'port-category-map')).toMatchObject({ title: 'Existing', body: 'Keep me.' })
    expect(listPairs()).toEqual([])
  })
test('a late doctrine constraint failure rolls back every preceding write', () => {
    const plan = planImport(fixture(), registered())
    plan.doctrine.push({ ...plan.doctrine[0]!, title: 'Duplicate' })
    expect(() => applyImport(plan)).toThrow()
    expect(listPairs()).toEqual([])
    expect(db().query('SELECT COUNT(*) n FROM port_baseline').get()).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) n FROM port_skip').get()).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) n FROM port_ref').get()).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) n FROM port_ref_source').get()).toEqual({ n: 0 })
    expect(listDoctrineRules()).toEqual([])
    expect(listDocs().filter((doc) => doc.slug.startsWith('port-'))).toEqual([])
  })
test('a late replacement failure restores all deleted prior data and docs', () => {
    const original = planImport(fixture(), registered())
    applyImport(original)
    const priorPair = listPairs()
    const priorBaseline = baselineForPair(priorPair[0]!.id)
    const priorSkips = listSkips(priorPair[0]!.id)
    const priorRef = ledgerRef('BET-7')
    const priorDoc = getDoc('global', null, 'port-category-map')
    const replacement = planImport(fixture(), projects())
    replacement.doctrine.push({ ...replacement.doctrine[0]!, title: 'Duplicate' })
    expect(() => applyImport(replacement, { replace: true })).toThrow()
    expect(listPairs()).toEqual(priorPair)
    expect(baselineForPair(priorPair[0]!.id)).toEqual(priorBaseline)
    expect(listSkips(priorPair[0]!.id)).toEqual(priorSkips)
    expect(ledgerRef('BET-7')).toEqual(priorRef)
    expect(getDoc('global', null, 'port-category-map')).toEqual(priorDoc)
    expect(listDoctrineRules()).toHaveLength(1)
  })
})

