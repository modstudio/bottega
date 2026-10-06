import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { consumeDoc, removeDoc, setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  getDoc,
  listDocRevisions,
  listOpenResumes,
  parseResumeFrontmatter,
  restoreDoc,
  resumeAge,
} from './docs.ts'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const knownRepository = repositoryRoot
const otherRepository = `${repositoryRoot}/hub`

describe('scoped operator docs', () => {
  test('restoring a resume document writes its registered project id', async () => {
    upsertProject({
      name: 'resume-restore',
      path: process.cwd(),
      stack: null,
      canon: true,
      settings: {},
    })
    const project = db().query('SELECT id FROM project WHERE name=?').get('resume-restore') as {
      id: number
    }
    const created = await setDoc({
      scope: 'resume',
      subject: 'resume-restore',
      slug: 'restore-project-id',
      title: 'Resume',
      body: '---\nstatus: open\n---\n\nOriginal.',
    })
    const createRevision = listDocRevisions('resume', 'resume-restore', 'restore-project-id')[0]!
    db().query('UPDATE doc SET project_id=NULL WHERE id=?').run(created.id)

    await restoreDoc('resume', 'resume-restore', created.slug, createRevision.id, {
      reason: 'restore over existing resume',
    })
    expect(getDoc('resume', 'resume-restore', created.slug)?.project_id).toBe(project.id)

    await removeDoc('resume', 'resume-restore', created.slug)
    const restored = await restoreDoc('resume', 'resume-restore', created.slug, createRevision.id, {
      reason: 'restore removed resume',
    })
    expect(restored.project_id).toBe(project.id)
  })

  test('consumeDoc consults and patches a top-level open status after nested consumed status', async () => {
    const body = '---\nmetadata:\n  status: consumed\nstatus: open\n---\n\nBODY\n'
    await setDoc({ scope: 'global', subject: null, slug: 'top-open', title: 'Top open', body })

    const result = await consumeDoc('global', null, 'top-open')

    expect(result.already_consumed).toBe(false)
    expect(result.body).toContain('metadata:\n  status: consumed\nstatus: consumed\n')
    expect(parseResumeFrontmatter(result.body)?.status).toBe('consumed')
  })

  test('consumeDoc patches the top-level status and leaves an earlier nested open status unchanged', async () => {
    const body = '---\nmetadata:\n  status: open\nstatus: open\n---\n\nBODY\n'
    await setDoc({ scope: 'global', subject: null, slug: 'both-open', title: 'Both open', body })

    const result = await consumeDoc('global', null, 'both-open')

    expect(result.already_consumed).toBe(false)
    expect(result.body).toContain('metadata:\n  status: open\nstatus: consumed\n')
    expect(parseResumeFrontmatter(result.body)?.status).toBe('consumed')
  })

  test('consumeDoc rejects documents without frontmatter or a status field', async () => {
    await setDoc({ scope: 'global', subject: null, slug: 'plain', title: 'Plain', body: 'BODY\n' })
    await setDoc({
      scope: 'global',
      subject: null,
      slug: 'statusless',
      title: 'Statusless',
      body: '---\nepic: demo\n---\nBODY\n',
    })
    await expect(consumeDoc('global', null, 'plain')).rejects.toThrow('has no YAML frontmatter')
    await expect(consumeDoc('global', null, 'statusless')).rejects.toThrow('has no status field')
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
      status: 'open',
      epic: 'demo',
      project: 'known',
      written: '2026-09-03T00:00:00.000Z',
    })
  })

  test('listOpenResumes lists only open briefs for the cwd project, newest first', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    upsertProject({ name: 'other', path: otherRepository, stack: null, canon: true, settings: {} })
    const now = Date.parse('2026-09-03T12:00:00.000Z')
    await setDoc({
      scope: 'resume',
      subject: 'known',
      slug: 'older',
      title: 'Older epic',
      body: resumeBody('open', '2026-09-01T12:00:00.000Z'),
    })
    await setDoc({
      scope: 'resume',
      subject: 'known',
      slug: 'newer',
      title: 'Newer epic',
      body: resumeBody('open', '2026-09-03T11:40:00.000Z'),
    })
    await setDoc({
      scope: 'resume',
      subject: 'known',
      slug: 'done',
      title: 'Consumed',
      body: resumeBody('consumed', '2026-09-03T11:50:00.000Z'),
    })
    await setDoc({
      scope: 'resume',
      subject: 'known',
      slug: 'broken',
      title: 'Broken',
      body: resumeBody('open'),
    })
    db()
      .query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run('not frontmatter', 'resume', 'known', 'broken')
    await setDoc({
      scope: 'resume',
      subject: 'other',
      slug: 'elsewhere',
      title: 'Other project',
      body: resumeBody('open', '2026-09-03T11:55:00.000Z'),
    })
    await setDoc({
      scope: 'project',
      subject: 'known',
      slug: 'not-a-resume',
      title: 'Project doc',
      body: resumeBody('open', '2026-09-03T11:59:00.000Z'),
    })
    expect(listOpenResumes('/nowhere', now)).toEqual({ open: [], unreadable: [] })
    expect(listOpenResumes(`${knownRepository}/src`, now)).toEqual({
      open: [
        {
          slug: 'newer',
          title: 'Newer epic',
          age: '20m',
          at: Date.parse('2026-09-03T11:40:00.000Z'),
        },
        {
          slug: 'older',
          title: 'Older epic',
          age: '2d',
          at: Date.parse('2026-09-01T12:00:00.000Z'),
        },
      ],
      unreadable: [{ slug: 'broken', reason: 'no-frontmatter' }],
    })
  })

  test('indented resume frontmatter cases A-D parse and list, with top-level keys winning', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    const cases = [
      [
        'case-a',
        '---\nmetadata:\n  status: open\n  epic: nested\n---\n\nA',
        { status: 'open', epic: 'nested' },
      ],
      ['case-b', '---\nstatus: open\nepic: flat\n---\n\nB', { status: 'open', epic: 'flat' }],
      [
        'case-c',
        '---\nstatus: open\nmetadata:\n  project: known\n---\n\nC',
        { status: 'open', project: 'known' },
      ],
      [
        'case-d',
        '---\nstatus: open\nproject: a long\n  wrapped value\n---\n\nD',
        { status: 'open', project: 'a long' },
      ],
    ] as const
    for (const [slug, body, expected] of cases) {
      await setDoc({
        scope: 'resume',
        subject: 'known',
        slug,
        title: slug,
        body: resumeBody('open'),
      })
      db()
        .query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
        .run(body, 'resume', 'known', slug)
      expect(parseResumeFrontmatter(body)).toEqual(expected)
    }
    const topWins = '---\nmetadata:\n  status: open\nstatus: consumed\n---\n\nDone'
    expect(parseResumeFrontmatter(topWins)?.status).toBe('consumed')
    await setDoc({
      scope: 'resume',
      subject: 'known',
      slug: 'top-wins',
      title: 'top-wins',
      body: resumeBody('open'),
    })
    db()
      .query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run(topWins, 'resume', 'known', 'top-wins')

    expect(
      listOpenResumes(knownRepository)
        .open.map((resume) => resume.slug)
        .sort(),
    ).toEqual(['case-a', 'case-b', 'case-c', 'case-d'])
  })

  test('the last duplicate top-level status controls listing and consumption', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    await setDoc({
      scope: 'resume',
      subject: 'known',
      slug: 'legacy-duplicate',
      title: 'Legacy duplicate',
      body: resumeBody('open'),
    })
    const duplicate = '---\nstatus: consumed\nstatus: open\nepic: demo\n---\n\nNEXT ACTION\n'
    db()
      .query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run(duplicate, 'resume', 'known', 'legacy-duplicate')

    expect(parseResumeFrontmatter(duplicate)?.status).toBe('open')
    expect(listOpenResumes(knownRepository).open.map((resume) => resume.slug)).toContain(
      'legacy-duplicate',
    )

    const consumed = await consumeDoc('resume', 'known', 'legacy-duplicate')
    expect(consumed.already_consumed).toBe(false)
    expect(consumed.body).toContain('status: consumed\nstatus: consumed\n')
    expect(parseResumeFrontmatter(consumed.body)?.status).toBe('consumed')
    expect(listOpenResumes(knownRepository).open.map((resume) => resume.slug)).not.toContain(
      'legacy-duplicate',
    )
  })

  test('the last nested status controls parsing, listing, and consumption', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    const cases = [
      [
        'nested-open',
        '---\nmetadata:\n  status: consumed\ndetail:\n  status: open\n---\n\nBODY\n',
        'open',
      ],
      [
        'nested-consumed',
        '---\nmetadata:\n  status: open\ndetail:\n  status: consumed\n---\n\nBODY\n',
        'consumed',
      ],
      [
        'quoted-nested-open',
        '---\nmetadata:\n  status: "consumed"\ndetail:\n  status: \'open\'\n---\n\nBODY\n',
        'open',
      ],
      [
        'quoted-nested-consumed',
        '---\nmetadata:\n  status: \'open\'\ndetail:\n  status: "consumed"\n---\n\nBODY\n',
        'consumed',
      ],
    ] as const

    for (const [slug, body, status] of cases) {
      await setDoc({
        scope: 'resume',
        subject: 'known',
        slug,
        title: slug,
        body: resumeBody('open'),
      })
      db()
        .query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
        .run(body, 'resume', 'known', slug)

      expect(parseResumeFrontmatter(body)?.status).toBe(status)
      expect(
        listOpenResumes(knownRepository)
          .open.map((resume) => resume.slug)
          .includes(slug),
      ).toBe(status === 'open')

      const consumed = await consumeDoc('resume', 'known', slug)
      expect(consumed.already_consumed).toBe(status === 'consumed')
      if (status === 'open') {
        expect(parseResumeFrontmatter(consumed.body)?.status).toBe('consumed')
        expect(listOpenResumes(knownRepository).open.map((resume) => resume.slug)).not.toContain(
          slug,
        )
      } else {
        expect(consumed.body).toBe(body)
        expect(consumed.body).not.toContain('consumed_by:')
      }
    }
  })

  test('round-three status forms still resolve and consume correctly', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    const bodies = [
      '---\r\nstatus: "consumed"\r\nstatus: \'open\'\r\n---\r\n\r\nBODY',
      '---\nmetadata:\n  status: consumed\nstatus: open\n---\n\nBODY',
      '---\nstatus: "open"\n---\n\nBODY',
      '---\nmetadata:\n  status: open\n---\n\nBODY',
    ] as const

    for (const [index, body] of bodies.entries()) {
      const slug = `round-three-${index}`
      await setDoc({ scope: 'global', subject: null, slug, title: slug, body })
      expect(parseResumeFrontmatter(body)?.status).toBe('open')
      const consumed = await consumeDoc('global', null, slug)
      expect(consumed.already_consumed).toBe(false)
      expect(parseResumeFrontmatter(consumed.body)?.status).toBe('consumed')
      expect(consumed.body).toContain('consumed_by:')
    }
  })

  test('setDoc refuses a resume without readable top-level status', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    await expect(
      setDoc({
        scope: 'resume',
        subject: 'known',
        slug: 'statusless',
        title: 'Statusless',
        body: '---\nepic: demo\n---\n',
      }),
    ).rejects.toThrow('resume doc "statusless" requires readable top-level YAML frontmatter')
    await expect(
      setDoc({
        scope: 'resume',
        subject: 'known',
        slug: 'nested-only',
        title: 'Nested',
        body: '---\nmetadata:\n  status: open\n---\n',
      }),
    ).rejects.toThrow('"status: open" or "status: consumed"')
  })

  test('setDoc refuses duplicate top-level resume statuses and names the slug', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    await expect(
      setDoc({
        scope: 'resume',
        subject: 'known',
        slug: 'duplicate-status',
        title: 'Duplicate',
        body: '---\nstatus: consumed\nstatus: open\n---\n',
      }),
    ).rejects.toThrow('resume doc "duplicate-status" has more than one top-level status field')
  })

  test('setDoc refuses an unrecognized resume status and names the value and the permitted two', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    await expect(
      setDoc({
        scope: 'resume',
        subject: 'known',
        slug: 'pending-brief',
        title: 'Pending',
        body: resumeBody('pending'),
      }),
    ).rejects.toThrow(
      'resume doc "pending-brief" has unrecognized status "pending"; permitted values are "open" and "consumed"',
    )
  })

  test('setDoc accepts open and consumed resume status, including quoted forms', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    const accepted = [
      ['plain-open', 'open', 'open'],
      ['plain-consumed', 'consumed', 'consumed'],
      ['double-quoted-open', '"open"', 'open'],
      ['single-quoted-open', "'open'", 'open'],
      ['double-quoted-consumed', '"consumed"', 'consumed'],
      ['single-quoted-consumed', "'consumed'", 'consumed'],
    ] as const
    for (const [slug, written, resolved] of accepted) {
      const doc = await setDoc({
        scope: 'resume',
        subject: 'known',
        slug,
        title: slug,
        body: resumeBody(written),
      })
      expect(parseResumeFrontmatter(doc.body)?.status).toBe(resolved)
    }
  })

  test('listOpenResumes reports a stored unrecognized status as unreadable rather than dropping it', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    await setDoc({
      scope: 'resume',
      subject: 'known',
      slug: 'pending-brief',
      title: 'Pending',
      body: resumeBody('open'),
    })
    db()
      .query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run(resumeBody('pending'), 'resume', 'known', 'pending-brief')

    expect(listOpenResumes(knownRepository)).toEqual({
      open: [],
      unreadable: [{ slug: 'pending-brief', reason: 'unrecognized-status' }],
    })
  })

  test('orch doc resumes prints padded columns and is silent when there are none', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    expect(listOpenResumes(knownRepository)).toEqual({ open: [], unreadable: [] })
    expect(listOpenResumes('/nowhere')).toEqual({ open: [], unreadable: [] })
    const now = Date.now()
    await setDoc({
      scope: 'resume',
      subject: 'known',
      slug: 'epic-name',
      title: 'Title here',
      body: resumeBody('open', new Date(now).toISOString()),
    })
    expect(listOpenResumes(knownRepository, now)).toEqual({
      open: [{ slug: 'epic-name', title: 'Title here', age: '0s', at: now }],
      unreadable: [],
    })
  }, 20_000)

  test('orch doc resumes reports unreadable briefs without changing human stdout', async () => {
    upsertProject({ name: 'known', path: knownRepository, stack: null, canon: true, settings: {} })
    const invalidBriefs: Array<[string, string]> = [
      ['no-frontmatter', 'BODY'],
      ['no-status', '---\nepic: demo\n---\n\nBODY'],
      ['pending-brief', resumeBody('pending')],
    ]
    for (const [slug, body] of invalidBriefs) {
      await setDoc({
        scope: 'resume',
        subject: 'known',
        slug,
        title: slug,
        body: resumeBody('open'),
      })
      db()
        .query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
        .run(body, 'resume', 'known', slug)
    }
    expect(listOpenResumes(knownRepository)).toEqual({
      open: [],
      unreadable: [
        { slug: 'no-frontmatter', reason: 'no-frontmatter' },
        { slug: 'no-status', reason: 'no-readable-status' },
        { slug: 'pending-brief', reason: 'unrecognized-status' },
      ],
    })
  })
})
