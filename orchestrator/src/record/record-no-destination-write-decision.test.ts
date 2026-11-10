import { expect, test } from 'bun:test'
import { destinationlessWrite } from './record-no-destination-write-decision.ts'

const input = {
  method: 'POST',
  activeSpaceId: 'space-a',
  route: '/v1/docs/:id',
  userAgent: 'bottega/1.2.3',
}

test('records a patterned write route with no destination', () => {
  expect(destinationlessWrite(input)).toEqual({
    spaceId: 'space-a',
    route: '/v1/docs/:id',
    cause: 'bottega/1.2.3',
  })
})

test('does not record reads or writes with a destination', () => {
  expect(destinationlessWrite({ ...input, method: 'GET' })).toBeNull()
  expect(destinationlessWrite({ ...input, method: 'HEAD' })).toBeNull()
  expect(destinationlessWrite({ ...input, destinationSpaceId: 'space-b' })).toBeNull()
})

test('records board writes through the same decision', () => {
  expect(
    destinationlessWrite({ ...input, method: 'PUT', route: '/v1/board/messages' }),
  ).toMatchObject({ route: '/v1/board/messages' })
})
