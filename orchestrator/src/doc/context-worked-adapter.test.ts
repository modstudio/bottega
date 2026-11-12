import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { getContext } from './context-service.ts'
import { recordSessionWorked } from './context-worked-adapter.ts'

test('updates an existing worked fact and skips an unchanged rewrite', async () => {
  const session = newRecordId()
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    await recordSessionWorked(session, ['DEV-ONE'], 'precompact')
    await recordSessionWorked(session, ['DEV-TWO'], 'precompact')

    const updated = (await getContext({ session })).items.find((item) => item.id === 'worked')!
    expect(updated.body).toBe('Worked: DEV-TWO')

    await recordSessionWorked(session, ['DEV-TWO'], 'precompact')
    const unchanged = (await getContext({ session })).items.find((item) => item.id === 'worked')!
    expect(unchanged.revision).toBe(updated.revision)
  } finally {
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession
  }
})
