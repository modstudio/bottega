import { describe, expect, test } from 'bun:test'
import { consumeDoc, removeDoc, setDoc } from '../test/fixtures/docs.ts'
import { dir } from '../test/fixtures/store.ts'
import { compilePack } from './canon.ts'
import { db } from './db.ts'
import {
  consumeDoc as consumeDocument,
  removeDoc as deleteDoc,
  diffDocRevisions,
  docsForRun,
  getDoc,
  getDocRevision,
  listDocRevisions,
  listDocs,
  importDocs as readDocs,
  restoreDoc,
  setDoc as writeDoc,
} from './docs.ts'
import { retireProject, upsertProject } from './projects.ts'

describe('scoped operator docs', () => {
  test('CRUD round-trips and set is a uniqueness-preserving upsert', () => {
    const first = setDoc({
      scope: 'global',
      subject: null,
      slug: 'hello',
      title: 'Hello',
      body: 'one',
    })
    expect(getDoc('global', null, 'hello')?.body).toBe('one')
    const second = setDoc({
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
    expect(removeDoc('global', null, 'hello')).toBe(true)
    expect(getDoc('global', null, 'hello')).toBeNull()
  })

  test('create, set, consume, delete, and restore append complete state revisions', async () => {
    const created = writeDoc({
      scope: 'global',
      subject: null,
      slug: 'revision-life',
      title: 'First',
      body: '---\nstatus: open\n---\n\none',
      delivery: 'demand',
      author: 'creator',
      reason: 'create it',
    })
    writeDoc({
      scope: 'global',
      subject: null,
      slug: 'revision-life',
      title: 'Second',
      body: '---\nstatus: open\n---\n\ntwo',
      delivery: 'demand',
      author: 'editor',
      reason: 'update it',
    })
    consumeDoc('global', null, 'revision-life', { author: 'consumer', reason: 'finish it' })
    const beforeDelete = getDoc('global', null, 'revision-life')!
    deleteDoc('global', null, 'revision-life', { author: 'deleter', reason: 'remove it' })
    await Bun.sleep(2)
    const restored = restoreDoc(
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

  test('restore refuses a legacy global inject revision with the existing remedy', () => {
    const legacy = writeDoc({
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

    expect(() =>
      restoreDoc('global', null, 'legacy-inject', revision.id, { reason: 'restore legacy state' }),
    ).toThrow('make the instruction canon, or write the operator document with delivery demand')
  })

  test('restore refuses a canon path colliding with the other level', () => {
    upsertProject({ name: 'known', path: process.cwd(), stack: null, canon: true, settings: {} })
    const slug = '.agents/rules/shared.md'
    const body = '---\ndescription: Shared rule\nalways: true\n---\n\nRule.\n'
    const projectDoc = writeDoc({
      scope: 'canon',
      subject: 'known',
      slug,
      title: 'Project rule',
      body,
      reason: 'create project revision',
      allowCanonBootstrap: true,
    })
    const revision = listDocRevisions('canon', 'known', slug)[0]!
    deleteDoc('canon', 'known', slug, { reason: 'make the historic row restorable' })
    writeDoc({
      scope: 'canon',
      subject: null,
      slug,
      title: 'Global rule',
      body,
      reason: 'occupy the global path',
      allowCanonBootstrap: true,
    })

    expect(() =>
      restoreDoc('canon', 'known', projectDoc.slug, revision.id, {
        reason: 'restore colliding project rule',
      }),
    ).toThrow('refusing canon path collision')
  })

  test('global canon writes are linted without a canon-enabled project', () => {
    expect(() =>
      writeDoc({
        scope: 'canon',
        subject: null,
        slug: '.agents/rules/unlinted.md',
        title: 'Unlinted',
        body: 'Rule without required metadata.\n',
        reason: 'prove global-only lint gate',
      }),
    ).toThrow('refusing canon write; introduced')
  })

  test('write reasons are required and author defaults to the session or unknown', () => {
    expect(() =>
      writeDoc({
        scope: 'global',
        subject: null,
        slug: 'no-reason',
        title: 'T',
        body: 'B',
        delivery: 'demand',
        reason: '  ',
      }),
    ).toThrow('reason is required')
    expect(() => consumeDocument('global', null, 'missing', { reason: '' })).toThrow(
      'reason is required',
    )
    expect(() => deleteDoc('global', null, 'missing', { reason: '\t' })).toThrow(
      'reason is required',
    )
    expect(() => readDocs('/missing', { reason: ' ' })).toThrow('reason is required')

    // sessionId() used to fall back to the Remote Control bridge id, which is
    // set in a real Claude shell; clear the primary or the "unknown" branch
    // never runs.
    const before = process.env.CLAUDE_CODE_SESSION_ID
    const bridgeBefore = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      process.env.CLAUDE_CODE_SESSION_ID = 'doc-session'
      writeDoc({
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
      writeDoc({
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

  test('revision diff renders a one-line replacement', () => {
    writeDoc({
      scope: 'global',
      subject: null,
      slug: 'diffed',
      title: 'T',
      body: 'one\n',
      delivery: 'demand',
      reason: 'first',
    })
    writeDoc({
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

  test('history and restore survive retirement of the addressed project', () => {
    upsertProject({ name: 'former', path: '/w/former', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'project',
      subject: 'former',
      slug: 'historic',
      title: 'Historic',
      body: 'kept',
    })
    removeDoc('project', 'former', 'historic')
    expect(retireProject('former')).toBe('retired')

    expect(
      listDocRevisions('project', 'former', 'historic').map((revision) => revision.op),
    ).toEqual(['delete', 'create'])
    expect(
      restoreDoc(
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

  test('consume survives retirement of the addressed project', () => {
    upsertProject({ name: 'former', path: '/w/former', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume',
      subject: 'former',
      slug: 'epic',
      title: 'Resume',
      body: '---\nstatus: open\n---\n\nresume',
    })
    setDoc({
      scope: 'project',
      subject: 'former',
      slug: 'note',
      title: 'Project',
      body: '---\nstatus: open\n---\n\nproject',
    })
    expect(retireProject('former')).toBe('retired')

    expect(consumeDoc('resume', 'former', 'epic').body).toContain('status: consumed')
    expect(consumeDoc('project', 'former', 'note').body).toContain('status: consumed')
    expect(listDocRevisions('resume', 'former', 'epic')[0]?.op).toBe('consume')
    expect(listDocRevisions('project', 'former', 'note')[0]?.op).toBe('consume')
  })

  test('scope, slug, and every subject rule name a usable fix', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const put = (scope: string, subject: string | null, slug = 'ok') =>
      setDoc({
        scope,
        subject,
        slug,
        title: 'T',
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

  test('docsForRun injects job docs and omits demand and non-run scopes', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    expect(docsForRun({ job: 'file-question', cwd: '/elsewhere' })).toEqual([])
    setDoc({ scope: 'project', subject: 'known', slug: 'project', title: 'Project', body: 'P' })
    setDoc({ scope: 'job', subject: 'file-question', slug: 'job', title: 'Job', body: 'J' })
    setDoc({ scope: 'global', subject: null, slug: 'global', title: 'Global', body: 'G' })
    setDoc({ scope: 'agent', subject: 'codex', slug: 'agent', title: 'Agent', body: 'A' })
    setDoc({ scope: 'machine', subject: null, slug: 'machine', title: 'Machine', body: 'M' })
    setDoc({
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

  test('delivery is round-tripped and demand docs never enter a compiled pack', () => {
    upsertProject({ name: 'known', path: dir, stack: null, canon: true, settings: {} })
    setDoc({ scope: 'machine', subject: null, slug: 'injected', title: 'Injected', body: 'é' })
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'demand',
      title: 'Demand',
      body: 'large',
      delivery: 'demand',
    })
    setDoc({ scope: 'job', subject: 'understand', slug: 'job', title: 'Job', body: 'J' })
    setDoc({ scope: 'project', subject: 'known', slug: 'project', title: 'Project', body: 'P' })
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

  test('setDoc closes project and global inject while allowing canon and estate facts', () => {
    upsertProject({ name: 'known', path: dir, stack: null, canon: false, settings: {} })
    for (const [scope, subject] of [
      ['global', null],
      ['project', 'known'],
    ] as const) {
      expect(() =>
        writeDoc({
          scope,
          subject,
          slug: `refused-${scope}`,
          title: 'Refused',
          body: 'B',
          delivery: 'inject',
          reason: 'test refusal',
        }),
      ).toThrow('make the instruction canon, or write the operator document with delivery demand')
    }
    expect(
      writeDoc({
        scope: 'canon',
        subject: null,
        slug: '.agents/rules/global.md',
        title: 'Global canon',
        body: '---\ndescription: Global\n---\n\nRule.\n',
        delivery: 'inject',
        reason: 'test global canon',
        allowCanonBootstrap: true,
      }).scope,
    ).toBe('canon')
    for (const [scope, subject] of [
      ['machine', null],
      ['agent', 'codex'],
      ['job', 'understand'],
    ] as const) {
      expect(
        writeDoc({
          scope,
          subject,
          slug: `allowed-${scope}`,
          title: 'Allowed',
          body: 'B',
          delivery: 'inject',
          reason: 'test estate fact',
        }).delivery,
      ).toBe('inject')
    }
  })

  test('inject estate facts above 8 KiB refuse unless force-inject; demand of any size succeeds', () => {
    const body = 'x'.repeat(9 * 1024)
    expect(() =>
      setDoc({
        scope: 'job',
        subject: 'understand',
        slug: 'inject-too-big',
        title: 'Too big',
        body,
        delivery: 'inject',
      }),
    ).toThrow(
      /inject document is \d+ bytes; threshold is 8192 bytes; current pack is \d+ bytes with -?\d+ bytes headroom/,
    )
    expect(() =>
      setDoc({
        scope: 'job',
        subject: 'understand',
        slug: 'inject-too-big',
        title: 'Too big',
        body,
        delivery: 'inject',
      }),
    ).toThrow('invariant: oversized narrative belongs on demand')
    expect(() =>
      setDoc({
        scope: 'job',
        subject: 'understand',
        slug: 'inject-too-big',
        title: 'Too big',
        body,
        delivery: 'inject',
      }),
    ).toThrow('cleared by: use --delivery demand')
    const forced = setDoc({
      scope: 'job',
      subject: 'understand',
      slug: 'inject-forced',
      title: 'Forced',
      body,
      delivery: 'inject',
      forceInject: 'operator override',
    })
    expect(forced.delivery).toBe('inject')
    const demand = setDoc({
      scope: 'global',
      subject: null,
      slug: 'demand-any-size',
      title: 'Demand',
      body: 'y'.repeat(20 * 1024),
      delivery: 'demand',
    })
    expect(demand.delivery).toBe('demand')
  })
})
