import { describe,expect,test } from 'bun:test'
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname,join } from 'node:path'
import { allNumericLiterals,brief,checkDoc,compilePack,db,diffPack,dir,docsForRun,exportDocs,getDoc,hermeticGitEnv,importDocs,listDocMetadata,numericLiteralReport,recordPack,removeDoc,setDoc,upsertProject } from '../test/fixture.ts'
import { canonCommand } from './canon-commands.ts'
import { docCommand } from './doc-commands.ts'

const flags = (values: Record<string, string | boolean>) => ({
  has: (name: string) => values[name] !== undefined,
  flag: (name: string) => typeof values[name] === 'string' ? values[name] as string : undefined,
})


describe('scoped operator docs', () => {
  test('checkDoc validates tracked paths, commands, jobs and scripts from backticked tokens', () => {
    const repo = mkdtempSync(join(tmpdir(), 'canon-check-'))
    try {
      mkdirSync(join(repo, 'scripts'))
      writeFileSync(join(repo, 'scripts', 'tracked.ts'), '')
      writeFileSync(join(repo, 'scripts', 'present.ts'), '')
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'true' } }))
      Bun.spawnSync(['git', 'init'], { cwd: repo, env: hermeticGitEnv() })
      Bun.spawnSync(['git', 'add', 'scripts/tracked.ts', 'package.json'], {
        cwd: repo, env: hermeticGitEnv(),
      })
      const findings = checkDoc([
        '`scripts/tracked.ts` `scripts/present.ts` `scripts/<x>.ts` `dist/generated.js`',
        '`scripts/tracked.ts:1-2` `scripts/worktree`',
        '`orch doc` `orch nosuch` `orch do understand` `orch do fake-job`',
        '`bun run check` `bun run nosuch`',
      ].join('\n'), { repoRoot: repo })
      expect(findings.map((finding) => [finding.kind, finding.token])).toEqual([
        ['path', 'scripts/present.ts'], ['orch-command', 'orch nosuch'],
        ['job', 'orch do fake-job'], ['bun-script', 'bun run nosuch'],
      ])
      expect(checkDoc('body', { repoRoot: join(repo, 'missing') })[0]?.kind).toBe('unchecked')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('numeric literal report classifies per clause and excludes non-prose spans', () => {
    const cases: { text: string; expected: [string, string][] }[] = [
      { text: 'The suite currently has 6,676 tests.', expected: [['6,676', 'RESTATED']] },
      { text: 'The service listens on port 5432.', expected: [['5432', 'RESTATED']] },
      { text: 'Bun 1.3.14 is installed.', expected: [['1.3.14', 'RESTATED']] },
      { text: 'Qwen3.6 is installed.', expected: [['Qwen3.6', 'RESTATED']] },
      { text: 'The default is 5.', expected: [['5', 'OWNED']] },
      { text: 'This policy defines and enforces the threshold of 15.', expected: [['15', 'OWNED']] },
      { text: 'A product admits at most 1 tag.', expected: [['1', 'OWNED']] },
      { text: 'A change under 10% is reported as flat.', expected: [['10%', 'OWNED']] },
      { text: 'The gate asserts 170 characters.', expected: [['170', 'CHECKED']] },
      { text: 'The check refuses 51 lines.', expected: [['51', 'CHECKED']] },
      { text: 'This check caps output at 20 bytes.', expected: [['20', 'CHECKED']] },
      { text: 'Run 1565 measured 36,058 rows.', expected: [['1565', 'EVIDENCE'], ['36,058', 'EVIDENCE']] },
      { text: 'We observed 42 rows.', expected: [['42', 'EVIDENCE']] },
      { text: 'The sample measured 80 bytes.', expected: [['80', 'EVIDENCE']] },
      { text: 'The incident had 22 files.', expected: [['22', 'UNCLASSIFIED']] },
      { text: 'Build 4 succeeded.', expected: [['4', 'UNCLASSIFIED']] },
      { text: 'Option 7 is preferred.', expected: [['7', 'UNCLASSIFIED']] },
      { text: 'Version 2 was used during the incident.', expected: [['2', 'UNCLASSIFIED']] },
      { text: 'Do not trust the claim that the suite has 900 tests.', expected: [['900', 'UNCLASSIFIED']] },
      { text: 'Its 22 files are recoverable from the old commit.', expected: [['22', 'UNCLASSIFIED']] },
      { text: 'Run 279 is the case: 409 seconds, 57 bytes back.',
        expected: [['279', 'EVIDENCE'], ['409', 'EVIDENCE'], ['57', 'UNCLASSIFIED']] },
      { text: 'Runs 378 and 379 did work and reported 452 rows.',
        expected: [['378', 'EVIDENCE'], ['379', 'UNCLASSIFIED'], ['452', 'UNCLASSIFIED']] },
      { text: 'The 3rd retry succeeded.', expected: [] },
      { text: '1. First item.', expected: [] },
      { text: 'Open https://localhost:7778/v2 now.', expected: [] },
      { text: 'Read /tmp/run-42/file2.ts.', expected: [] },
      { text: 'Use `port 8888`.', expected: [] },
      { text: '```\nhidden 9000\n```', expected: [] },
      { text: 'Ticket DEV-307 owns this.', expected: [] },
      { text: 'Recorded on 2026-09-06.', expected: [] },
      { text: 'The meeting starts at 13:20.', expected: [] },
      { text: 'See file.ts:42 and path/file:43.', expected: [] },
      { text: 'See lines 19-21.', expected: [] },
      { text: 'Install Bun 1.3.14 before running the gate.', expected: [['1.3.14', 'RESTATED']] },
      { text: 'The gate checks 50 files and Bun 1.3.14 is installed.',
        expected: [['50', 'CHECKED'], ['1.3.14', 'RESTATED']] },
      { text: 'Run 7 measured 40 rows, but the suite has 900 tests.',
        expected: [['7', 'EVIDENCE'], ['40', 'EVIDENCE'], ['900', 'RESTATED']] },
      { text: 'The year 2020 changed everything.', expected: [['2020', 'UNCLASSIFIED']] },
    ]
    for (const row of cases) {
      const report = numericLiteralReport(row.text, 'fixture')
      expect(report.map(({ numeral, classification }) => [numeral, classification]), row.text)
        .toEqual(row.expected)
      expect(report.every((hit) => hit.source === 'fixture')).toBe(true)
    }
  })

  test('numeric report scans safe register strings and reports read and missing canon files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'numeric-canon-'))
    try {
      Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd: repo, env: hermeticGitEnv() })
      const canon = ['AGENTS.md', 'orchestrator/AGENTS.md', 'hub/AGENTS.md', 'ops/AGENTS.md',
        'local-stack/AGENTS.md']
      for (const [index, file] of canon.slice(0, -1).entries()) {
        mkdirSync(dirname(join(repo, file)), { recursive: true })
        writeFileSync(join(repo, file), `The current suite has ${index + 10} tests.\n`)
      }
      mkdirSync(join(repo, 'nested'), { recursive: true })
      writeFileSync(join(repo, 'nested', 'AGENTS.md'), 'The current suite has 999 tests.\n')
      upsertProject({ name: 'registered', path: repo, canon: true,
        settings: { worktree: { notes: 'The current port is 7000.' } } })
      upsertProject({ name: 'null-settings', path: '/null', canon: true })
      db().query(`UPDATE project SET settings='null' WHERE name='null-settings'`).run()
      upsertProject({ name: 'bad-notes', path: '/bad', canon: true,
        settings: { worktree: { notes: 123, readonly_notes: null } } as any })
      const result = allNumericLiterals(repo)
      const report = result.numericLiterals.filter((hit) => hit.classification === 'RESTATED')
      expect(report.map((hit) => hit.source)).toEqual([
        'register:registered notes', 'AGENTS.md:1', 'orchestrator/AGENTS.md:1',
        'hub/AGENTS.md:1', 'ops/AGENTS.md:1',
      ])
      expect(report.map((hit) => hit.numeral)).toEqual(['7000', '10', '11', '12', '13'])
      expect(result.canonFiles).toEqual({ read: canon.slice(0, -1), missing: ['local-stack/AGENTS.md'] })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('canon pack upsert and diff retain removed docs, revisions, and byte delta', () => {
    setDoc({ scope: 'global', subject: null, slug: 'one', title: 'One', body: 'one' })
    setDoc({ scope: 'global', subject: null, slug: 'two', title: 'Two', body: 'two' })
    recordPack(compilePack({ job: 'understand', cwd: dir }))
    removeDoc('global', null, 'two')
    setDoc({ scope: 'global', subject: null, slug: 'one', title: 'One', body: 'changed' })
    const diff = diffPack({ job: 'understand', cwd: dir })
    expect(diff.removed.map((doc) => doc.slug)).toEqual(['two'])
    expect(diff.changed[0]).toMatchObject({ fromRevision: expect.any(Number), toRevision: expect.any(Number) })
    expect(diff.bytesDelta).not.toBe(0)
    recordPack(diff.current)
    expect(db().query('SELECT COUNT(*) n FROM canon_pack').get()).toEqual({ n: 1 })
  })

  test('docsForRun refuses a document whose provenance was bypassed', () => {
    db().query(
      `INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at)
       VALUES ('global', NULL, 'untracked', 'Untracked', 'body', ?, ?)`,
    ).run('2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')
    expect(() => docsForRun({ job: 'file-question', cwd: '/elsewhere' }))
      .toThrow('doc global/_/untracked has no revision; refusing run')
  })

  test('metadata listing omits bodies and supports discovery filters without widening exact matches', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'project', subject: 'known', slug: 'mcp-scope', title: 'MCP Scope', body: 'first' })
    setDoc({ scope: 'agent', subject: 'codex', slug: 'capabilities', title: 'Capabilities', body: 'MCP scoping details' })
    setDoc({ scope: 'global', subject: null, slug: 'other', title: 'Other', body: 'é' })
    db().query('UPDATE doc SET updated_at=? WHERE slug=?').run('2026-09-01T00:00:00.000Z', 'other')
    db().query('UPDATE doc SET updated_at=? WHERE slug=?').run('2026-09-03T00:00:00.000Z', 'mcp-scope')
    db().query('UPDATE doc SET updated_at=? WHERE slug=?').run('2026-09-02T00:00:00.000Z', 'capabilities')

    expect(listDocMetadata({ scope: 'project' }).map((d) => d.slug)).toEqual(['mcp-scope'])
    expect(listDocMetadata({ subject: 'known' }).map((d) => d.slug)).toEqual(['mcp-scope'])
    expect(listDocMetadata({ match: 'mCp ScOpE' }).map((d) => d.slug)).toEqual(['mcp-scope'])
    expect(listDocMetadata({ bodyMatch: 'mCp ScOpInG' }).map((d) => d.slug)).toEqual(['capabilities'])
    expect(listDocMetadata({ scopes: ['agent', 'project'] }).map((d) => d.scope)).toEqual(['agent', 'project'])
    expect(listDocMetadata({ updatedAtOrder: 'asc' }).map((d) => d.slug))
      .toEqual(['other', 'capabilities', 'mcp-scope'])
    expect(listDocMetadata().find((d) => d.slug === 'other')).toMatchObject({ bytes: 2 })
    expect(listDocMetadata()).not.toContainKeys(['body', 'created_at'])
    expect(() => listDocMetadata({ scope: 'global', scopes: ['global'] })).toThrow('scope or scopes')
  })

  test('export and import preserve title and markdown body', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'quoted', title: 'A "title"', body: '# Body\n\nText\n' })
    setDoc({ scope: 'project', subject: 'known', slug: 'project', title: 'Project', body: 'Estate' })
    const target = mkdtempSync(join(tmpdir(), 'orch-doc-export-'))
    try {
      expect(exportDocs(target)).toBe(2)
      db().exec('DELETE FROM doc')
      expect(importDocs(target)).toBe(2)
      expect(getDoc('global', null, 'quoted')).toMatchObject({ title: 'A "title"', body: '# Body\n\nText\n' })
      expect(getDoc('project', 'known', 'project')?.body).toBe('Estate')
    } finally { rmSync(target, { recursive: true, force: true }) }
  })

  test('brief contains global then current-project markdown, and is empty otherwise', () => {
    expect(brief('/nowhere')).toBe('')
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'project', subject: 'known', slug: 'p', title: 'Project', body: 'P' })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    expect(brief('/w/known/src')).toBe('## Global\n\nG\n\n## Project\n\nP')
  })

  test('doc CLI delivery round-trips and validation warnings do not refuse the write', async () => {
    const lines: string[] = []
    await docCommand('set', ['doc', 'set', 'cli-demand'], flags({ scope: 'global', title: 'CLI',
      delivery: 'demand', reason: 'test', json: true }), {
      log: (...parts) => lines.push(parts.join(' ')), error: () => {}, write: () => {},
      stdinText: async () => '`orch nosuch`', stdinIsTTY: false, cwd: () => dir,
    })
    const result = JSON.parse(lines[0]!)
    expect(result).toMatchObject({ delivery: 'demand', warnings: [{ kind: 'orch-command' }] })
    expect(getDoc('global', null, 'cli-demand')?.body).toBe('`orch nosuch`')
  })

  test('canon check publishes JSON and exits one only when findings exist', async () => {
    const invoke = async (json = true) => {
      const lines: string[] = []; let exit = 0
      await canonCommand(['canon', 'check'], flags({ cwd: dir, job: 'understand', ...(json ? { json: true } : {}) }),
        { log: (...parts) => lines.push(parts.join(' ')), exitCode: (code) => { exit = code }, cwd: () => dir })
      return { exitCode: exit, stdout: lines.join('\n') }
    }
    upsertProject({ name: 'canon-cli', path: dir, canon: true,
      settings: { worktree: { notes: 'The current suite has 9,999 tests.' } } })
    setDoc({ scope: 'global', subject: null, slug: 'bad', title: 'Bad', body: '`orch nosuch`' })
    const bad = await invoke()
    expect(bad.exitCode).toBe(1)
    expect(JSON.parse(bad.stdout.toString())).toMatchObject({
      pack: { job: 'understand', bytes: expect.any(Number), budgetBytes: 64 * 1024 },
      findings: [{ kind: 'orch-command', token: 'orch nosuch' }],
      numericLiterals: [expect.objectContaining({
        source: 'register:canon-cli notes', numeral: '9,999', classification: 'RESTATED',
      })],
      canonFiles: { read: [], missing: [
        'AGENTS.md', 'orchestrator/AGENTS.md', 'hub/AGENTS.md', 'ops/AGENTS.md',
        'local-stack/AGENTS.md',
      ] },
    })
    setDoc({ scope: 'global', subject: null, slug: 'bad', title: 'Good', body: '`orch doc`' })
    const good = await invoke()
    expect(good.exitCode).toBe(0)
    expect(JSON.parse(good.stdout.toString()).findings).toEqual([])
    expect(JSON.parse(good.stdout.toString())).toContainKey('numericLiterals')
    const plain = await invoke(false)
    expect(plain.exitCode).toBe(0)
    expect(plain.stdout.toString()).toContain('canon files: read none; missing AGENTS.md')
  })

  test('canon check keeps its exit-zero JSON contract for a missing cwd', async () => {
    const missing = join(dir, 'numeric-missing-cwd')
    const lines: string[] = []; let exit = 0
    await canonCommand(['canon', 'check'], flags({ cwd: missing, job: 'understand', json: true }),
      { log: (...parts) => lines.push(parts.join(' ')), exitCode: (code) => { exit = code }, cwd: () => missing })
    expect(exit).toBe(0)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      findings: [], numericLiterals: [], canonFiles: { read: [], missing: [] },
    })
  })

})
