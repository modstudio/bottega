export function decideEvalOwnedScratchRelease(input: {
  scratchOwnedByEval: boolean
  runCreated: boolean
}): 'release' | 'none' {
  return input.scratchOwnedByEval && input.runCreated ? 'release' : 'none'
}
