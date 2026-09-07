import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { AGENTS, CanonBudgetError, JOBS, addRun, allNumericLiterals, brief, checkDoc, compileBrief, compilePack, consumeDoc, consumeDocument, createDocsMcpServer, db, deleteDoc, diffDocRevisions, diffPack, dir, docSubjects, docsForRun, exportDocs, fileIssue, getDoc, getDocRevision, hermeticGitEnv, importDocs, ledgerRef, listDocMetadata, listDocRevisions, listDocs, listOpenResumes, numericLiteralReport, parseResumeFrontmatter, promoteWorkflow, readDocs, recordPack, recordReview, removeDoc, removeProject, restoreDoc, resumeAge, reviewReply, runJob, setDoc, setWorkflow, upsertProject, writeDoc } from '../test/fixture.ts'

const hubCli = new URL('../../hub/src/cli.ts', import.meta.url).pathname
function migrateHub(path: string): void {
  const result = Bun.spawnSync([process.execPath, hubCli, 'migrate'], {
    env: { ...process.env, HUB_DB: path }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
}

describe('scoped operator docs', () => {
  test('CRUD round-trips and set is a uniqueness-preserving upsert', () => {
    const first = setDoc({ scope: 'global', subject: null, slug: 'hello', title: 'Hello', body: 'one' })
    expect(getDoc('global', null, 'hello')?.body).toBe('one')
    const second = setDoc({ scope: 'global', subject: null, slug: 'hello', title: 'Hello again', body: 'two' })
    expect(second.id).toBe(first.id)
    expect(listDocs()).toHaveLength(1)
    expect(second.created_at).toBe(first.created_at)
    expect(second.body).toBe('two')
    expect(removeDoc('global', null, 'hello')).toBe(true)
    expect(getDoc('global', null, 'hello')).toBeNull()
  })

  test('create, set, consume, delete, and restore append complete state revisions', async () => {
    const created = writeDoc({
      scope: 'global', subject: null, slug: 'revision-life', title: 'First',
      body: '---\nstatus: open\n---\n\none', author: 'creator', reason: 'create it',
    })
    writeDoc({
      scope: 'global', subject: null, slug: 'revision-life', title: 'Second',
      body: '---\nstatus: open\n---\n\ntwo', delivery: 'demand', author: 'editor', reason: 'update it',
    })
    consumeDoc('global', null, 'revision-life', { author: 'consumer', reason: 'finish it' })
    const beforeDelete = getDoc('global', null, 'revision-life')!
    deleteDoc('global', null, 'revision-life', { author: 'deleter', reason: 'remove it' })
    await Bun.sleep(2)
    const restored = restoreDoc(
      'global', null, 'revision-life', listDocRevisions('global', null, 'revision-life').at(-1)!.id,
      { author: 'restorer', reason: 'bring it back' },
    )
    const revisions = listDocRevisions('global', null, 'revision-life').reverse()
    expect(revisions.map((revision) => revision.op)).toEqual(['create', 'set', 'consume', 'delete', 'restore'])
    expect(revisions.map((revision) => revision.author)).toEqual(['creator', 'editor', 'consumer', 'deleter', 'restorer'])
    expect(revisions.map((revision) => revision.reason)).toEqual([
      'create it', 'update it', 'finish it', 'remove it', 'bring it back',
    ])
    expect(getDocRevision(revisions[2]!.id)?.body).toContain('status: consumed')
    expect(getDocRevision(revisions[3]!.id)?.body).toBe(beforeDelete.body)
    expect(getDocRevision(revisions[1]!.id)?.delivery).toBe('demand')
    expect(restored.body).toBe('---\nstatus: open\n---\n\none')
    expect(restored.delivery).toBe('inject')
    expect(restored.updated_at).not.toBe(created.updated_at)
  })

  test('write reasons are required and author defaults to the session or unknown', () => {
    expect(() => writeDoc({
      scope: 'global', subject: null, slug: 'no-reason', title: 'T', body: 'B', reason: '  ',
    })).toThrow('reason is required')
    expect(() => consumeDocument('global', null, 'missing', { reason: '' })).toThrow('reason is required')
    expect(() => deleteDoc('global', null, 'missing', { reason: '\t' })).toThrow('reason is required')
    expect(() => readDocs('/missing', { reason: ' ' })).toThrow('reason is required')

    // sessionId() used to fall back to the Remote Control bridge id, which is
    // set in a real Claude shell; clear the primary or the "unknown" branch
    // never runs.
    const before = process.env.CLAUDE_CODE_SESSION_ID
    const bridgeBefore = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      process.env.CLAUDE_CODE_SESSION_ID = 'doc-session'
      writeDoc({ scope: 'global', subject: null, slug: 'session-author', title: 'T', body: 'B', reason: 'test' })
      delete process.env.CLAUDE_CODE_SESSION_ID
      delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
      writeDoc({ scope: 'global', subject: null, slug: 'unknown-author', title: 'T', body: 'B', reason: 'test' })
      expect(listDocRevisions('global', null, 'session-author')[0]!.author).toBe('doc-session')
      expect(listDocRevisions('global', null, 'unknown-author')[0]!.author).toBe('unknown')
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = before
      if (bridgeBefore === undefined) delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
      else process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = bridgeBefore
    }
  })

  test('revision diff renders a one-line replacement', () => {
    writeDoc({ scope: 'global', subject: null, slug: 'diffed', title: 'T', body: 'one\n', reason: 'first' })
    writeDoc({ scope: 'global', subject: null, slug: 'diffed', title: 'T', body: 'two\n', reason: 'second' })
    const [latest, previous] = listDocRevisions('global', null, 'diffed')
    expect(diffDocRevisions(previous!.id, latest!.id)).toContain('-one\n+two')
  })

  test('history and restore survive removal of the addressed project', () => {
    upsertProject({ name: 'former', path: '/w/former', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'project', subject: 'former', slug: 'historic', title: 'Historic', body: 'kept',
    })
    removeDoc('project', 'former', 'historic')
    expect(removeProject('former')).toBe(true)

    expect(listDocRevisions('project', 'former', 'historic').map((revision) => revision.op))
      .toEqual(['delete', 'create'])
    expect(restoreDoc(
      'project', 'former', 'historic',
      listDocRevisions('project', 'former', 'historic').find((revision) => revision.op === 'create')!.id,
      { reason: 'restore after unregistering' },
    )).toMatchObject({ id: expect.any(Number), scope: 'project', subject: 'former', slug: 'historic', body: 'kept' })
  })

  test('consume survives removal of the addressed project', () => {
    upsertProject({ name: 'former', path: '/w/former', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'former', slug: 'epic', title: 'Resume',
      body: '---\nstatus: open\n---\n\nresume',
    })
    setDoc({
      scope: 'project', subject: 'former', slug: 'note', title: 'Project',
      body: '---\nstatus: open\n---\n\nproject',
    })
    expect(removeProject('former')).toBe(true)

    expect(consumeDoc('resume', 'former', 'epic').body).toContain('status: consumed')
    expect(consumeDoc('project', 'former', 'note').body).toContain('status: consumed')
    expect(listDocRevisions('resume', 'former', 'epic')[0]?.op).toBe('consume')
    expect(listDocRevisions('project', 'former', 'note')[0]?.op).toBe('consume')
  })

  test('scope, slug, and every subject rule name a usable fix', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const put = (scope: string, subject: string | null, slug = 'ok') =>
      setDoc({
        scope, subject, slug, title: 'T',
        body: scope === 'resume' ? '---\nstatus: open\n---\n\nB' : 'B',
      })
    expect(() => put('global', null, 'Bad')).toThrow('1-64')
    expect(() => put('global', null, 'a'.repeat(65))).toThrow('1-64')
    expect(() => put('unknown', null)).toThrow('valid scopes')
    expect(() => put('project', 'missing')).toThrow('valid values: known')
    expect(() => put('agent', 'missing')).toThrow(`valid values:`)
    expect(() => put('job', 'missing')).toThrow(`valid values:`)
    expect(() => put('machine', 'host')).toThrow('remove --subject')
    expect(() => put('global', 'all')).toThrow('remove --subject')
    expect(() => put('project', null)).toThrow('require --subject')
    expect(() => put('resume', null)).toThrow('require --subject')
    expect(() => put('resume', 'missing')).toThrow('valid values: known')
    expect(put('resume', 'known').scope).toBe('resume')
  })

  test('docsForRun orders global, job, then project and omits absent scopes', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    expect(docsForRun({ job: 'file-question', cwd: '/elsewhere' })).toEqual([])
    setDoc({ scope: 'project', subject: 'known', slug: 'project', title: 'Project', body: 'P' })
    setDoc({ scope: 'job', subject: 'file-question', slug: 'job', title: 'Job', body: 'J' })
    setDoc({ scope: 'global', subject: null, slug: 'global', title: 'Global', body: 'G' })
    setDoc({ scope: 'agent', subject: 'codex', slug: 'agent', title: 'Agent', body: 'A' })
    setDoc({ scope: 'machine', subject: null, slug: 'machine', title: 'Machine', body: 'M' })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'epic', title: 'Resume',
      body: '---\nstatus: open\n---\n\nR',
    })
    expect(docsForRun({ job: 'file-question', cwd: '/w/known/src' }).map((d) => d.title))
      .toEqual(['Global', 'Job', 'Project'])
  })

  test('delivery is round-tripped and demand docs never enter a compiled pack', () => {
    upsertProject({ name: 'known', path: dir, stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'injected', title: 'Injected', body: 'é' })
    setDoc({ scope: 'global', subject: null, slug: 'demand', title: 'Demand', body: 'large', delivery: 'demand' })
    setDoc({ scope: 'job', subject: 'understand', slug: 'job', title: 'Job', body: 'J' })
    setDoc({ scope: 'project', subject: 'known', slug: 'project', title: 'Project', body: 'P' })
    const pack = compilePack({ job: 'understand', cwd: dir })
    expect(pack.docs.map((doc) => doc.title)).toEqual(['Injected', 'Job', 'Project'])
    expect(pack.docs.every((doc) => doc.revisionId > 0)).toBe(true)
    expect(pack.bytes).toBe(Buffer.byteLength(pack.markdown))
    expect(pack.sha256).toHaveLength(64)
    expect(getDoc('global', null, 'demand')?.delivery).toBe('demand')
    expect(docsForRun({ job: 'understand', cwd: dir }).map((doc) => doc.slug)).not.toContain('demand')
  })

  test('budget refusal lists every document largest-first and run records harness before spawn', async () => {
    setDoc({ scope: 'global', subject: null, slug: 'small', title: 'Small', body: 'x' })
    setDoc({ scope: 'global', subject: null, slug: 'large', title: 'Large', body: 'x'.repeat(80) })
    const old = JOBS.understand!.packBytes
    const oldDepth = process.env.ORCH_DEPTH
    JOBS.understand!.packBytes = 32
    process.env.ORCH_DEPTH = '0'
    try {
      expect(() => compilePack({ job: 'understand', cwd: dir })).toThrow(CanonBudgetError)
      let message = ''
      try {
        await runJob({
          job: 'understand', prompt: 'never spawned', cwd: dir, agent: 'codex', mcp: 'prefer',
        })
      }
      catch (cause) { message = (cause as Error).message }
      expect(message).toContain('global/_/large')
      expect(message.indexOf('global/_/large')).toBeLessThan(message.indexOf('global/_/small'))
      const row = db().query(
        'SELECT status,failure_kind,error,mcp FROM run ORDER BY id DESC LIMIT 1',
      ).get() as any
      expect(row).toMatchObject({ status: 'failed', failure_kind: 'harness', mcp: 2 })
      expect(row.error).toContain('mark a document demand')
    } finally {
      JOBS.understand!.packBytes = old
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
    }
  })

  test('brief has its own 64 KiB refusal', () => {
    setDoc({ scope: 'global', subject: null, slug: 'too-big', title: 'Large', body: 'x'.repeat(70 * 1024) })
    expect(() => compileBrief(dir)).toThrow(CanonBudgetError)
  })

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

  test('doc CLI delivery round-trips and validation warnings do not refuse the write', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const p = Bun.spawnSync([process.execPath, CLI, 'doc', 'set', 'cli-demand', '--scope', 'global',
      '--title', 'CLI', '--delivery', 'demand', '--reason', 'test', '--json'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdin: new TextEncoder().encode('`orch nosuch`'), stdout: 'pipe', stderr: 'pipe',
    })
    expect(p.exitCode).toBe(0)
    const result = JSON.parse(p.stdout.toString())
    expect(result).toMatchObject({ delivery: 'demand', warnings: [{ kind: 'orch-command' }] })
    expect(getDoc('global', null, 'cli-demand')?.body).toBe('`orch nosuch`')
  })

  test('canon check publishes JSON and exits one only when findings exist', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const invoke = () => Bun.spawnSync([process.execPath, CLI, 'canon', 'check', '--cwd', dir,
      '--job', 'understand', '--json'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    upsertProject({ name: 'canon-cli', path: dir, canon: true,
      settings: { worktree: { notes: 'The current suite has 9,999 tests.' } } })
    setDoc({ scope: 'global', subject: null, slug: 'bad', title: 'Bad', body: '`orch nosuch`' })
    const bad = invoke()
    expect(bad.exitCode).toBe(1)
    expect(JSON.parse(bad.stdout.toString())).toMatchObject({
      pack: { job: 'understand', bytes: expect.any(Number), budgetBytes: 96 * 1024 },
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
    const good = invoke()
    expect(good.exitCode).toBe(0)
    expect(JSON.parse(good.stdout.toString()).findings).toEqual([])
    expect(JSON.parse(good.stdout.toString())).toContainKey('numericLiterals')
    const plain = Bun.spawnSync([process.execPath, CLI, 'canon', 'check', '--cwd', dir,
      '--job', 'understand'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(plain.exitCode).toBe(0)
    expect(plain.stdout.toString()).toContain('canon files: read none; missing AGENTS.md')
  })

  test('canon check keeps its exit-zero JSON contract for a missing cwd', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const missing = join(dir, 'numeric-missing-cwd')
    const result = Bun.spawnSync([process.execPath, CLI, 'canon', 'check', '--cwd', missing,
      '--job', 'understand', '--json'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      findings: [], numericLiterals: [], canonFiles: { read: [], missing: [] },
    })
  })

  test('first-turn bound prompts inject docs and count them; resumes do neither', async () => {
    upsertProject({ name: 'known', path: dir, stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    setDoc({ scope: 'job', subject: 'file-question', slug: 'j', title: 'Job', body: 'J' })
    setDoc({ scope: 'project', subject: 'known', slug: 'p', title: 'Project', body: 'P' })
    const script = join(dir, 'docs-agent.ts')
    writeFileSync(script, 'process.stdout.write("ok")\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origArgv = agent.argv
    const origResume = agent.resumeArgv
    let resumedPrompt = ''
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.resumeArgv = ({ prompt }) => { resumedPrompt = prompt; return [script] }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const first = await runJob({ job: 'file-question', prompt: 'FIRST SPEC', cwd: dir, agent: 'codex' })
      const firstRow = db().query('SELECT prompt_path, docs_injected, doc_revisions, canon_sha FROM run WHERE id=?').get(first.id) as
        { prompt_path: string; docs_injected: number; doc_revisions: string; canon_sha: string }
      const bound = readFileSync(firstRow.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8')
      expect(bound).toContain('WHAT THE OPERATOR WANTS YOU TO KNOW\n\n## Global\n\nG\n\n## Job\n\nJ\n\n## Project\n\nP')
      expect(firstRow.docs_injected).toBe(3)
      expect(JSON.parse(firstRow.doc_revisions)).toEqual(
        docsForRun({ job: 'file-question', cwd: dir }).map((doc) => doc.revision_id),
      )
      expect(firstRow.canon_sha).toHaveLength(64)
      expect(db().query('SELECT sha256,doc_count FROM canon_pack WHERE job=?').get('file-question'))
        .toEqual({ sha256: firstRow.canon_sha, doc_count: 3 })
      db().query('UPDATE run SET vendor_session=? WHERE id=?').run('docs-session', first.id)
      const resumed = await runJob({
        job: 'file-question', prompt: 'RULING', cwd: dir,
        resume: { parent: first.id, agent: 'codex', session: 'docs-session', turn: 2,
          sessionId: 'owner', worktree: null },
      })
      expect(resumedPrompt).not.toContain('WHAT THE OPERATOR WANTS YOU TO KNOW')
      expect(db().query('SELECT docs_injected, doc_revisions FROM run WHERE id=?').get(resumed.id)).toEqual({
        docs_injected: 0, doc_revisions: null,
      })
    } finally {
      agent.bin = origBin
      agent.argv = origArgv
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  })

  test('MCP list_reviews and get_review round-trip through linked in-memory transports', async () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'mcp-model', lens: 'mcp-review' })
    const reviewId = recordReview(runId, reviewReply(1))
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport); await client.connect(clientTransport)
    try {
      const parse = (result: any) => JSON.parse((result.content[0] as { text: string }).text)
      const listed = parse(await client.callTool({ name: 'list_reviews', arguments: { open: true } }))
      const shown = parse(await client.callTool({ name: 'get_review', arguments: { id: reviewId } }))
      expect(listed).toEqual([expect.objectContaining({ id: reviewId, findings: { total: 1, triaged: 0,
        accepted: 0, modified: 0, rejected: 0, skipped: 0 } })])
      expect(shown).toMatchObject({ id: reviewId, lenses: [{ run_id: runId, lens: 'mcp-review' }],
        findings: [{ evidence: 'evidence 1' }] })
    } finally { await client.close(); await server.close() }
  })

  test('MCP list_docs and get_doc work through linked in-memory transports', async () => {
    setDoc({ scope: 'global', subject: null, slug: 'mcp', title: 'MCP', body: 'Visible' })
    setDoc({
      scope: 'global', subject: null, slug: 'mcp-consume', title: 'MCP consume',
      body: '---\nstatus: open\n---\n\nVisible\n',
    })
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const listed = await client.callTool({ name: 'list_docs', arguments: { scope: 'global' } })
      const fetched = await client.callTool({ name: 'get_doc', arguments: { scope: 'global', slug: 'mcp' } })
      const consumed = await client.callTool({
        name: 'consume_doc', arguments: { scope: 'global', slug: 'mcp-consume' },
      })
      const missingReason = await client.callTool({
        name: 'set_doc', arguments: { scope: 'global', slug: 'bad', title: 'Bad', body: 'Bad' },
      })
      const set = await client.callTool({
        name: 'set_doc', arguments: {
          scope: 'global', slug: 'mcp-set', title: 'Set', body: '`orch nosuch`',
          delivery: 'demand', reason: 'MCP round trip',
        },
      })
      const setRow = JSON.parse(((set as any).content[0] as { text: string }).text)
      const revisionList = await client.callTool({
        name: 'list_doc_revisions', arguments: { scope: 'global', slug: 'mcp-set' },
      })
      const revisionRows = JSON.parse(((revisionList as any).content[0] as { text: string }).text)
      const revision = await client.callTool({
        name: 'get_doc_revision', arguments: { id: revisionRows[0].id },
      })
      const listedText = ((listed as any).content[0] as { text: string }).text
      const fetchedText = ((fetched as any).content[0] as { text: string }).text
      const consumedText = ((consumed as any).content[0] as { text: string }).text
      const listedRows = JSON.parse(listedText)
      expect(listedRows).toHaveLength(2)
      expect(listedRows[0]).toEqual({
        id: expect.any(Number), scope: 'global', subject: null, slug: 'mcp', title: 'MCP',
        bytes: 7, updated_at: expect.any(String),
      })
      expect(listedRows[0]).not.toHaveProperty('body')
      expect(JSON.parse(fetchedText).body).toBe('Visible')
      expect(JSON.parse(consumedText)).toMatchObject({ already_consumed: false })
      expect(getDoc('global', null, 'mcp-consume')?.body).toContain('status: consumed')
      expect(missingReason.isError).toBe(true)
      expect(((missingReason as any).content[0] as { text: string }).text).toContain('reason')
      expect(setRow.body).toBe('`orch nosuch`')
      expect(setRow.delivery).toBe('demand')
      expect(setRow.warnings[0]).toMatchObject({ kind: 'orch-command' })
      expect(revisionRows[0]).toMatchObject({ op: 'create', author: expect.any(String), reason: 'MCP round trip' })
      expect(JSON.parse(((revision as any).content[0] as { text: string }).text).body).toBe('`orch nosuch`')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('MCP workflow tools return lean indexes, needs, and one substituted step', async () => {
    const definition = {
      title: 'Choose', description: 'MCP fixture',
      arguments: [{ name: 'key', required: true, description: 'Task key' }],
      modes: [{ slug: 'careful', title: 'Careful', entry: 'Use the careful path?', steps: ['inspect'] }],
      steps: [{ slug: 'inspect', title: 'Inspect', job: null, autonomy: 'manual', gate: null, body: 'Inspect {{key}}.' }],
    }
    const draft = setWorkflow('mcp-workflow', definition, 'test MCP', 'test')
    promoteWorkflow('mcp-workflow', draft.n, 'publish MCP fixture', 'test')
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport); await client.connect(clientTransport)
    try {
      const parse = (result: any) => JSON.parse((result.content[0] as {text:string}).text)
      const listed = parse(await client.callTool({ name: 'list_workflows', arguments: {} }))
      const needs = parse(await client.callTool({ name: 'compose_workflow', arguments: { slug: 'mcp-workflow' } }))
      const composed = parse(await client.callTool({ name: 'compose_workflow', arguments: { slug: 'mcp-workflow', mode: 'careful', args: { key: 'DEV-257' } } }))
      const step = parse(await client.callTool({ name: 'get_workflow_step', arguments: { slug: 'mcp-workflow', step: 'inspect', args: { key: 'DEV-257' } } }))
      expect(listed.some((workflow:any)=>workflow.slug==='mcp-workflow')).toBe(true)
      expect(needs.needs).toEqual({ mode: [{ slug:'careful',title:'Careful',entry:'Use the careful path?' }], arguments:['key'] })
      expect(JSON.stringify(composed)).not.toContain('Inspect {{key}}')
      expect(step.body).toBe('Inspect DEV-257.')
    } finally { await client.close(); await server.close() }
  })

  test('MCP file_issue refuses a call missing evidence with an actionable message', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'defect',
          what_happened: 'The command failed',
          expected: 'The command should succeed',
          reproduce_command: 'bun test',
          environment: 'macOS test fixture',
          not_established: 'The underlying cause is not established',
        },
      })
      expect(filed.isError).toBe(true)
      const message = ((filed as any).content[0] as { text: string }).text
      expect(message).toContain('evidence is required')
      expect(message).toContain('run ids, file:line pointers, or measured output')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('MCP note refuses outside a registered project', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({ name: 'note', arguments: { text: 'outside', new: true } })
      expect(filed.isError).toBe(true)
      expect(((filed as any).content[0] as { text: string }).text).toContain('no registered project contains')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('orch note files through hub with cwd and session anchors', () => {
    mkdirSync(join(dir, 'note-project'), { recursive: true })
    const cwd = realpathSync(join(dir, 'note-project'))
    upsertProject({ name: 'note-project', path: cwd, stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['NTE'], trunk: 'main' } })
    const hubDb = join(dir, 'note-cli-hub.db')
    migrateHub(hubDb)
    const filed = Bun.spawnSync([
      process.execPath, new URL('./cli.ts', import.meta.url).pathname,
      'note', 'CLI suggestion', '--new',
    ], {
      cwd,
      env: { ...process.env, HUB_DB: hubDb, ORCH_DB: process.env.ORCH_DB!,
        HUB_ORCH: new URL('../../bin/orch', import.meta.url).pathname,
        CLAUDE_CODE_SESSION_ID: 'note-cli-session' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(filed.exitCode, filed.stderr.toString()).toBe(0)
    expect(filed.stdout.toString()).toContain('note ')
    const listed = Bun.spawnSync([process.execPath, hubCli, 'note', 'list', '--project', 'note-project', '--json'], {
      cwd, env: { ...process.env, HUB_DB: hubDb, ORCH_DB: process.env.ORCH_DB!,
        HUB_ORCH: new URL('../../bin/orch', import.meta.url).pathname },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(listed.exitCode, listed.stderr.toString()).toBe(0)
    const notes = JSON.parse(listed.stdout.toString())
    expect(notes[0]).toMatchObject({ project: 'note-project', text: 'CLI suggestion' })
    expect(notes[0].anchors[0]).toMatchObject({ cwd, session_id: 'note-cli-session' })
  })

  test('orch note without a duplicate choice returns candidates and files nothing', () => {
    mkdirSync(join(dir, 'note-duplicate-project'), { recursive: true })
    const cwd = realpathSync(join(dir, 'note-duplicate-project'))
    upsertProject({ name: 'note-duplicate-project', path: cwd, stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['NDP'], trunk: 'main' } })
    const hubDb = join(dir, 'note-duplicate-hub.db')
    migrateHub(hubDb)
    const env = { ...process.env, HUB_DB: hubDb, ORCH_DB: process.env.ORCH_DB!,
      HUB_ORCH: new URL('../../bin/orch', import.meta.url).pathname }
    const hubFiled = Bun.spawnSync([
      process.execPath, hubCli, 'note', 'new', 'Collector loses active run intervals', '--new',
    ], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
    expect(hubFiled.exitCode, hubFiled.stderr.toString()).toBe(0)

    const offered = Bun.spawnSync([
      process.execPath, new URL('./cli.ts', import.meta.url).pathname,
      'note', 'Collector loses the active run interval',
    ], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    expect(offered.exitCode).not.toBe(0)
    expect(offered.stderr.toString()).toContain('possible duplicate notes:')
    expect(offered.stderr.toString()).toContain('Pass --same-as <id> or --new.')

    const listed = Bun.spawnSync([process.execPath, hubCli, 'note', 'list', '--project', 'note-duplicate-project', '--json'], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(JSON.parse(listed.stdout.toString())).toHaveLength(1)
  })

  test('the Stop hook lists only actionable notes through hub', () => {
    mkdirSync(join(dir, 'note-hook-project'), { recursive: true })
    const cwd = realpathSync(join(dir, 'note-hook-project'))
    upsertProject({ name: 'note-hook-project', path: cwd, stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['NHP'], trunk: 'main' } })
    const hubDb = join(dir, 'note-hook-hub.db')
    migrateHub(hubDb)
    const session = 'actionable-note-hook-session'
    const env = { ...process.env, HUB_DB: hubDb, ORCH_DB: process.env.ORCH_DB!,
      HUB_ORCH: new URL('../../bin/orch', import.meta.url).pathname,
      CLAUDE_CODE_SESSION_ID: session }
    const orchCli = new URL('./cli.ts', import.meta.url).pathname
    for (const text of ['Promoted hook note', 'Dropped hook note', 'Actionable hook note']) {
      const filed = Bun.spawnSync([process.execPath, orchCli, 'note', text, '--new'], {
        cwd, env, stdout: 'pipe', stderr: 'pipe',
      })
      expect(filed.exitCode, filed.stderr.toString()).toBe(0)
    }
    const listed = Bun.spawnSync([process.execPath, hubCli, 'note', 'list', '--project', 'note-hook-project', '--json'], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    const notes = JSON.parse(listed.stdout.toString()) as { id: number; text: string }[]
    const id = (text: string) => notes.find((note) => note.text === text)!.id
    for (const args of [
      ['note', 'promote', String(id('Promoted hook note'))],
      ['note', 'drop', String(id('Dropped hook note')), '--reason', 'resolved'],
    ]) {
      const changed = Bun.spawnSync([process.execPath, hubCli, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
      expect(changed.exitCode, changed.stderr.toString()).toBe(0)
    }

    const hook = Bun.spawnSync(['python3', new URL('../hooks/score-reminder.py', import.meta.url).pathname], {
      env, stdin: new TextEncoder().encode(JSON.stringify({ session_id: session })), stdout: 'pipe', stderr: 'pipe',
    })
    expect(hook.exitCode, hook.stderr.toString()).toBe(0)
    const reason = JSON.parse(hook.stdout.toString()).reason as string
    expect(reason).toContain('Actionable hook note')
    expect(reason).not.toContain('Promoted hook note')
    expect(reason).not.toContain('Dropped hook note')
  })

  test('MCP file_issue refuses a defect missing reproduce_command with an actionable message', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'defect',
          what_happened: 'The command failed',
          expected: 'The command should succeed',
          environment: 'macOS test fixture',
          evidence: 'run 123 failed with exit 1',
          not_established: 'The underlying cause is not established',
        },
      })
      expect(filed.isError).toBe(true)
      const message = ((filed as any).content[0] as { text: string }).text
      expect(message).toContain('reproduce_command is required')
      expect(message).toContain('exact command that reproduces or demonstrates the issue')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test.each(['evidence', 'not_established'])('MCP file_issue refuses a suggestion missing %s', async (field) => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const arguments_: Record<string, string> = {
        kind: 'suggestion',
        what_happened: 'Issue reports need a direct filing path',
        expected: `A report should land on the ${PLATFORM_SLUG} board`,
        evidence: 'orchestrator/src/mcp.ts:11 had only project and document tools',
        not_established: 'No priority or assignee has been established',
      }
      delete arguments_[field]
      const filed = await client.callTool({ name: 'file_issue', arguments: arguments_ })
      expect(filed.isError).toBe(true)
      const message = ((filed as any).content[0] as { text: string }).text
      expect(message).toContain(`${field} is required`)
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('MCP file_issue refuses an unknown reporter kind', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'suggestion',
          what_happened: 'An unrecognised process wants to file',
          expected: 'Only established reporter kinds can file',
          evidence: 'reporter_kind was synthetic',
          not_established: 'No identity contract exists for the synthetic kind',
          reporter_kind: 'synthetic',
        },
      })
      expect(filed.isError).toBe(true)
      expect(((filed as any).content[0] as { text: string }).text).toContain('reporter_kind')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test(`MCP file_issue files a fully attributed ${PLATFORM_SLUG} task through hub`, async () => {
    const hubDb = join(dir, 'file-issue-hub.db')
    const priorHubDb = process.env.HUB_DB
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    const priorRunId = process.env.ORCH_RUN_ID
    const priorRunToken = process.env.ORCH_RUN_TOKEN
    process.env.HUB_DB = hubDb
    migrateHub(hubDb)
    process.env.CLAUDE_CODE_SESSION_ID = 'reporting-test-session'
    process.env.ORCH_RUN_ID = '999999'
    process.env.ORCH_RUN_TOKEN = 'not-a-worker-token'
    upsertProject({
      name: PLATFORM_SLUG, path: join(dir, 'registered-outside-cwd'), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] },
    })
    const prior = Bun.spawnSync([
      new URL('../../bin/hub', import.meta.url).pathname,
      'task', 'new', '--project', PLATFORM_SLUG,
      '--title', '[SUGGESTION] Issue reporting needs a direct filing path',
      '--allow-duplicate', 'orchestrator file_issue test seed',
    ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
    expect(prior.exitCode).toBe(0)
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'suggestion',
          what_happened: 'Issue reports need a direct filing path',
          expected: `A report should land on the ${PLATFORM_SLUG} board`,
          evidence: 'orchestrator/src/mcp.ts:11 had only project and document tools',
          not_established: 'No priority or assignee has been established',
          reporting_project: PLATFORM_SLUG,
        },
      })
      expect(filed.isError).not.toBe(true)
      const result = JSON.parse(((filed as any).content[0] as { text: string }).text)
      expect(result).toMatchObject({
        key: 'DEV-2', kind: 'suggestion', reporter: 'session',
        reporter_id: 'reporting-test-session', session: 'reporting-test-session', project: PLATFORM_SLUG,
        duplicates: [{
          key: 'DEV-1', status: 'open',
          title: '[SUGGESTION] Issue reporting needs a direct filing path',
          score: expect.any(Number),
        }],
      })
      expect(Object.keys(result).sort()).toEqual([
        'duplicates', 'key', 'kind', 'monitor_invocation_id', 'project', 'reporter',
        'reporter_id', 'session', 'worker_run_id',
      ])
      const shown = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', result.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shown.exitCode).toBe(0)
      const shownTask = JSON.parse(shown.stdout.toString())
      const task = shownTask.task
      expect(task.title).toBe('[SUGGESTION] Issue reports need a direct filing path')
      expect(task.project).toBe(PLATFORM_SLUG)
      expect(task.body).toContain('TYPE: SUGGESTION')
      expect(task.body).toContain('REPORTING SESSION: reporting-test-session')
      expect(task.body).toContain(`REPORTING PROJECT: ${PLATFORM_SLUG}`)
      expect(task.body).not.toContain('HOW TO REPRODUCE')
      expect(task.body).not.toContain('Command:')
      expect(task.body).not.toContain('Environment:')
      expect(task.body).toContain('EVIDENCE\norchestrator/src/mcp.ts:11')
      expect(task.body).toContain('WHAT IS NOT ESTABLISHED\nNo priority or assignee has been established')
      expect(task.body).toContain(
        'SUSPECTED DUPLICATES\n- DEV-1 [open] [SUGGESTION] Issue reporting needs a direct filing path',
      )
      expect(task.body).not.toContain(String(result.duplicates[0].score))
      expect(shownTask.comments).toEqual([
        expect.objectContaining({ body: 'orchestrator file_issue' }),
      ])
    } finally {
      await client.close()
      await server.close()
      rmSync(hubDb, { force: true })
      rmSync(`${hubDb}-shm`, { force: true })
      rmSync(`${hubDb}-wal`, { force: true })
      if (priorHubDb === undefined) delete process.env.HUB_DB
      else process.env.HUB_DB = priorHubDb
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
      if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
      else process.env.ORCH_RUN_ID = priorRunId
      if (priorRunToken === undefined) delete process.env.ORCH_RUN_TOKEN
      else process.env.ORCH_RUN_TOKEN = priorRunToken
    }
  })

  test('file_issue files while making a failed duplicate search explicit in output and body', async () => {
    const hubDb = join(dir, 'file-issue-search-failure-hub.db')
    const priorHubDb = process.env.HUB_DB
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.HUB_DB = hubDb
    migrateHub(hubDb)
    process.env.CLAUDE_CODE_SESSION_ID = 'search-failure-session'
    upsertProject({
      name: PLATFORM_SLUG, path: process.cwd(), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] },
    })
    const realSpawn = Bun.spawn.bind(Bun)
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((args: string[], options: object) => {
      if (args.includes('duplicates')) {
        return { stdout: '', stderr: 'duplicate search unavailable', exited: Promise.resolve(1) }
      }
      return realSpawn(args, options as any)
    }) as any)
    try {
      const filed = await fileIssue({
        kind: 'suggestion', what_happened: 'Preserve a report when duplicate search is unavailable',
        expected: 'The report is filed and the failed search is explicit',
        evidence: 'the search subprocess returned exit 1',
        not_established: 'why the search subprocess failed',
      }, { kind: 'session' }, PLATFORM_SLUG)
      expect(filed).toMatchObject({
        key: 'DEV-1', duplicate_search_error: 'duplicate search unavailable',
      })
      expect(filed).not.toHaveProperty('duplicates')
      const shown = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', filed.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shown.exitCode).toBe(0)
      expect(JSON.parse(shown.stdout.toString()).task.body).toContain(
        'DUPLICATE SEARCH FAILED\nduplicate search unavailable',
      )
    } finally {
      spawn.mockRestore()
      rmSync(hubDb, { force: true })
      rmSync(`${hubDb}-shm`, { force: true })
      rmSync(`${hubDb}-wal`, { force: true })
      if (priorHubDb === undefined) delete process.env.HUB_DB
      else process.env.HUB_DB = priorHubDb
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    }
  })

  test('MCP file_issue derives worker provenance from the authenticated run environment', async () => {
    const hubDb = join(dir, 'worker-file-issue-hub.db')
    const priorHubDb = process.env.HUB_DB
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    const priorRunId = process.env.ORCH_RUN_ID
    const priorRunToken = process.env.ORCH_RUN_TOKEN
    process.env.HUB_DB = hubDb
    migrateHub(hubDb)
    delete process.env.CLAUDE_CODE_SESSION_ID
    upsertProject({
      name: PLATFORM_SLUG, path: process.cwd(), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] },
    })
    const runId = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET launch_cwd=?, launch_key=? WHERE id=?')
      .run(process.cwd(), 'DEV-218', runId)
    process.env.ORCH_RUN_ID = String(runId)
    process.env.ORCH_RUN_TOKEN = 'worker-file-token'
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const arguments_ = {
        kind: 'defect' as const,
        what_happened: 'A worker observed a reproducible failure',
        expected: 'The worker can preserve its finding directly',
        reproduce_command: 'bun test',
        environment: 'orch worker test fixture',
        evidence: `run ${runId} observed exit 1`,
        not_established: 'The underlying cause is not established',
      }
      const nullToken = await client.callTool({ name: 'file_issue', arguments: arguments_ })
      expect(nullToken.isError).toBe(true)
      expect(((nullToken as any).content[0] as { text: string }).text)
        .toContain('reporting session is not available')
      db().query('UPDATE run SET run_token=? WHERE id=?').run('worker-file-token', runId)
      process.env.ORCH_RUN_TOKEN = 'not-the-worker-token'
      const refused = await client.callTool({ name: 'file_issue', arguments: arguments_ })
      expect(refused.isError).toBe(true)
      expect(((refused as any).content[0] as { text: string }).text)
        .toContain('reporting session is not available')
      delete process.env.ORCH_RUN_ID
      delete process.env.ORCH_RUN_TOKEN
      const unidentified = await client.callTool({ name: 'file_issue', arguments: arguments_ })
      expect(unidentified.isError).toBe(true)
      expect(((unidentified as any).content[0] as { text: string }).text)
        .toContain('reporting session is not available')
      process.env.ORCH_RUN_ID = String(runId)
      process.env.ORCH_RUN_TOKEN = 'worker-file-token'
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: arguments_,
      })
      expect(filed.isError).not.toBe(true)
      const result = JSON.parse(((filed as any).content[0] as { text: string }).text)
      expect(result).toMatchObject({
        key: 'DEV-1', reporter: 'worker', reporter_id: `run:${runId}`,
        worker_run_id: runId, origin: 'DEV-218', session: null, project: PLATFORM_SLUG,
      })
      const shown = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', result.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shown.exitCode).toBe(0)
      const task = JSON.parse(shown.stdout.toString()).task
      expect(task.body).toStartWith(
        `Filed by orch run ${runId} (implement, codex) while working DEV-218\n`,
      )
      expect(task.body).toContain('REPORTER KIND: WORKER')
      expect(task.body).toContain(`REPORTING WORKER RUN: run:${runId}`)
      expect(task.body).toContain(`REPORTING PROJECT: ${PLATFORM_SLUG}`)
      expect(task.body).not.toContain('REPORTING SESSION:')

      db().query('UPDATE run SET launch_key=NULL WHERE id=?').run(runId)
      const keyless = await client.callTool({
        name: 'file_issue',
        arguments: { ...arguments_, what_happened: 'A keyless reader observed a reproducible failure' },
      })
      expect(keyless.isError).not.toBe(true)
      const keylessResult = JSON.parse(((keyless as any).content[0] as { text: string }).text)
      expect(keylessResult).toMatchObject({
        reporter: 'worker', worker_run_id: runId, origin: null, project: PLATFORM_SLUG,
      })
      const shownKeyless = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', keylessResult.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shownKeyless.exitCode).toBe(0)
      expect(JSON.parse(shownKeyless.stdout.toString()).task.body).toStartWith(
        `Filed by orch run ${runId} (implement, codex) while working with no task key\n`,
      )

      db().query('UPDATE run SET launch_cwd=NULL WHERE id=?').run(runId)
      const noProject = await client.callTool({
        name: 'file_issue',
        arguments: { ...arguments_, what_happened: 'A worker without a project observed a failure' },
      })
      expect(noProject.isError).toBe(true)
      expect(((noProject as any).content[0] as { text: string }).text)
        .toContain('reporting worker has no project origin')
    } finally {
      await client.close()
      await server.close()
      rmSync(hubDb, { force: true })
      rmSync(`${hubDb}-shm`, { force: true })
      rmSync(`${hubDb}-wal`, { force: true })
      if (priorHubDb === undefined) delete process.env.HUB_DB
      else process.env.HUB_DB = priorHubDb
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
      if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
      else process.env.ORCH_RUN_ID = priorRunId
      if (priorRunToken === undefined) delete process.env.ORCH_RUN_TOKEN
      else process.env.ORCH_RUN_TOKEN = priorRunToken
    }
  })

  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orchCli = (args: string[], stdin?: string) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }

  test('orch port exposes baseline, skip, ledger resolution, correction, and doctrine lifecycle', () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })

    expect(orchCli(['port', 'baseline', 'set', 'source-invented', 'target-invented', 'abc']).code).toBe(0)
    const baseline = orchCli(['port', 'baseline', 'show', 'source-invented', 'target-invented', '--json'])
    expect(JSON.parse(baseline.out).baseline.source_commit).toBe('abc')
    expect(orchCli(['port', 'skip', 'add', 'source-invented', 'target-invented', 'old-feature',
      '--reason', 'superseded']).code).toBe(0)
    expect(JSON.parse(orchCli(['port', 'skip', 'list', 'source-invented', 'target-invented', '--json']).out))
      .toMatchObject([{ candidate: 'old-feature', reason: 'superseded' }])

    const sources = JSON.stringify([
      { project: 'source-invented', commits: ['abc'], paths: ['src/a.ts'], note: 'origin' },
    ])
    expect(orchCli(['port', 'ref', 'set', 'TGT-7', '--sources', sources, '--note', 'native task']).code).toBe(0)
    const resolved = orchCli(['port', 'ref', 'resolve', 'TGT-7', '--json'])
    expect(JSON.parse(resolved.out)).toMatchObject({ task_key: 'TGT-7', resolved_at: expect.any(String) })
    expect(JSON.parse(orchCli(['port', 'ref', 'list', '--json']).out)).toEqual([])
    expect(JSON.parse(orchCli(['port', 'ref', 'list', '--all', '--json']).out)).toHaveLength(1)
    expect(orchCli(['port', 'ref', 'delete-error', 'TGT-7']).out).toContain('erroneous')
    expect(ledgerRef('TGT-7')).toBeNull()

    expect(orchCli(['port', 'doctrine', 'add', '4', '--title', 'Native', '--json'], 'Adapt natively.').code)
      .toBe(0)
    expect(orchCli(['port', 'doctrine', 'retire', '4']).code).toBe(0)
    expect(JSON.parse(orchCli(['port', 'doctrine', 'list', '--json']).out)).toEqual([])
    expect(JSON.parse(orchCli(['port', 'doctrine', 'list', '--all', '--json']).out))
      .toMatchObject([{ number: 4, retired_at: expect.any(String) }])
  }, 20_000)

  test('orch port refuses unknown registered project names and task prefixes', () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    const unknown = orchCli(['port', 'baseline', 'show', 'source-invented', 'missing'])
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('unknown project "missing"')
    const sources = JSON.stringify([
      { project: 'source-invented', commits: [], paths: [], note: '' },
    ])
    const prefix = orchCli(['port', 'ref', 'set', 'NONE-1', '--sources', sources, '--note', ''])
    expect(prefix.code).toBe(1)
    expect(prefix.err).toContain('no registered project owns task key')
  })

  test('nested command errors name the recognized group and list its verbs', () => {
    expect(orchCli(['port', 'doctrine', 'show', '7'])).toMatchObject({
      code: 1,
      err: expect.stringContaining('unknown: orch port doctrine show. Try list | add | retire'),
    })
    expect(orchCli(['port', 'ref'])).toMatchObject({
      code: 1,
      err: expect.stringContaining('unknown: orch port ref. Try list | show | set | resolve | delete-error'),
    })
    expect(orchCli(['review', 'inspect'])).toMatchObject({
      code: 1,
      err: expect.stringContaining('unknown: orch review inspect. Try tier | record | triage | complete | calibration'),
    })
    expect(orchCli(['review'])).toMatchObject({
      code: 1,
      err: expect.stringContaining('unknown: orch review. Try tier | record | triage | complete | calibration'),
    })
  }, 20_000)

  test('MCP port tools use registered names and preserve resolved provenance', async () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-port-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const value = (result: any) => JSON.parse((result.content[0] as { text: string }).text)
    try {
      await client.callTool({ name: 'set_port_baseline', arguments: {
        source: 'source-invented', target: 'target-invented', source_commit: 'abc',
      } })
      await client.callTool({ name: 'record_port_skip', arguments: {
        source: 'source-invented', target: 'target-invented', candidate: 'old', reason: 'done elsewhere',
      } })
      await client.callTool({ name: 'set_port_ledger_ref', arguments: {
        task_key: 'TGT-8', note: 'native', sources: [
          { project: 'source-invented', commits: ['abc'], paths: ['src/a.ts'], note: 'origin' },
        ],
      } })
      const resolved = await client.callTool({ name: 'resolve_port_ledger_ref',
        arguments: { task_key: 'TGT-8' } })
      expect(value(resolved)).toMatchObject({ task_key: 'TGT-8', resolved_at: expect.any(String) })
      const active = await client.callTool({ name: 'list_port_ledger_refs', arguments: {} })
      const all = await client.callTool({ name: 'list_port_ledger_refs',
        arguments: { include_resolved: true } })
      expect(value(active)).toEqual([])
      expect(value(all)).toMatchObject([{ task_key: 'TGT-8', sources: [{ commits: ['abc'] }] }])
      await client.callTool({ name: 'add_port_doctrine_rule',
        arguments: { number: 5, title: 'Native', body: 'Adapt natively.' } })
      await client.callTool({ name: 'retire_port_doctrine_rule', arguments: { number: 5 } })
      const doctrine = await client.callTool({ name: 'list_port_doctrine',
        arguments: { include_retired: true } })
      expect(value(doctrine)).toMatchObject([{ number: 5, retired_at: expect.any(String) }])
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('orch doc subjects --json lists project, agent and job names', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const r = orchCli(['doc', 'subjects', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({
      project: ['known'],
      agent: Object.keys(AGENTS).sort(),
      job: Object.keys(JOBS).sort(),
    })
    expect(docSubjects()).toEqual(JSON.parse(r.out))
  })

  test('orch doc rm --json reports whether a row was removed', () => {
    setDoc({ scope: 'global', subject: null, slug: 'gone', title: 'T', body: 'B' })
    const hit = orchCli(['doc', 'rm', 'gone', '--scope', 'global', '--reason', 'test', '--json'])
    expect(hit.code).toBe(0)
    expect(JSON.parse(hit.out)).toEqual({ removed: true })
    const miss = orchCli(['doc', 'rm', 'gone', '--scope', 'global', '--reason', 'test', '--json'])
    expect(miss.code).toBe(0)
    expect(JSON.parse(miss.out)).toEqual({ removed: false })
  })

  test('orch doc set --json round-trips a body with quote, backtick and newline', () => {
    const body = "quote' backtick` newline\n"
    const r = orchCli(
      ['doc', 'set', 'round-trip', '--scope', 'global', '--title', 'T', '--reason', 'test', '--json'],
      body,
    )
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).body).toBe(body)
    expect(getDoc('global', null, 'round-trip')?.body).toBe(body)
  })

  test('orch doc history, diff, and restore operate on revisions without rewinding', () => {
    writeDoc({ scope: 'global', subject: null, slug: 'cli-history', title: 'T', body: 'one\n', reason: 'first' })
    writeDoc({ scope: 'global', subject: null, slug: 'cli-history', title: 'T', body: 'two\n', reason: 'second' })
    const history = orchCli(['doc', 'history', 'global', '-', 'cli-history', '--json'])
    expect(history.code).toBe(0)
    const rows = JSON.parse(history.out)
    expect(rows.map((row: any) => row.reason)).toEqual(['second', 'first'])
    expect(rows[0]).toEqual({
      id: expect.any(Number), op: 'set', author: expect.any(String), reason: 'second',
      at: expect.any(String), bytes: 4,
    })
    const diff = orchCli(['doc', 'diff', 'global', '-', 'cli-history'])
    expect(diff.code).toBe(0)
    expect(diff.out).toContain('-one\n+two')
    deleteDoc('global', null, 'cli-history', { reason: 'gone' })
    const restored = orchCli([
      'doc', 'restore', 'global', '-', 'cli-history', String(rows[1].id), '--reason', 'undo delete',
    ])
    expect(restored.code).toBe(0)
    expect(getDoc('global', null, 'cli-history')?.body).toBe('one\n')
    expect(listDocRevisions('global', null, 'cli-history')[0]?.op).toBe('restore')
  }, 20_000)

  test('orch doc consume stamps the session and preserves the document outside its fields', () => {
    const body = '---\r\nstatus: open\r\nepic: demo\r\nproject: known\r\nwritten: 2026-09-03T00:00:00.000Z\r\n---\r\n\r\nNEXT ACTION  \r\n'
    setDoc({ scope: 'global', subject: null, slug: 'take-it', title: 'Take it', body })
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'consume-test-session'
    try {
      const r = orchCli(['doc', 'consume', 'take-it', '--scope', 'global', '--json'])
      expect(r.code).toBe(0)
      const result = JSON.parse(r.out)
      expect(result.already_consumed).toBe(false)
      const consumed = getDoc('global', null, 'take-it')!.body
      expect(consumed).toMatch(/^---\r\nstatus: consumed\r\nconsumed: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\r\nconsumed_by: consume-test-session\r\nepic:/)
      expect(consumed.slice(consumed.indexOf('epic:'))).toBe(body.slice(body.indexOf('epic:')))
      expect(parseResumeFrontmatter(consumed)).toMatchObject({
        status: 'consumed', consumed_by: 'consume-test-session',
      })
    } finally {
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    }
  })

  test('orch doc consume reports an already-consumed document without rewriting it', () => {
    const body = '---\nstatus: consumed\nconsumed: 2026-09-03T01:02:03.000Z\nconsumed_by: first-session\nepic: demo\n---\n\nBODY\n'
    setDoc({ scope: 'global', subject: null, slug: 'taken', title: 'Taken', body })
    const before = getDoc('global', null, 'taken')!
    const r = orchCli(['doc', 'consume', 'taken', '--scope', 'global', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).already_consumed).toBe(true)
    expect(getDoc('global', null, 'taken')).toEqual(before)
  })

  test('consumeDoc consults and patches a top-level open status after nested consumed status', () => {
    const body = '---\nmetadata:\n  status: consumed\nstatus: open\n---\n\nBODY\n'
    setDoc({ scope: 'global', subject: null, slug: 'top-open', title: 'Top open', body })

    const result = consumeDoc('global', null, 'top-open')

    expect(result.already_consumed).toBe(false)
    expect(result.body).toContain('metadata:\n  status: consumed\nstatus: consumed\n')
    expect(parseResumeFrontmatter(result.body)?.status).toBe('consumed')
  })

  test('consumeDoc patches the top-level status and leaves an earlier nested open status unchanged', () => {
    const body = '---\nmetadata:\n  status: open\nstatus: open\n---\n\nBODY\n'
    setDoc({ scope: 'global', subject: null, slug: 'both-open', title: 'Both open', body })

    const result = consumeDoc('global', null, 'both-open')

    expect(result.already_consumed).toBe(false)
    expect(result.body).toContain('metadata:\n  status: open\nstatus: consumed\n')
    expect(parseResumeFrontmatter(result.body)?.status).toBe('consumed')
  })

  test('consumeDoc rejects documents without frontmatter or a status field', () => {
    setDoc({ scope: 'global', subject: null, slug: 'plain', title: 'Plain', body: 'BODY\n' })
    setDoc({ scope: 'global', subject: null, slug: 'statusless', title: 'Statusless', body: '---\nepic: demo\n---\nBODY\n' })
    expect(() => consumeDoc('global', null, 'plain')).toThrow('has no YAML frontmatter')
    expect(() => consumeDoc('global', null, 'statusless')).toThrow('has no status field')
  })

  const resumeBody = (status: string, written?: string) => {
    const writtenLine = written ? `written: ${written}\n` : ''
    return `---\nstatus: ${status}\nepic: demo\nproject: known\n${writtenLine}---\n\nNEXT ACTION\n`
  }

  test('resumeAge uses a single largest unit', () => {
    const now = Date.parse('2026-09-03T12:00:00.000Z')
    expect(resumeAge(now, now)).toBe('0s')
    expect(resumeAge(now - 20_000, now)).toBe('20s')
    expect(resumeAge(now - 20 * 60_000, now)).toBe('20m')
    expect(resumeAge(now - 3 * 3600_000, now)).toBe('3h')
    expect(resumeAge(now - 3 * 86_400_000, now)).toBe('3d')
    expect(resumeAge(now - 59_000, now)).toBe('59s')
    expect(resumeAge(now - 60_000, now)).toBe('1m')
    expect(resumeAge(now - 3600_000, now)).toBe('1h')
    expect(resumeAge(now - 86_400_000, now)).toBe('1d')
  })

  test('parseResumeFrontmatter returns null only without a block and skips unreadable lines', () => {
    expect(parseResumeFrontmatter('no fence')).toBeNull()
    expect(parseResumeFrontmatter('---\nstatus open\n---\n')).toEqual({})
    expect(parseResumeFrontmatter(resumeBody('open', '2026-09-03T00:00:00.000Z'))).toEqual({
      status: 'open', epic: 'demo', project: 'known', written: '2026-09-03T00:00:00.000Z',
    })
  })

  test('listOpenResumes lists only open briefs for the cwd project, newest first', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    upsertProject({ name: 'other', path: '/w/other', stack: null, canon: true, settings: {} })
    const now = Date.parse('2026-09-03T12:00:00.000Z')
    setDoc({
      scope: 'resume', subject: 'known', slug: 'older', title: 'Older epic',
      body: resumeBody('open', '2026-09-01T12:00:00.000Z'),
    })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'newer', title: 'Newer epic',
      body: resumeBody('open', '2026-09-03T11:40:00.000Z'),
    })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'done', title: 'Consumed',
      body: resumeBody('consumed', '2026-09-03T11:50:00.000Z'),
    })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'broken', title: 'Broken',
      body: resumeBody('open'),
    })
    db().query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run('not frontmatter', 'resume', 'known', 'broken')
    setDoc({
      scope: 'resume', subject: 'other', slug: 'elsewhere', title: 'Other project',
      body: resumeBody('open', '2026-09-03T11:55:00.000Z'),
    })
    setDoc({
      scope: 'project', subject: 'known', slug: 'not-a-resume', title: 'Project doc',
      body: resumeBody('open', '2026-09-03T11:59:00.000Z'),
    })
    expect(listOpenResumes('/nowhere', now)).toEqual({ open: [], unreadable: [] })
    expect(listOpenResumes('/w/known/src', now)).toEqual({
      open: [
        { slug: 'newer', title: 'Newer epic', age: '20m', at: Date.parse('2026-09-03T11:40:00.000Z') },
        { slug: 'older', title: 'Older epic', age: '2d', at: Date.parse('2026-09-01T12:00:00.000Z') },
      ],
      unreadable: [{ slug: 'broken', reason: 'no-frontmatter' }],
    })
    expect(brief('/w/known/src')).not.toContain('Newer epic')
  })

  test('indented resume frontmatter cases A-D parse and list, with top-level keys winning', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const cases = [
      ['case-a', '---\nmetadata:\n  status: open\n  epic: nested\n---\n\nA', { status: 'open', epic: 'nested' }],
      ['case-b', '---\nstatus: open\nepic: flat\n---\n\nB', { status: 'open', epic: 'flat' }],
      ['case-c', '---\nstatus: open\nmetadata:\n  project: known\n---\n\nC', { status: 'open', project: 'known' }],
      ['case-d', '---\nstatus: open\nproject: a long\n  wrapped value\n---\n\nD', { status: 'open', project: 'a long' }],
    ] as const
    for (const [slug, body, expected] of cases) {
      setDoc({ scope: 'resume', subject: 'known', slug, title: slug, body: resumeBody('open') })
      db().query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
        .run(body, 'resume', 'known', slug)
      expect(parseResumeFrontmatter(body)).toEqual(expected)
    }
    const topWins = '---\nmetadata:\n  status: open\nstatus: consumed\n---\n\nDone'
    expect(parseResumeFrontmatter(topWins)?.status).toBe('consumed')
    setDoc({
      scope: 'resume', subject: 'known', slug: 'top-wins', title: 'top-wins',
      body: resumeBody('open'),
    })
    db().query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run(topWins, 'resume', 'known', 'top-wins')

    expect(listOpenResumes('/w/known').open.map((resume) => resume.slug).sort()).toEqual([
      'case-a', 'case-b', 'case-c', 'case-d',
    ])
  })

  test('the last duplicate top-level status controls listing and consumption', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'legacy-duplicate', title: 'Legacy duplicate',
      body: resumeBody('open'),
    })
    const duplicate = '---\nstatus: consumed\nstatus: open\nepic: demo\n---\n\nNEXT ACTION\n'
    db().query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run(duplicate, 'resume', 'known', 'legacy-duplicate')

    expect(parseResumeFrontmatter(duplicate)?.status).toBe('open')
    expect(listOpenResumes('/w/known').open.map((resume) => resume.slug)).toContain('legacy-duplicate')

    const consumed = consumeDoc('resume', 'known', 'legacy-duplicate')
    expect(consumed.already_consumed).toBe(false)
    expect(consumed.body).toContain('status: consumed\nstatus: consumed\n')
    expect(parseResumeFrontmatter(consumed.body)?.status).toBe('consumed')
    expect(listOpenResumes('/w/known').open.map((resume) => resume.slug)).not.toContain('legacy-duplicate')
  })

  test('the last nested status controls parsing, listing, and consumption', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const cases = [
      ['nested-open', '---\nmetadata:\n  status: consumed\ndetail:\n  status: open\n---\n\nBODY\n', 'open'],
      ['nested-consumed', '---\nmetadata:\n  status: open\ndetail:\n  status: consumed\n---\n\nBODY\n', 'consumed'],
      ['quoted-nested-open', '---\nmetadata:\n  status: "consumed"\ndetail:\n  status: \'open\'\n---\n\nBODY\n', 'open'],
      ['quoted-nested-consumed', '---\nmetadata:\n  status: \'open\'\ndetail:\n  status: "consumed"\n---\n\nBODY\n', 'consumed'],
    ] as const

    for (const [slug, body, status] of cases) {
      setDoc({
        scope: 'resume', subject: 'known', slug, title: slug,
        body: resumeBody('open'),
      })
      db().query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
        .run(body, 'resume', 'known', slug)

      expect(parseResumeFrontmatter(body)?.status).toBe(status)
      expect(listOpenResumes('/w/known').open.map((resume) => resume.slug).includes(slug))
        .toBe(status === 'open')

      const consumed = consumeDoc('resume', 'known', slug)
      expect(consumed.already_consumed).toBe(status === 'consumed')
      if (status === 'open') {
        expect(parseResumeFrontmatter(consumed.body)?.status).toBe('consumed')
        expect(listOpenResumes('/w/known').open.map((resume) => resume.slug)).not.toContain(slug)
      } else {
        expect(consumed.body).toBe(body)
        expect(consumed.body).not.toContain('consumed_by:')
      }
    }
  })

  test('round-three status forms still resolve and consume correctly', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const bodies = [
      '---\r\nstatus: "consumed"\r\nstatus: \'open\'\r\n---\r\n\r\nBODY',
      '---\nmetadata:\n  status: consumed\nstatus: open\n---\n\nBODY',
      '---\nstatus: "open"\n---\n\nBODY',
      '---\nmetadata:\n  status: open\n---\n\nBODY',
    ] as const

    for (const [index, body] of bodies.entries()) {
      const slug = `round-three-${index}`
      setDoc({ scope: 'global', subject: null, slug, title: slug, body })
      expect(parseResumeFrontmatter(body)?.status).toBe('open')
      const consumed = consumeDoc('global', null, slug)
      expect(consumed.already_consumed).toBe(false)
      expect(parseResumeFrontmatter(consumed.body)?.status).toBe('consumed')
      expect(consumed.body).toContain('consumed_by:')
    }
  })

  test('setDoc refuses a resume without readable top-level status', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    expect(() => setDoc({
      scope: 'resume', subject: 'known', slug: 'statusless', title: 'Statusless',
      body: '---\nepic: demo\n---\n',
    })).toThrow('resume doc "statusless" requires readable top-level YAML frontmatter')
    expect(() => setDoc({
      scope: 'resume', subject: 'known', slug: 'nested-only', title: 'Nested',
      body: '---\nmetadata:\n  status: open\n---\n',
    })).toThrow('"status: open" or "status: consumed"')
  })

  test('setDoc refuses duplicate top-level resume statuses and names the slug', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    expect(() => setDoc({
      scope: 'resume', subject: 'known', slug: 'duplicate-status', title: 'Duplicate',
      body: '---\nstatus: consumed\nstatus: open\n---\n',
    })).toThrow('resume doc "duplicate-status" has more than one top-level status field')
  })

  test('setDoc refuses an unrecognised resume status and names the value and the permitted two', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    expect(() => setDoc({
      scope: 'resume', subject: 'known', slug: 'pending-brief', title: 'Pending',
      body: resumeBody('pending'),
    })).toThrow('resume doc "pending-brief" has unrecognised status "pending"; permitted values are "open" and "consumed"')
  })

  test('setDoc accepts open and consumed resume status, including quoted forms', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const accepted = [
      ['plain-open', 'open', 'open'],
      ['plain-consumed', 'consumed', 'consumed'],
      ['double-quoted-open', '"open"', 'open'],
      ['single-quoted-open', "'open'", 'open'],
      ['double-quoted-consumed', '"consumed"', 'consumed'],
      ['single-quoted-consumed', "'consumed'", 'consumed'],
    ] as const
    for (const [slug, written, resolved] of accepted) {
      const doc = setDoc({
        scope: 'resume', subject: 'known', slug, title: slug, body: resumeBody(written),
      })
      expect(parseResumeFrontmatter(doc.body)?.status).toBe(resolved)
    }
  })

  test('listOpenResumes reports a stored unrecognised status as unreadable rather than dropping it', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'pending-brief', title: 'Pending',
      body: resumeBody('open'),
    })
    db().query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run(resumeBody('pending'), 'resume', 'known', 'pending-brief')

    expect(listOpenResumes('/w/known')).toEqual({
      open: [],
      unreadable: [{ slug: 'pending-brief', reason: 'unrecognised-status' }],
    })
  })

  test('orch doc resumes prints padded columns and is silent when there are none', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const empty = orchCli(['doc', 'resumes', '--cwd', '/w/known'])
    expect(empty.code).toBe(0)
    expect(empty.out).toBe('')
    const unresolved = orchCli(['doc', 'resumes', '--cwd', '/nowhere'])
    expect(unresolved.code).toBe(0)
    expect(unresolved.out).toBe('')
    setDoc({
      scope: 'resume', subject: 'known', slug: 'epic-name', title: 'Title here',
      body: resumeBody('open', new Date().toISOString()),
    })
    const listed = orchCli(['doc', 'resumes', '--cwd', '/w/known'])
    expect(listed.code).toBe(0)
    const age = listed.out.trim().split(/\s+/).pop()
    expect(listed.out).toBe(`${'epic-name'.padEnd(24)} ${'Title here'.padEnd(24)} ${age}\n`)
    expect(age).toMatch(/^\d+[smhd]$/)
    expect(listed.out).not.toContain('scope')
  }, 20_000)

  test('orch doc resumes reports unreadable briefs without changing human stdout', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    for (const [slug, body] of [
      ['no-frontmatter', 'BODY'],
      ['no-status', '---\nepic: demo\n---\n\nBODY'],
      ['pending-brief', resumeBody('pending')],
    ]) {
      setDoc({ scope: 'resume', subject: 'known', slug, title: slug, body: resumeBody('open') })
      db().query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
        .run(body, 'resume', 'known', slug)
    }
    const human = orchCli(['doc', 'resumes', '--cwd', '/w/known'])
    expect(human.code).toBe(0)
    expect(human.out).toBe('')
    expect(human.err).toContain('unreadable resume brief no-frontmatter: no-frontmatter')
    expect(human.err).toContain('unreadable resume brief no-status: no-readable-status')
    expect(human.err).toContain('unreadable resume brief pending-brief: unrecognised-status')

    const json = orchCli(['doc', 'resumes', '--cwd', '/w/known', '--json'])
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out)).toEqual({
      open: [],
      unreadable: [
        { slug: 'no-frontmatter', reason: 'no-frontmatter' },
        { slug: 'no-status', reason: 'no-readable-status' },
        { slug: 'pending-brief', reason: 'unrecognised-status' },
      ],
    })
    expect(json.err).toBe('')
  })
})
