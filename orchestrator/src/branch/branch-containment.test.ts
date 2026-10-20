import { expect, test } from 'bun:test'
import { decideBranchContainment, decideMergeLandingBranches } from './branch-containment.ts'

test('twelve fast-forwarded workers inherit a squashed task branch content proof', () => {
  const workers = Array.from({ length: 12 }, (_, index) => `STAR-6027-orch-${index + 1}`)
  const facts = workers.map((branch, index) => ({
    branch,
    directlyLanded: false,
    containingBranches: [index === workers.length - 1 ? 'STAR-6027-task' : workers[index + 1]!],
  }))
  const result = decideBranchContainment([
    ...facts,
    { branch: 'STAR-6027-task', directlyLanded: true, containingBranches: [] },
  ])

  expect(result.size).toBe(12)
  expect(result.get('STAR-6027-orch-12')).toBe('STAR-6027-task')
  expect(result.get('STAR-6027-orch-1')).toBe('STAR-6027-orch-2')
})

test('containment without a non-containment landing proof proves nothing', () => {
  expect(
    decideBranchContainment([
      { branch: 'worker', directlyLanded: false, containingBranches: ['task'] },
      { branch: 'task', directlyLanded: false, containingBranches: [] },
    ]).size,
  ).toBe(0)
})

test('an uncontained branch and an unproven chain stay unproven beside a landed chain', () => {
  const result = decideBranchContainment([
    { branch: 'landed-worker', directlyLanded: false, containingBranches: ['landed-task'] },
    { branch: 'landed-task', directlyLanded: true, containingBranches: [] },
    { branch: 'unique-work', directlyLanded: false, containingBranches: [] },
    { branch: 'unproven-worker', directlyLanded: false, containingBranches: ['unproven-task'] },
    { branch: 'unproven-task', directlyLanded: false, containingBranches: [] },
  ])

  expect(result).toEqual(new Map([['landed-worker', 'landed-task']]))
  expect(result.has('unique-work')).toBe(false)
  expect(result.has('unproven-worker')).toBe(false)
})

test('merge recording selects key branches contained by the admitted head and the task tip', () => {
  expect(
    decideMergeLandingBranches({
      taskBranch: 'DEV-1441-task',
      admittedHead: 'squashed-head',
      branches: [
        {
          branch: 'DEV-1441-orch-a',
          tip: 'worker-a',
          carriesTaskKey: true,
          tipIsAncestorOfAdmittedHead: true,
        },
        {
          branch: 'DEV-1441-orch-unlanded',
          tip: 'worker-unlanded',
          carriesTaskKey: true,
          tipIsAncestorOfAdmittedHead: false,
        },
        {
          branch: 'DEV-999-orch-b',
          tip: 'other-task',
          carriesTaskKey: false,
          tipIsAncestorOfAdmittedHead: true,
        },
      ],
    }),
  ).toEqual([
    { branch: 'DEV-1441-orch-a', tip: 'worker-a' },
    { branch: 'DEV-1441-task', tip: 'squashed-head' },
  ])
})

test('merge recording rejects uncontained branches beside a landed chain', () => {
  expect(
    decideMergeLandingBranches({
      taskBranch: 'DEV-1441-task',
      admittedHead: 'admitted-head',
      branches: [
        {
          branch: 'DEV-1441-landed-worker',
          tip: 'landed-worker',
          carriesTaskKey: true,
          tipIsAncestorOfAdmittedHead: true,
        },
        {
          branch: 'DEV-1441-unique-work',
          tip: 'unique-work',
          carriesTaskKey: true,
          tipIsAncestorOfAdmittedHead: false,
        },
        {
          branch: 'DEV-1441-unproven-worker',
          tip: 'unproven-worker',
          carriesTaskKey: true,
          tipIsAncestorOfAdmittedHead: false,
        },
      ],
    }),
  ).toEqual([
    { branch: 'DEV-1441-landed-worker', tip: 'landed-worker' },
    { branch: 'DEV-1441-task', tip: 'admitted-head' },
  ])
})
