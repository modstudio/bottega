import { describe, expect, test } from 'bun:test'
import { refusal, renderRefusal } from './refusal.ts'

describe('refusal rendering', () => {
  test('keeps a condition without a remedy byte-identical', () => {
    expect(renderRefusal(refusal('the condition'))).toBe('the condition')
  })

  test('renders command remedies as argv', () => {
    expect(
      renderRefusal(refusal('the condition', { kind: 'command', argv: ['bottega', 'repair'] })),
    ).toBe('the condition\ncleared by: bottega repair')
  })

  test('renders edit remedies without interpreting their text', () => {
    expect(
      renderRefusal(refusal('the condition', { kind: 'edit', text: 'change the setting' })),
    ).toBe('the condition\ncleared by: change the setting')
  })
})
