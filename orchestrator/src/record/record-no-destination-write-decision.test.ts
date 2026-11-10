import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { NO_DESTINATION_WRITE_CAUSE_LENGTH } from '../../../shared/record-no-destination-write-contract.ts'
import { destinationlessWrite } from './record-no-destination-write-decision.ts'

const input = {
  method: 'POST',
  activeSpaceId: 'space-a',
  route: '/v1/docs/:id',
  userAgent: `${PLATFORM_SLUG}/1.2.3`,
}

test('records a patterned write route with no destination', () => {
  expect(destinationlessWrite(input)).toEqual({
    spaceId: 'space-a',
    route: '/v1/docs/:id',
    cause: `${PLATFORM_SLUG}/1.2.3`,
  })
})

test('does not record reads or writes with a destination', () => {
  expect(destinationlessWrite({ ...input, method: 'GET' })).toBeNull()
  expect(destinationlessWrite({ ...input, method: 'HEAD' })).toBeNull()
  expect(destinationlessWrite({ ...input, destinationSpaceId: 'space-b' })).toBeNull()
})

test('bounds and normalizes the client cause', () => {
  const longCause = 'a'.repeat(NO_DESTINATION_WRITE_CAUSE_LENGTH + 1)
  expect(destinationlessWrite({ ...input, userAgent: longCause })?.cause).toBe(
    'a'.repeat(NO_DESTINATION_WRITE_CAUSE_LENGTH),
  )
  expect(destinationlessWrite({ ...input, userAgent: '   ' })?.cause).toBe('unknown')
})
