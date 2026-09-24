// concern: retrieval-vector-ranking
/** Ranks vectors by exact cosine similarity with deterministic ties. */

type Vector = Float32Array | number[]

function cosine(left: Vector, right: Vector): number {
  if (left.length !== right.length) throw new Error('cosine vectors must have equal dimensions')
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)
  return denominator ? dot / denominator : 0
}

export function cosineTopK<T extends Vector>(
  vectors: Array<{ id: string; vector: T }>,
  query: T,
  k: number,
): Array<{ id: string; score: number }> {
  return vectors
    .map(({ id, vector }) => ({ id, score: cosine(vector, query) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, k)
}
