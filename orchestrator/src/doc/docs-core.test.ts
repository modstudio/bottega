import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consumeDoc, importDocs, removeDoc, setDoc } from '../../test/fixtures/docs.ts'
import { dir } from '../../test/fixtures/store.ts'
import { compilePack } from '../canon/canon.ts'
import { db } from '../database/db.ts'
import { retireProject, upsertProject } from '../project/projects.ts'
import {
  consumeDoc as consumeDocument,
  removeDoc as deleteDoc,
  diffDocRevisions,
  docsForRun,
  exportDocs,
  getDoc,
  getDocRevision,
  listDocMetadata,
  listDocRevisions,
  listDocs,
  importDocs as readDocs,
  restoreDoc,
  setDoc as writeDoc,
} from './docs.ts'

describe('scoped operator docs', () => {
  test('set refuses lint findings without changing the store', async () => {
    await expect(
      setDoc({
        scope: 'global',
        subject: null,
        slug: 'bad-prose',
        title: 'Bad prose',
        body: 'This was formerly different.',
      }),
    ).rejects.toThrow('remedy: state only the current rule')
    expect(getDoc('global', null, 'bad-prose')).toBeNull()
  })

  test('set permits a clean append to legacy findings', async () => {
    const stored = await setDoc({
      scope: 'global',
      subject: null,
      slug: 'legacy-prose',
      title: 'Legacy prose',
      body: 'Current.',
    })
    db().query('UPDATE doc SET body=? WHERE id=?').run('This was formerly different.', stored.id)
    await expect(
      setDoc({
        scope: 'global',
        subject: null,
        slug: 'legacy-prose',
        title: 'Legacy prose',
        body: 'This was formerly different.\n\nCurrent behaviour is direct.',
      }),
    ).resolves.toMatchObject({ body: expect.stringContaining('Current behaviour is direct.') })
  })

  test('set refuses a finding introduced while editing a legacy document', async () => {
    const stored = await setDoc({
      scope: 'global',
      subject: null,
      slug: 'legacy-edit',
      title: 'Legacy edit',
      body: 'Current.',
    })
    db().query('UPDATE doc SET body=? WHERE id=?').run('This was formerly different.', stored.id)
    await expect(
      setDoc({
        scope: 'global',
        subject: null,
        slug: 'legacy-edit',
        title: 'Legacy edit',
        body: 'This was formerly different.\n\nDEV-880 tracks this.',
      }),
    ).rejects.toThrow('contains a task key')
  })

  test('an unreadable unrelated checkout does not affect a project doc write', async () => {
    upsertProject({ name: 'known', path: process.cwd(), stack: null, canon: true, settings: {} })
    upsertProject({
      name: 'unreadable',
      path: '/dev/null',
      stack: null,
      canon: false,
      settings: {},
    })
    await expect(
      setDoc({
        scope: 'project',
        subject: 'known',
        slug: 'target-only',
        title: 'Target only',
        body: 'See `package.json`.',
      }),
    ).resolves.toMatchObject({ slug: 'target-only' })
  })

  test('CRUD round-trips and set is a uniqueness-preserving upsert', async () => {
    const first = await setDoc({
      scope: 'global',
      subject: null,
      slug: 'hello',
      title: 'Hello',
      body: 'one',
    })
    expect(getDoc('global', null, 'hello')?.body).toBe('one')
    const second = await setDoc({
      scope: 'global',
      subject: null,
      slug: 'hello',
      title: 'Hello again',
      body: 'two',
    })
    expect(second.id).toBe(first.id)
    expect(listDocs()).toHaveLength(1)
    expect(second.created_at).toBe(first.created_at)
    expect(second.body).toBe('two')
    expect(await removeDoc('global', null, 'hello')).toBe(true)
    expect(getDoc('global', null, 'hello')).toBeNull()
  })

  test('create, set, consume, delete, and restore append complete state revisions', async () => {
    const created = await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'revision-life',
      title: 'First',
      body: '---\nstatus: open\n---\n\none',
      delivery: 'demand',
      author: 'creator',
      reason: 'create it',
    })
    await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'revision-life',
      title: 'Second',
      body: '---\nstatus: open\n---\n\ntwo',
      delivery: 'demand',
      author: 'editor',
      reason: 'update it',
    })
    await consumeDoc('global', null, 'revision-life', { author: 'consumer', reason: 'finish it' })
    const beforeDelete = getDoc('global', null, 'revision-life')!
    await deleteDoc('global', null, 'revision-life', { author: 'deleter', reason: 'remove it' })
    await Bun.sleep(2)
    const restored = await restoreDoc(
      'global',
      null,
      'revision-life',
      listDocRevisions('global', null, 'revision-life').at(-1)!.id,
      { author: 'restorer', reason: 'bring it back' },
    )
    const revisions = listDocRevisions('global', null, 'revision-life').reverse()
    expect(revisions.map((revision) => revision.op)).toEqual([
      'create',
      'set',
      'consume',
      'delete',
      'restore',
    ])
    expect(revisions.map((revision) => revision.author)).toEqual([
      'creator',
      'editor',
      'consumer',
      'deleter',
      'restorer',
    ])
    expect(revisions.map((revision) => revision.reason)).toEqual([
      'create it',
      'update it',
      'finish it',
      'remove it',
      'bring it back',
    ])
    expect(getDocRevision(revisions[2]!.id)?.body).toContain('status: consumed')
    expect(getDocRevision(revisions[3]!.id)?.body).toBe(beforeDelete.body)
    expect(getDocRevision(revisions[1]!.id)?.delivery).toBe('demand')
    expect(restored.body).toBe('---\nstatus: open\n---\n\none')
    expect(restored.delivery).toBe('demand')
    expect(restored.updated_at).not.toBe(created.updated_at)
  })

  test('restore refuses a legacy global inject revision with the existing remedy', async () => {
    const legacy = await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'legacy-inject',
      title: 'Legacy',
      body: 'legacy',
      delivery: 'demand',
      reason: 'create revision shell',
    })
    db().query("UPDATE doc_revision SET delivery='inject' WHERE doc_id=?").run(legacy.id)
    const revision = listDocRevisions('global', null, 'legacy-inject')[0]!

    await expect(
      restoreDoc('global', null, 'legacy-inject', revision.id, { reason: 'restore legacy state' }),
    ).rejects.toThrow(
      'make the instruction canon, or write the operator document with delivery demand',
    )
  })

  test('restore refuses a canon path colliding with the other level', async () => {
    upsertProject({ name: 'known', path: process.cwd(), stack: null, canon: true, settings: {} })
    const slug = '.agents/rules/shared.md'
    const body = '---\ndescription: Shared rule\nalways: true\n---\n\nRule.\n'
    const projectDoc = await writeDoc({
      scope: 'canon',
      subject: 'known',
      slug,
      title: 'Project rule',
      body,
      reason: 'create project revision',
      allowCanonBootstrap: true,
    })
    const revision = listDocRevisions('canon', 'known', slug)[0]!
    await deleteDoc('canon', 'known', slug, { reason: 'make the historic row restorable' })
    await writeDoc({
      scope: 'canon',
      subject: null,
      slug,
      title: 'Global rule',
      body,
      reason: 'occupy the global path',
      allowCanonBootstrap: true,
    })

    await expect(
      restoreDoc('canon', 'known', projectDoc.slug, revision.id, {
        reason: 'restore colliding project rule',
      }),
    ).rejects.toThrow('refusing canon path collision')
  })

  test('global canon writes are linted without a canon-enabled project', async () => {
    await expect(
      writeDoc({
        scope: 'canon',
        subject: null,
        slug: '.agents/rules/unlinted.md',
        title: 'Unlinted',
        body: 'Rule without required metadata.\n',
        reason: 'prove global-only lint gate',
      }),
    ).rejects.toThrow('refusing canon write; introduced')
  })

  test('write reasons are required and author defaults to the session or unknown', async () => {
    await expect(
      writeDoc({
        scope: 'global',
        subject: null,
        slug: 'no-reason',
        title: 'T',
        body: 'B',
        delivery: 'demand',
        reason: '  ',
      }),
    ).rejects.toThrow('reason is required')
    await expect(consumeDocument('global', null, 'missing', { reason: '' })).rejects.toThrow(
      'reason is required',
    )
    await expect(deleteDoc('global', null, 'missing', { reason: '\t' })).rejects.toThrow(
      'reason is required',
    )
    await expect(readDocs('/missing', { reason: ' ' })).rejects.toThrow('reason is required')

    // sessionId() used to fall back to the Remote Control bridge id, which is
    // set in a real Claude shell; clear the primary or the "unknown" branch
    // never runs.
    const before = process.env.CLAUDE_CODE_SESSION_ID
    const bridgeBefore = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      process.env.CLAUDE_CODE_SESSION_ID = 'doc-session'
      await writeDoc({
        scope: 'global',
        subject: null,
        slug: 'session-author',
        title: 'T',
        body: 'B',
        delivery: 'demand',
        reason: 'test',
      })
      delete process.env.CLAUDE_CODE_SESSION_ID
      delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
      await writeDoc({
        scope: 'global',
        subject: null,
        slug: 'unknown-author',
        title: 'T',
        body: 'B',
        delivery: 'demand',
        reason: 'test',
      })
      expect(listDocRevisions('global', null, 'session-author')[0]!.author).toBe('doc-session')
      expect(listDocRevisions('global', null, 'unknown-author')[0]!.author).toBe('unknown')
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = before
      if (bridgeBefore === undefined) delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
      else process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = bridgeBefore
    }
  })

  test('revision diff renders a one-line replacement', async () => {
    await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'diffed',
      title: 'T',
      body: 'one\n',
      delivery: 'demand',
      reason: 'first',
    })
    await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'diffed',
      title: 'T',
      body: 'two\n',
      delivery: 'demand',
      reason: 'second',
    })
    const [latest, previous] = listDocRevisions('global', null, 'diffed')
    expect(diffDocRevisions(previous!.id, latest!.id)).toContain('-one\n+two')
  })

  test('history and restore survive retirement of the addressed project', async () => {
    upsertProject({ name: 'former', path: '/w/former', stack: null, canon: true, settings: {} })
    await setDoc({
      scope: 'project',
      subject: 'former',
      slug: 'historic',
      title: 'Historic',
      body: 'kept',
    })
    await removeDoc('project', 'former', 'historic')
    expect(retireProject('former')).toBe('retired')

    expect(
      listDocRevisions('project', 'former', 'historic').map((revision) => revision.op),
    ).toEqual(['delete', 'create'])
    expect(
      await restoreDoc(
        'project',
        'former',
        'historic',
        listDocRevisions('project', 'former', 'historic').find(
          (revision) => revision.op === 'create',
        )!.id,
        { reason: 'restore after retiring' },
      ),
    ).toMatchObject({
      id: expect.any(Number),
      scope: 'project',
      subject: 'former',
      slug: 'historic',
      body: 'kept',
    })
  })

  test('consume survives retirement of the addressed project', async () => {
    upsertProject({ name: 'former', path: '/w/former', stack: null, canon: true, settings: {} })
    await setDoc({
      scope: 'resume',
      subject: 'former',
      slug: 'epic',
      title: 'Resume',
      body: '---\nstatus: open\n---\n\nresume',
    })
    await setDoc({
      scope: 'project',
      subject: 'former',
      slug: 'note',
      title: 'Project',
      body: '---\nstatus: open\n---\n\nproject',
    })
    expect(retireProject('former')).toBe('retired')

    expect((await consumeDoc('resume', 'former', 'epic')).body).toContain('status: consumed')
    expect((await consumeDoc('project', 'former', 'note')).body).toContain('status: consumed')
    expect(listDocRevisions('resume', 'former', 'epic')[0]?.op).toBe('consume')
    expect(listDocRevisions('project', 'former', 'note')[0]?.op).toBe('consume')
  })

  test('scope, slug, and every subject rule name a usable fix', async () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const put = (scope: string, subject: string | null, slug = 'ok') =>
      setDoc({
        scope,
        subject,
        slug,
        title: 'T',
        body: scope === 'resume' ? '---\nstatus: open\n---\n\nB' : 'B',
      })
    await expect(put('global', null, 'Bad')).rejects.toThrow('1-64')
    await expect(put('global', null, 'a'.repeat(65))).rejects.toThrow('1-64')
    await expect(put('unknown', null)).rejects.toThrow('valid scopes')
    await expect(put('project', 'missing')).rejects.toThrow('valid values: known')
    await expect(put('agent', 'missing')).rejects.toThrow(`valid values:`)
    await expect(put('job', 'missing')).rejects.toThrow(`valid values:`)
    await expect(put('machine', 'host')).rejects.toThrow('remove --subject')
    await expect(put('global', 'all')).rejects.toThrow('remove --subject')
    await expect(put('project', null)).rejects.toThrow('require --subject')
    await expect(put('resume', null)).rejects.toThrow('require --subject')
    await expect(put('resume', 'missing')).rejects.toThrow('valid values: known')
    expect((await put('resume', 'known')).scope).toBe('resume')
  })

  test('docsForRun injects job docs and omits demand and non-run scopes', async () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    expect(docsForRun({ job: 'file-question', cwd: '/elsewhere' })).toEqual([])
    await setDoc({
      scope: 'project',
      subject: 'known',
      slug: 'project',
      title: 'Project',
      body: 'P',
    })
    await setDoc({ scope: 'job', subject: 'file-question', slug: 'job', title: 'Job', body: 'J' })
    await setDoc({ scope: 'global', subject: null, slug: 'global', title: 'Global', body: 'G' })
    await setDoc({ scope: 'agent', subject: 'codex', slug: 'agent', title: 'Agent', body: 'A' })
    await setDoc({ scope: 'machine', subject: null, slug: 'machine', title: 'Machine', body: 'M' })
    await setDoc({
      scope: 'resume',
      subject: 'known',
      slug: 'epic',
      title: 'Resume',
      body: '---\nstatus: open\n---\n\nR',
    })
    expect(docsForRun({ job: 'file-question', cwd: '/w/known/src' }).map((d) => d.title)).toEqual([
      'Job',
    ])
  })

  test('delivery is round-tripped and demand docs never enter a compiled pack', async () => {
    upsertProject({ name: 'known', path: dir, stack: null, canon: true, settings: {} })
    await setDoc({
      scope: 'machine',
      subject: null,
      slug: 'injected',
      title: 'Injected',
      body: 'é',
    })
    await setDoc({
      scope: 'global',
      subject: null,
      slug: 'demand',
      title: 'Demand',
      body: 'large',
      delivery: 'demand',
    })
    await setDoc({ scope: 'job', subject: 'understand', slug: 'job', title: 'Job', body: 'J' })
    await setDoc({
      scope: 'project',
      subject: 'known',
      slug: 'project',
      title: 'Project',
      body: 'P',
    })
    const pack = compilePack({ job: 'understand', cwd: dir })
    expect(pack.docs.map((doc) => doc.title)).toEqual(['Job'])
    expect(pack.docs.every((doc) => doc.revisionId > 0)).toBe(true)
    expect(pack.bytes).toBe(Buffer.byteLength(pack.markdown))
    expect(pack.sha256).toHaveLength(64)
    expect(getDoc('global', null, 'demand')?.delivery).toBe('demand')
    expect(docsForRun({ job: 'understand', cwd: dir }).map((doc) => doc.slug)).not.toContain(
      'demand',
    )
  })

  test('setDoc closes project and global inject while allowing canon and estate facts', async () => {
    upsertProject({ name: 'known', path: dir, stack: null, canon: false, settings: {} })
    for (const [scope, subject] of [
      ['global', null],
      ['project', 'known'],
    ] as const) {
      await expect(
        writeDoc({
          scope,
          subject,
          slug: `refused-${scope}`,
          title: 'Refused',
          body: 'B',
          delivery: 'inject',
          reason: 'test refusal',
        }),
      ).rejects.toThrow(
        'make the instruction canon, or write the operator document with delivery demand',
      )
    }
    expect(
      (
        await writeDoc({
          scope: 'canon',
          subject: null,
          slug: '.agents/rules/global.md',
          title: 'Global canon',
          body: '---\ndescription: Global\n---\n\nRule.\n',
          delivery: 'inject',
          reason: 'test global canon',
          allowCanonBootstrap: true,
        })
      ).scope,
    ).toBe('canon')
    for (const [scope, subject] of [
      ['machine', null],
      ['agent', 'codex'],
      ['job', 'understand'],
    ] as const) {
      expect(
        (
          await writeDoc({
            scope,
            subject,
            slug: `allowed-${scope}`,
            title: 'Allowed',
            body: 'B',
            delivery: 'inject',
            reason: 'test estate fact',
          })
        ).delivery,
      ).toBe('inject')
    }
  })

  test('inject estate facts above 8 KiB refuse unless force-inject; demand of any size succeeds', async () => {
    const body = 'x'.repeat(9 * 1024)
    await expect(
      setDoc({
        scope: 'job',
        subject: 'understand',
        slug: 'inject-too-big',
        title: 'Too big',
        body,
        delivery: 'inject',
      }),
    ).rejects.toThrow(
      /inject document is \d+ bytes; threshold is 8192 bytes; current pack is \d+ bytes with -?\d+ bytes headroom/,
    )
    await expect(
      setDoc({
        scope: 'job',
        subject: 'understand',
        slug: 'inject-too-big',
        title: 'Too big',
        body,
        delivery: 'inject',
      }),
    ).rejects.toThrow('invariant: oversized narrative belongs on demand')
    await expect(
      setDoc({
        scope: 'job',
        subject: 'understand',
        slug: 'inject-too-big',
        title: 'Too big',
        body,
        delivery: 'inject',
      }),
    ).rejects.toThrow('cleared by: use --delivery demand')
    const forced = await setDoc({
      scope: 'job',
      subject: 'understand',
      slug: 'inject-forced',
      title: 'Forced',
      body,
      delivery: 'inject',
      forceInject: 'operator override',
    })
    expect(forced.delivery).toBe('inject')
    const demand = await setDoc({
      scope: 'global',
      subject: null,
      slug: 'demand-any-size',
      title: 'Demand',
      body: 'y'.repeat(20 * 1024),
      delivery: 'demand',
    })
    expect(demand.delivery).toBe('demand')
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
})
