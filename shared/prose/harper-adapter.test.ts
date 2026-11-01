import { expect, test } from 'bun:test'
import { harperFindings } from './harper-adapter.ts'

test('loads Harper WASM, applies the dictionary, and leaves naming to the naming rule', async () => {
  const started = performance.now()
  const misspelling = await harperFindings('We saw the meida here.')
  const dictionaryWord = await harperFindings('bottega')
  const namingWord = await harperFindings('the operator')
  console.log(`harper adapter test: ${Math.round(performance.now() - started)}ms`)

  expect(misspelling).toMatchObject({
    ran: true,
    findings: [expect.objectContaining({ rule: 'SpellCheck', text: 'meida' })],
  })
  expect(dictionaryWord).toEqual({ ran: true, findings: [] })
  expect(namingWord).toEqual({ ran: true, findings: [] })
})
