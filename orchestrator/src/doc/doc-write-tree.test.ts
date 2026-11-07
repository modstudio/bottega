import { expect, test } from 'bun:test'
import { decideDocWriteTree, selectDocWriteTree } from './doc-write-tree.ts'

const registeredCheckout = '/projects/subject'
const subjectProject = { repositoryIdentity: '/projects/subject', registeredCheckout }

test('a matching shell checkout picks the shell toplevel', () => {
  expect(
    decideDocWriteTree({
      shellCheckout: {
        repositoryIdentity: '/projects/subject',
        toplevel: '/projects/subject/.worktrees/feature',
      },
      subjectProject,
    }),
  ).toBe('/projects/subject/.worktrees/feature')
})

test("another project's shell checkout picks the registered checkout", () => {
  expect(
    decideDocWriteTree({
      shellCheckout: { repositoryIdentity: '/projects/other', toplevel: '/projects/other' },
      subjectProject,
    }),
  ).toBe(registeredCheckout)
})

test('no shell git checkout picks the registered checkout', () => {
  expect(
    decideDocWriteTree({
      shellCheckout: { repositoryIdentity: null, toplevel: null },
      subjectProject,
    }),
  ).toBe(registeredCheckout)
})

test('non-canon writes have no selected canon tree', () => {
  expect(selectDocWriteTree({ scope: 'project', subject: 'anything' })).toBeUndefined()
})
