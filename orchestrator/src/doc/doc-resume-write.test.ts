import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { consumeDoc, setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { upsertRecordDoc } from '../record/record-docs.ts'
import { resumeFrontmatter } from './doc-resume-frontmatter.ts'
import { openResumeViolations, resumeWriteRefusal } from './doc-resume-write.ts'
import { getDoc, listDocRevisions, restoreDoc } from './docs.ts'

const written = '2026-10-20T12:34:56.000Z'

function brief(lines: string[] = [], status = 'open'): string {
  return `---\nstatus: ${status}\nepic: DEV-1439\nproject: ${PLATFORM_SLUG}\nwritten: ${written}\n---\n\n${lines.join('\n')}\n`
}

function violations(body: string) {
  return openResumeViolations(body, resumeFrontmatter(body)!.top)
}

describe('open resume write decision', () => {
  for (const field of ['epic', 'project', 'written'] as const) {
    test(`reports a missing ${field} alone`, () => {
      const body = brief(['NEXT ACTION: continue']).replace(
        `${field}: ${field === 'epic' ? 'DEV-1439' : field === 'project' ? PLATFORM_SLUG : written}\n`,
        '',
      )
      expect(violations(body)).toEqual([
        {
          offendingText: `${field}: <missing or empty>`,
          remedy: `supply a non-empty top-level ${field} field`,
        },
      ])
    })

    test(`reports an empty ${field} alone`, () => {
      const value = field === 'epic' ? 'DEV-1439' : field === 'project' ? PLATFORM_SLUG : written
      const body = brief(['NEXT ACTION: continue']).replace(`${field}: ${value}`, `${field}:   `)
      expect(violations(body)).toEqual([
        {
          offendingText: `${field}: <missing or empty>`,
          remedy: `supply a non-empty top-level ${field} field`,
        },
      ])
    })
  }

  test('reports an invalid written timestamp alone', () => {
    const body = brief(['NEXT ACTION: continue']).replace(written, 'Tuesday afternoon')
    expect(violations(body)).toEqual([
      {
        offendingText: 'written: Tuesday afternoon',
        remedy: 'supply written as an ISO 8601 timestamp with a timezone',
      },
    ])
  })

  test('reports a missing NEXT ACTION line alone', () => {
    expect(violations(brief(['Continue the work.']))).toEqual([
      {
        offendingText: 'NEXT ACTION: <missing>',
        remedy: 'add an explicit NEXT ACTION line',
      },
    ])
  })

  for (const location of [
    '/tmp/session/notes.md',
    '/private/tmp/session/notes.md',
    '/var/folders/aa/session/notes.md',
    'notes/scratchpad/handoff.md',
    '/state/orchestrator/runs/123/output.md',
  ]) {
    test(`reports scratch location ${location} alone with its offending text`, () => {
      expect(violations(brief(['NEXT ACTION: continue', location]))).toEqual([
        {
          offendingText: location,
          remedy: 'remove the scratch location and name a durable repository or doc-store location',
        },
      ])
    })
  }

  test('returns all violations together', () => {
    const body = `---\nstatus: open\nepic:\nproject:\nwritten:\n---\n\n/tmp/a /private/tmp/b /var/folders/c notes/scratchpad/d /state/orchestrator/runs/e\n`
    expect(violations(body).map(({ offendingText }) => offendingText)).toEqual([
      'epic: <missing or empty>',
      'project: <missing or empty>',
      'written: <missing or empty>',
      'NEXT ACTION: <missing>',
      '/tmp/a',
      '/private/tmp/b',
      '/var/folders/c',
      'notes/scratchpad/d',
      '/state/orchestrator/runs/e',
    ])
  })

  test('accepts a clean open brief and every supported NEXT ACTION line form', () => {
    for (const line of [
      'NEXT ACTION: continue',
      '**next action**: continue',
      '- NEXT ACTION: continue',
      '1. _NEXT ACTION_: continue',
      '### NEXT ACTION',
    ]) {
      const body = brief([line])
      expect(resumeWriteRefusal('clean', body, resumeFrontmatter(body))).toBeNull()
    }
  })

  test('accepts a consumed brief with every open-brief violation', () => {
    const body = '---\nstatus: consumed\n---\n\n/tmp/non-compliant\n'
    expect(resumeWriteRefusal('old', body, resumeFrontmatter(body))).toBeNull()
  })
})

describe('resume write adapters', () => {
  test('setDoc refuses an open brief with a scratch path and lists the remedy', async () => {
    upsertProject({ recordId: newRecordId(), name: 'resume-write', path: '/w/resume-write' })
    await expect(
      setDoc({
        scope: 'resume',
        subject: 'resume-write',
        slug: 'scratch-path',
        title: 'Scratch path',
        body: brief(['NEXT ACTION: continue', '/tmp/session/notes.md']),
      }),
    ).rejects.toThrow(
      '"/tmp/session/notes.md"; cleared by: remove the scratch location and name a durable repository or doc-store location',
    )
  })

  test('consuming a stored non-compliant open brief succeeds', async () => {
    upsertProject({ recordId: newRecordId(), name: 'resume-consume', path: '/w/resume-consume' })
    const stored = await setDoc({
      scope: 'resume',
      subject: 'resume-consume',
      slug: 'old-shape',
      title: 'Old shape',
      body: brief(['NEXT ACTION: continue']),
    })
    db()
      .query('UPDATE doc SET body=? WHERE record_id=?')
      .run('---\nstatus: open\n---\n\n/tmp/legacy\n', stored.record_id)
    const consumed = await consumeDoc('resume', 'resume-consume', stored.slug)
    expect(consumed.body).toContain('status: consumed')
    expect(consumed.body).toContain('/tmp/legacy')
  })

  test('restoring a non-compliant open revision refuses without hiding the revision', async () => {
    upsertProject({ recordId: newRecordId(), name: 'resume-restore-rule', path: '/w/restore' })
    const stored = await setDoc({
      scope: 'resume',
      subject: 'resume-restore-rule',
      slug: 'old-revision',
      title: 'Old revision',
      body: brief(['NEXT ACTION: continue']),
    })
    const revision = listDocRevisions('resume', 'resume-restore-rule', stored.slug)[0]!
    db()
      .query('UPDATE doc_revision SET body=? WHERE record_id=?')
      .run('---\nstatus: open\n---\n\n/tmp/legacy\n', revision.record_id)
    await expect(
      restoreDoc('resume', 'resume-restore-rule', stored.slug, revision.record_id, {
        reason: 'restore old revision',
      }),
    ).rejects.toThrow(
      `The revision remains readable; cleared by: read the revision, correct its body, then write it with ${PLATFORM_SLUG} doc set.`,
    )
    expect(getDoc('resume', 'resume-restore-rule', stored.slug)?.body).toBe(
      brief(['NEXT ACTION: continue']),
    )
  })

  test('hosted upsert refuses before connecting when an open brief violates the shape', async () => {
    await expect(
      upsertRecordDoc({
        url: 'postgres://record.invalid/record',
        userId: newRecordId(),
        spaceId: newRecordId(),
        scope: 'resume',
        subject: PLATFORM_SLUG,
        slug: 'hosted-scratch',
        title: 'Hosted scratch',
        body: brief(['NEXT ACTION: continue', '/orchestrator/runs/123/reply.json']),
        reason: 'test hosted refusal',
        author: 'tester',
      }),
    ).rejects.toThrow('/orchestrator/runs/123/reply.json')
  })
})
