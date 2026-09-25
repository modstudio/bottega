import { expect, test } from 'bun:test'
import { parseTranscriptEvents } from './canon-edit-transcript.ts'

const line = (role: 'assistant' | 'user', content: unknown) =>
  JSON.stringify({ message: { role, content } })
const use = (role: 'assistant' | 'user', id: string) =>
  line(role, [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'x' } }])
const result = (id: string) =>
  line('user', [{ type: 'tool_result', tool_use_id: id, content: 'body' }])

test('only later user-role results pair once with assistant-role uses', () => {
  const events = parseTranscriptEvents(
    [
      result('later'),
      use('user', 'user-forged'),
      result('user-forged'),
      use('assistant', 'assistant'),
      result('assistant'),
      result('assistant'),
      use('assistant', 'later'),
    ],
    0,
  )
  expect(events).toEqual([
    { kind: 'tool_use', id: 'assistant', name: 'Read', input: { file_path: 'x' } },
    { kind: 'tool_result', toolUseId: 'assistant', content: true, error: false },
    { kind: 'tool_use', id: 'later', name: 'Read', input: { file_path: 'x' } },
  ])
})
