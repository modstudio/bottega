import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../brand.ts'
import { harperFindings } from './harper-adapter.ts'

test('loads Harper WASM, applies the dictionary, and leaves naming to the naming rule', async () => {
  const started = performance.now()
  const misspelling = await harperFindings('We saw the meida here.')
  const dictionaryWord = await harperFindings(PLATFORM_NAME.toLowerCase())
  const name = PLATFORM_NAME.toLowerCase()
  const dictionaryForms = await harperFindings(`${name}'s ${name}’s postgres`)
  const misspelledPossessive = await harperFindings("meida's")
  const namingWord = await harperFindings('the operator')
  const repeatedWord = await harperFindings('We worked in in the repository.')
  const disabledRules = await harperFindings(
    'We changed history, routing and billing. Its ready for review.',
  )
  console.log(`harper adapter test: ${Math.round(performance.now() - started)}ms`)

  expect(misspelling).toMatchObject({
    ran: true,
    findings: [expect.objectContaining({ rule: 'SpellCheck', text: 'meida' })],
  })
  expect(dictionaryWord).toEqual({ ran: true, findings: [] })
  expect(dictionaryForms).toEqual({ ran: true, findings: [] })
  expect(misspelledPossessive).toMatchObject({
    ran: true,
    findings: [expect.objectContaining({ rule: 'SpellCheck', text: "meida's" })],
  })
  expect(namingWord).toEqual({ ran: true, findings: [] })
  expect(repeatedWord).toMatchObject({
    ran: true,
    findings: [expect.objectContaining({ rule: 'RepeatedWords', text: 'in in' })],
  })
  expect(disabledRules).toEqual({ ran: true, findings: [] })
})
