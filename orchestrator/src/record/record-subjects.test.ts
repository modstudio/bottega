import { expect, test } from 'bun:test'
import { addRecordSubject } from './record-subjects.ts'

test.each(['First line\nSecond line', 'First line\rSecond line'])(
  'hosted subject service refuses a definition containing a line break',
  async (definition) => {
    await expect(
      addRecordSubject({
        url: 'postgres://unused.invalid/record',
        userId: '01990000-0000-7000-8000-000000000001',
        spaceId: '01990000-0000-7000-8000-000000000002',
        spaceIds: ['01990000-0000-7000-8000-000000000002'],
        project: 'alpha',
        name: 'Broken',
        definition,
      }),
    ).rejects.toThrow('a subject definition must be one non-empty line')
  },
)
