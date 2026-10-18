// concern: lens-built-ins
/** Pure built-in lens definitions shared by local and hosted seed adapters. */
export const BUILT_IN_LENSES = [
  ['correctness', 'Correctness', 'Does the change do what the spec says on every path, including failure paths?', 'style and naming, performance, migration safety, security'],
  ['migration-safety', 'Migration safety', 'Can this schema change apply to the live store and roll forward without loss, and does adoption still match afterwards?', 'application logic, style'],
  ['craft', 'Craft', 'Is the new module shaped so the next reader and the next change find one definition of each thing?', 'behavioral correctness, security'],
  ['issue-blast-radius', 'Issue blast radius', 'What else does this change reach, and what breaks when it is wrong?', 'whether the change itself is correct'],
  ['teardown-safety', 'Teardown safety', 'Can every path in worktree teardown remove only what this run owns and nothing else?', 'creation and landing'],
  ['safety', 'Safety', 'Can this change be used to damage a checkout, a store, a secret, or another session run?', 'correctness'],
] as const

export const BUILT_IN_LENS_SLOTS = JSON.stringify({
  type: 'object',
  properties: { framework_guidance: { type: 'string' }, commands: { type: 'string' } },
  additionalProperties: false,
})
export const BUILT_IN_LENS_DEFAULT_PROFILE = JSON.stringify({
  framework_guidance: 'No framework-specific guidance for this stack.',
  commands: 'None.',
})
