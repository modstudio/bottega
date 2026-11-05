import { expect, test } from 'bun:test'
import type { SetupPlan } from './setup-engine.ts'
import { nonInteractiveSetupFolders, selectSetupFolders } from './setup-folder-selection.ts'

const plan = {
  facts: { machine: {}, repositories: [] },
  registrations: [],
  folderSelection: { options: [], defaults: [] },
  proposals: [
    { repository: { path: '/registered' }, current: { name: 'registered' } },
    { repository: { path: '/other' }, current: null },
  ],
  questions: [
    { id: 'machine:level' },
    { id: 'project:%2Fregistered:key-prefix', folderPath: '/registered' },
    { id: 'project:%2Fother:key-prefix', folderPath: '/other' },
  ],
  notices: [
    { message: 'global', fix: null, blocking: false },
    { message: 'registered notice', fix: null, blocking: false, folderPath: '/registered' },
    { message: 'other notice', fix: null, blocking: false, folderPath: '/other' },
  ],
} as unknown as SetupPlan

test('an unchecked folder contributes no proposal, question, or notice', () => {
  const selected = selectSetupFolders(plan, ['/registered'])
  expect(selected.proposals.map(({ repository }) => repository.path)).toEqual(['/registered'])
  expect(selected.questions.map(({ id }) => id)).toEqual([
    'machine:level',
    'project:%2Fregistered:key-prefix',
  ])
  expect(selected.notices.map(({ message }) => message)).toEqual(['global', 'registered notice'])
})

test('non-interactive setup selects registered folders plus explicit includes', () => {
  expect(nonInteractiveSetupFolders(plan, ['/other'])).toEqual(['/registered', '/other'])
  expect(nonInteractiveSetupFolders(plan, [])).toEqual(['/registered'])
})
