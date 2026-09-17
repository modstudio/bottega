import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importDocs, setDoc } from '../../test/fixtures/docs.ts'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../db.ts'
import { docsForRun, exportDocs, getDoc, listDocMetadata } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import {
  compilePack,
  findingsForPack,
  allNumericLiterals as inspectNumericLiterals,
  numericLiteralReport,
} from './canon.ts'

describe('scoped operator docs', () => {
  test('numeric literal report classifies per clause and excludes non-prose spans', () => {
    const cases: { text: string; expected: [string, string][] }[] = [
      { text: 'The suite currently has 6,676 tests.', expected: [['6,676', 'RESTATED']] },
      { text: 'The service listens on port 5432.', expected: [['5432', 'RESTATED']] },
      { text: 'Bun 1.3.14 is installed.', expected: [['1.3.14', 'RESTATED']] },
      { text: 'Qwen3.6 is installed.', expected: [['Qwen3.6', 'RESTATED']] },
      { text: 'The default is 5.', expected: [['5', 'OWNED']] },
      {
        text: 'This policy defines and enforces the threshold of 15.',
        expected: [['15', 'OWNED']],
      },
      { text: 'A product admits at most 1 tag.', expected: [['1', 'OWNED']] },
      { text: 'A change under 10% is reported as flat.', expected: [['10%', 'OWNED']] },
      { text: 'The gate asserts 170 characters.', expected: [['170', 'CHECKED']] },
      { text: 'The check refuses 51 lines.', expected: [['51', 'CHECKED']] },
      { text: 'This check caps output at 20 bytes.', expected: [['20', 'CHECKED']] },
      {
        text: 'Run 1565 measured 36,058 rows.',
        expected: [
          ['1565', 'EVIDENCE'],
          ['36,058', 'EVIDENCE'],
        ],
      },
      { text: 'We observed 42 rows.', expected: [['42', 'EVIDENCE']] },
      { text: 'The sample measured 80 bytes.', expected: [['80', 'EVIDENCE']] },
      { text: 'The incident had 22 files.', expected: [['22', 'UNCLASSIFIED']] },
      { text: 'Build 4 succeeded.', expected: [['4', 'UNCLASSIFIED']] },
      { text: 'Option 7 is preferred.', expected: [['7', 'UNCLASSIFIED']] },
      { text: 'Version 2 was used during the incident.', expected: [['2', 'UNCLASSIFIED']] },
      {
        text: 'Do not trust the claim that the suite has 900 tests.',
        expected: [['900', 'UNCLASSIFIED']],
      },
      {
        text: 'Its 22 files are recoverable from the old commit.',
        expected: [['22', 'UNCLASSIFIED']],
      },
      {
        text: 'Run 279 is the case: 409 seconds, 57 bytes back.',
        expected: [
          ['279', 'EVIDENCE'],
          ['409', 'EVIDENCE'],
          ['57', 'UNCLASSIFIED'],
        ],
      },
      {
        text: 'Runs 378 and 379 did work and reported 452 rows.',
        expected: [
          ['378', 'EVIDENCE'],
          ['379', 'UNCLASSIFIED'],
          ['452', 'UNCLASSIFIED'],
        ],
      },
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
      {
        text: 'The gate checks 50 files and Bun 1.3.14 is installed.',
        expected: [
          ['50', 'CHECKED'],
          ['1.3.14', 'RESTATED'],
        ],
      },
      {
        text: 'Run 7 measured 40 rows, but the suite has 900 tests.',
        expected: [
          ['7', 'EVIDENCE'],
          ['40', 'EVIDENCE'],
          ['900', 'RESTATED'],
        ],
      },
      { text: 'The year 2020 changed everything.', expected: [['2020', 'UNCLASSIFIED']] },
    ]
    for (const row of cases) {
      const report = numericLiteralReport(row.text, 'fixture')
      expect(
        report.map(({ numeral, classification }) => [numeral, classification]),
        row.text,
      ).toEqual(row.expected)
      expect(report.every((hit) => hit.source === 'fixture')).toBe(true)
    }
  })

  test('docsForRun refuses a document whose provenance was bypassed', () => {
    db()
      .query(
        `INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at)
       VALUES ('global', NULL, 'untracked', 'Untracked', 'body', ?, ?)`,
      )
      .run('2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')
    expect(() => docsForRun({ job: 'file-question', cwd: '/elsewhere' })).toThrow(
      'doc global/_/untracked has no revision; refusing run',
    )
  })

  test('metadata listing omits bodies and supports discovery filters without widening exact matches', async () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    await setDoc({
      scope: 'project',
      subject: 'known',
      slug: 'mcp-scope',
      title: 'MCP Scope',
      body: 'first',
    })
    await setDoc({
      scope: 'agent',
      subject: 'codex',
      slug: 'capabilities',
      title: 'Capabilities',
      body: 'MCP scoping details',
    })
    await setDoc({ scope: 'global', subject: null, slug: 'other', title: 'Other', body: 'é' })
    db().query('UPDATE doc SET updated_at=? WHERE slug=?').run('2026-09-01T00:00:00.000Z', 'other')
    db()
      .query('UPDATE doc SET updated_at=? WHERE slug=?')
      .run('2026-09-03T00:00:00.000Z', 'mcp-scope')
    db()
      .query('UPDATE doc SET updated_at=? WHERE slug=?')
      .run('2026-09-02T00:00:00.000Z', 'capabilities')

    expect(listDocMetadata({ scope: 'project' }).map((d) => d.slug)).toEqual(['mcp-scope'])
    expect(listDocMetadata({ subject: 'known' }).map((d) => d.slug)).toEqual(['mcp-scope'])
    expect(listDocMetadata({ match: 'mCp ScOpE' }).map((d) => d.slug)).toEqual(['mcp-scope'])
    expect(listDocMetadata({ bodyMatch: 'mCp ScOpInG' }).map((d) => d.slug)).toEqual([
      'capabilities',
    ])
    expect(listDocMetadata({ scopes: ['agent', 'project'] }).map((d) => d.scope)).toEqual([
      'agent',
      'project',
    ])
    expect(listDocMetadata({ updatedAtOrder: 'asc' }).map((d) => d.slug)).toEqual([
      'other',
      'capabilities',
      'mcp-scope',
    ])
    expect(listDocMetadata().find((d) => d.slug === 'other')).toMatchObject({ bytes: 2 })
    expect(listDocMetadata()).not.toContainKeys(['body', 'created_at'])
    expect(() => listDocMetadata({ scope: 'global', scopes: ['global'] })).toThrow(
      'scope or scopes',
    )
  })

  test('export and import preserve title and markdown body', async () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    await setDoc({
      scope: 'global',
      subject: null,
      slug: 'quoted',
      title: 'A "title"',
      body: '# Body\n\nText\n',
    })
    await setDoc({
      scope: 'project',
      subject: 'known',
      slug: 'project',
      title: 'Project',
      body: 'Estate',
    })
    const target = mkdtempSync(join(tmpdir(), 'orch-doc-export-'))
    try {
      expect(exportDocs(target)).toBe(2)
      db().exec('DELETE FROM doc')
      expect(await importDocs(target)).toBe(2)
      expect(getDoc('global', null, 'quoted')).toMatchObject({
        title: 'A "title"',
        body: '# Body\n\nText\n',
      })
      expect(getDoc('project', 'known', 'project')?.body).toBe('Estate')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  test('canon check keeps its exit-zero JSON contract for a missing cwd', () => {
    const missing = join(dir, 'numeric-missing-cwd')
    expect(
      findingsForPack(compilePack({ job: 'understand', cwd: missing })).flatMap(
        (row) => row.findings,
      ),
    ).toEqual([])
    expect(inspectNumericLiterals(missing)).toEqual({
      numericLiterals: [],
      canonFiles: { read: [], missing: [] },
    })
  })
})
