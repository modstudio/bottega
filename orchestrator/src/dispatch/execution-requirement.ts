// concern: dispatch
/** Decides whether a declared execution dependency fits the tree a job receives. */
export function executionRequirementRefusal(input: {
  declared: boolean
  job: string
  lens?: string
  treeKind: 'reader' | 'writer'
}): string | null {
  if (!input.declared || input.treeKind === 'writer') return null
  const identity = input.lens ? `${input.job}/${input.lens}` : input.job
  return (
    `refused: ${identity} requires execution, and a ${input.job} run gets a reader tree with no database, containers or server. ` +
    `Run the proof in a tree that can execute it — orch tree open <run> on the change's finished run, then serve it with the project's worktree serve command — or drop --requires-execution if the review can be answered by reading.`
  )
}
