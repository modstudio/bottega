import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  addSubject,
  applySubjectRecord,
  defineSubject,
  listSubjects,
  reorderSubjects,
  retireSubject,
} from './subjects.ts'

const at = '2026-10-08T12:00:00.000Z'
const row = (project: string, name: string, parentId: string | null = null) => ({
  id: newRecordId(),
  project,
  name,
  definition: `${name} definition.`,
  position: 0,
  parentId,
  state: 'active' as const,
  retiredAt: null,
  createdAt: at,
  updatedAt: at,
})

describe('project subjects', () => {
  test('adds at the end, keeps retired rows readable, and permits their names to be reused', async () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    const first = await addSubject({ project: 'alpha', name: 'First', definition: 'First.' })
    const second = await addSubject({ project: 'alpha', name: 'Second', definition: 'Second.' })
    expect(listSubjects('alpha').map(({ name, position }) => ({ name, position }))).toEqual([
      { name: 'First', position: 0 },
      { name: 'Second', position: 1 },
    ])
    await expect(
      addSubject({ project: 'alpha', name: 'First', definition: 'Duplicate.' }),
    ).rejects.toThrow('orch subject list alpha')
    await retireSubject('alpha', first.id)
    const replacement = await addSubject({ project: 'alpha', name: 'First', definition: 'New.' })
    expect(replacement.id).not.toBe(first.id)
    expect(listSubjects('alpha').map(({ id }) => id)).toEqual([second.id, replacement.id])
    expect(listSubjects('alpha', { retired: true }).find(({ id }) => id === first.id)?.state).toBe(
      'retired',
    )
  })

  test('reorder requires exactly the active set from its project', async () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    upsertProject({ name: 'beta', path: '/w/beta' })
    const one = await addSubject({ project: 'alpha', name: 'One', definition: 'One.' })
    const two = await addSubject({ project: 'alpha', name: 'Two', definition: 'Two.' })
    const foreign = await addSubject({ project: 'beta', name: 'Foreign', definition: 'Foreign.' })
    await expect(reorderSubjects('alpha', [one.id])).rejects.toThrow('orch subject list alpha')
    await expect(reorderSubjects('alpha', [one.id, foreign.id])).rejects.toThrow(
      'orch subject list alpha',
    )
    expect((await reorderSubjects('alpha', [two.id, one.id])).map(({ id }) => id)).toEqual([
      two.id,
      one.id,
    ])
  })

  test('parent validation refuses another project, itself, and a cycle', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    upsertProject({ name: 'beta', path: '/w/beta' })
    const parent = applySubjectRecord(row('alpha', 'Parent'), db())
    const foreign = applySubjectRecord(row('beta', 'Foreign'), db())
    expect(() => applySubjectRecord(row('alpha', 'Child', foreign.id), db())).toThrow(
      'same project',
    )
    const self = row('alpha', 'Self')
    self.parentId = self.id
    expect(() => applySubjectRecord(self, db())).toThrow('parent itself')
    const child = applySubjectRecord(row('alpha', 'Child', parent.id), db())
    expect(() => applySubjectRecord({ ...parent, parentId: child.id }, db())).toThrow('cycle')
  })

  test.each(['First line\nSecond line', 'First line\rSecond line'])(
    'refuses a definition containing a line break',
    async (definition) => {
      upsertProject({ name: 'alpha', path: '/w/alpha' })
      await expect(addSubject({ project: 'alpha', name: 'Broken', definition })).rejects.toThrow(
        'a subject definition must be one non-empty line',
      )
    },
  )

  test('trims surrounding whitespace and refuses an interior line break', async () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    const subject = await addSubject({
      project: 'alpha',
      name: 'Trimmed',
      definition: '  A trimmed definition. \n',
    })
    expect(subject.definition).toBe('A trimmed definition.')
    expect(listSubjects('alpha')[0]?.definition).toBe('A trimmed definition.')
    expect((await defineSubject('alpha', subject.id, '\tA changed definition.\r')).definition).toBe(
      'A changed definition.',
    )
    expect(() => defineSubject('alpha', subject.id, 'First line\nSecond line')).toThrow(
      'a subject definition must be one non-empty line',
    )
  })
})
