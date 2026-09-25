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
  test('owned settings are visible only through their owner address locally', async () => {
    const owner = '01990000-0000-7000-8000-000000000092'
    const created = await writeDoc({
      scope: 'settings',
      subject: null,
      owner,
      slug: 'settings',
      title: 'settings',
      body: '{"permissions":{},"hooks":{}}\n',
      reason: 'prove settings owner visibility',
    })
    expect(
      listDocs({ scope: 'settings', subject: null }).some((row) => row.id === created.id),
    ).toBe(false)
    expect(listDocs({ scope: 'settings', subject: null, owner })).toContainEqual(created)
    expect(getDoc('settings', null, 'settings')).toBeNull()
    expect(getDoc('settings', null, 'settings', owner)?.id).toBe(created.id)
  })

  test('owned canon is visible only through its owner address locally', async () => {
    const owner = '01990000-0000-7000-8000-000000000091'
    const created = await writeDoc({
      scope: 'canon',
      subject: null,
      owner,
      slug: '.agents/rules/private-owner.md',
      title: 'Private owner',
      body: '---\ndescription: Private owner\n---\n\nPrivate rule.\n',
      reason: 'prove owner visibility',
      allowCanonBootstrap: true,
    })
    expect(listDocs({ scope: 'canon', subject: null }).some((row) => row.id === created.id)).toBe(
      false,
    )
    expect(listDocs({ scope: 'canon', subject: null, owner })).toContainEqual(created)
    expect(getDoc('canon', null, created.slug)).toBeNull()
    expect(getDoc('canon', null, created.slug, owner)?.id).toBe(created.id)
    expect(listDocRevisions('canon', null, created.slug)).toEqual([])
    expect(listDocRevisions('canon', null, created.slug, owner)).toHaveLength(1)
  })

  test('canon updates compare the exposed hosted revision in both local write checks', async () => {
    const created = await writeDoc({
      scope: 'canon',
      subject: null,
      slug: '.agents/rules/revision-token.md',
      title: 'Revision token',
      body: '---\ndescription: Revision token\n---\n\nCurrent rule.\n',
      reason: 'create revision token fixture',
      allowCanonBootstrap: true,
    })
    expect(created.revision).toMatch(/^[0-9a-f-]{36}$/)
    expect(listDocs({ scope: 'canon' })[0]?.revision).toBe(created.revision)
    expect(listDocMetadata({ scope: 'canon' })[0]?.revision).toBe(created.revision)

    await expect(
      writeDoc({
        scope: 'canon',
        subject: null,
        slug: created.slug,
        title: created.title,
        body: `${created.body}\nMore current guidance.\n`,
        reason: 'missing token',
      }),
    ).rejects.toThrow(`current revision ${created.revision}; pass --expect ${created.revision}`)

    const updated = await writeDoc({
      scope: 'canon',
      subject: null,
      slug: created.slug,
      title: created.title,
      body: `${created.body}\nMore current guidance.\n`,
      reason: 'matching token',
      expectedRevision: created.revision!,
    })
    expect(updated.revision).not.toBe(created.revision)
    await expect(
      writeDoc({
        scope: 'canon',
        subject: null,
        slug: created.slug,
        title: created.title,
        body: `${updated.body}\nLatest guidance.\n`,
        reason: 'stale token',
        expectedRevision: created.revision!,
      }),
    ).rejects.toThrow(`expected revision ${created.revision}, current revision ${updated.revision}`)
  })

  test('consume, remove, and restore refuse an optional stale revision', async () => {
    const created = await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'stale-verbs',
      title: 'Stale verbs',
      body: '---\nstatus: open\n---\n\nInitial.\n',
      delivery: 'demand',
      reason: 'create stale verb fixture',
    })
    const target = listDocRevisions('global', null, created.slug)[0]!.id
    const updated = await writeDoc({
      scope: 'global',
      subject: null,
      slug: created.slug,
      title: created.title,
      body: '---\nstatus: open\n---\n\nUpdated.\n',
      delivery: 'demand',
      reason: 'advance stale verb fixture',
      expectedRevision: created.revision!,
    })
    for (const write of [
      () =>
        consumeDocument('global', null, created.slug, {
          reason: 'stale consume',
          expectedRevision: created.revision!,
        }),
      () =>
        deleteDoc('global', null, created.slug, {
          reason: 'stale remove',
          expectedRevision: created.revision!,
        }),
      () =>
        restoreDoc('global', null, created.slug, target, {
          reason: 'stale restore',
          expectedRevision: created.revision!,
        }),
    ]) {
      await expect(write()).rejects.toThrow(
        `expected revision ${created.revision}, current revision ${updated.revision}`,
      )
    }
  })

  test('canon mutation reports a missing hosted revision without suggesting an unusable token', async () => {
    const created = await writeDoc({
      scope: 'canon',
      subject: null,
      slug: '.agents/rules/missing-hosted-revision.md',
      title: 'Missing hosted revision',
      body: '---\ndescription: Missing hosted revision\n---\n\nCurrent rule.\n',
      reason: 'create missing revision fixture',
      allowCanonBootstrap: true,
    })
    db().query('UPDATE doc_revision SET record_id=NULL WHERE doc_id=?').run(created.id)
    await expect(
      deleteDoc('canon', null, created.slug, { reason: 'remove broken fixture' }),
    ).rejects.toThrow(
      "this hosted row's latest revision is missing, so its revision cannot be checked\n" +
        'cleared by: orch record migrate',
    )
  })

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
        body: 'This was formerly different.\n\nCurrent behavior is direct.',
      }),
    ).resolves.toMatchObject({ body: expect.stringContaining('Current behavior is direct.') })
  })

  test('restore permits findings already present on the live user canon row', async () => {
    const owner = '01990000-0000-7000-8000-000000000092'
    const created = await writeDoc({
      scope: 'canon',
      subject: null,
      owner,
      slug: '.agents/rules/legacy-user.md',
      title: 'Legacy user canon',
      body: '---\ndescription: Legacy user canon\n---\n\nCurrent rule.\n',
      reason: 'create owned restore fixture',
      allowCanonBootstrap: true,
    })
    const revision = listDocRevisions('canon', null, created.slug, owner)[0]!
    const legacyBody = '---\ndescription: Legacy user canon\n---\n\nThis was formerly different.\n'
    db().query('UPDATE doc SET body=? WHERE id=?').run(legacyBody, created.id)
    db().query('UPDATE doc_revision SET body=? WHERE id=?').run(legacyBody, revision.id)

    await expect(
      restoreDoc(
        'canon',
        null,
        created.slug,
        revision.id,
        { reason: 'restore owned legacy revision', expectedRevision: created.revision! },
        owner,
      ),
    ).resolves.toMatchObject({ owner, body: legacyBody })
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
    await deleteDoc('canon', 'known', slug, {
      reason: 'make the historic row restorable',
      expectedRevision: projectDoc.revision!,
    })
    const deletedRevision = getDocRevision(listDocRevisions('canon', 'known', slug)[0]!.id)
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
        expectedRevision: deletedRevision!.record_id!,
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

  test('a four-row user write uses the harness load budget instead of the repo tier budget', async () => {
    const owner = '01990000-0000-7000-8000-000000000093'
    const prose = (minimum: number) => {
      const sentence = 'Keep this rule current.\n'
      return sentence.repeat(Math.ceil(minimum / sentence.length))
    }
    const rule = (name: string) => `---\ndescription: ${name}\nalways: true\n---\n${prose(7_000)}`
    const rows = [
      { slug: 'AGENTS.md', title: 'Personal entry', body: prose(15_000) },
      { slug: '.agents/rules/alpha.md', title: 'Alpha', body: rule('Alpha rule') },
      { slug: '.agents/rules/bravo.md', title: 'Bravo', body: rule('Bravo rule') },
      { slug: '.agents/rules/charlie.md', title: 'Charlie', body: rule('Charlie rule') },
    ]

    for (const row of rows.slice(0, 3)) {
      await writeDoc({
        scope: 'canon',
        subject: null,
        owner,
        ...row,
        reason: 'build owned budget fixture',
        allowCanonBootstrap: true,
      })
    }
    await expect(
      writeDoc({
        scope: 'canon',
        subject: null,
        owner,
        ...rows[3]!,
        reason: 'cross only repository tier budget',
      }),
    ).resolves.toMatchObject({ owner, slug: rows[3]!.slug })
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
