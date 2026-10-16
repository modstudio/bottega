import { describe, expect, test } from 'bun:test'
import { RecordProjectSchema } from './record-project-contract.ts'

const previousResponse = {
  id: 'project-a',
  spaceId: 'space-a',
  spaceName: 'Alpha',
  name: 'probe',
  keyPrefixes: ['DEV'],
  stack: 'typescript',
  managedContext: true,
  landingBranch: 'main',
  color: null,
  colorDark: null,
  retiredAt: null,
}

describe('RecordProjectSchema', () => {
  test('decodes the previous project response', () => {
    expect(RecordProjectSchema.parse(previousResponse)).toEqual(previousResponse)
  })

  test('decodes the additive adoption fields', () => {
    const response = {
      ...previousResponse,
      canon: true,
      settings: { keyPrefixes: ['DEV'], trunk: 'main' },
    }
    expect(RecordProjectSchema.parse(response)).toEqual(response)
  })
})
