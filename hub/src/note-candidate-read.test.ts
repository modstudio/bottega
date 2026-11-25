import { expect, test } from 'bun:test'
import type { HubTypedQuestionInput } from './typed-question-service.ts'
import {
  NOTE_DUPLICATE_CANDIDATES,
  noteDuplicateQuestionCandidates,
  notePairSubjectRef,
} from './note-duplicate-question.ts'
import { duplicateCandidatesForNewNote, noteCandidates } from './note.ts'

const id = (value: number) => `01990000-0000-7000-8000-${String(value).padStart(12, '0')}`

test('hosted note candidate search is one bounded read equivalent to the full-list oracle', async () => {
  const project = 'gamma'
  const text = 'alpha beta candidate'
  const notes = Array.from({ length: NOTE_DUPLICATE_CANDIDATES * 10 }, (_, index) => ({
    record_id: id(3000 + index),
    number: index + 1,
    label: `${project}#${index + 1}`,
    project,
    text: index % 2 === 0 ? `alpha beta item ${index}` : `unrelated item ${index}`,
    stale_at: null,
  }))
  const selected = noteDuplicateQuestionCandidates(notes, project, text).map(
    ({ score: _score, ...note }) => note,
  )
  const paths: string[] = []
  const subjects: string[] = []
  let credentialStarts = 0
  const result = await duplicateCandidatesForNewNote(
    text,
    project,
    undefined,
    {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input) => {
        const url = new URL(input)
        paths.push(url.pathname)
        if (url.pathname === '/v1/tasks/identity')
          return Response.json({
            userId: 'user-1',
            activeSpaceId: 'space-a',
            memberships: [
              { spaceId: 'space-a', slug: 'active', permission: 'write' },
              { spaceId: 'space-gamma', slug: 'declared-gamma-space', permission: 'write' },
            ],
            capabilities: { targetSpaceNotes: true },
          })
        if (url.pathname === '/v1/notes/candidates') return Response.json(selected)
        return Response.json({ error: 'unexpected full note read' }, { status: 500 })
      },
    },
    {
      startCredentialResolution: () => credentialStarts++,
      ask: async (input: HubTypedQuestionInput) => {
        subjects.push(input.subjectRef)
        return { noul: 0 }
      },
    },
  )

  expect(credentialStarts).toBe(1)
  expect(paths.filter((path) => path === '/v1/notes/candidates')).toHaveLength(1)
  expect(paths).not.toContain('/v1/notes')
  expect(paths).not.toContain('/v1/notes/list')
  expect(result).toEqual(noteCandidates(notes, text))
  expect(subjects).toEqual(
    noteDuplicateQuestionCandidates(notes, project, text).map((note) =>
      notePairSubjectRef(note.record_id, text),
    ),
  )
})

test('same-as skips both candidate and credential reads', async () => {
  let credentialStarts = 0
  const result = await duplicateCandidatesForNewNote(
    'same observation',
    'gamma',
    id(4000),
    {
      baseUrl: 'https://hub.example.test',
      fetch: async () => {
        throw new Error('candidate read must not start')
      },
    },
    { startCredentialResolution: () => credentialStarts++ },
  )
  expect(result).toEqual([])
  expect(credentialStarts).toBe(0)
})
