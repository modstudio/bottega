import { expect, test } from 'bun:test'
import { cosineTopK } from './vector-ranking.ts'

test('orders fixed vectors by exact cosine with stable ties', () => {
  expect(
    cosineTopK(
      [
        { id: 'orthogonal', vector: new Float32Array([0, 1]) },
        { id: 'same-b', vector: new Float32Array([2, 0]) },
        { id: 'same-a', vector: new Float32Array([1, 0]) },
      ],
      new Float32Array([1, 0]),
      3,
    ).map(({ id }) => id),
  ).toEqual(['same-a', 'same-b', 'orthogonal'])
})
