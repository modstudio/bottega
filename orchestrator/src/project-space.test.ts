import { expect, test } from 'bun:test'
import { workflowReadSpace } from './project-space.ts'

const refusals = {
  missingActiveSpaceRefusal: 'switch the active space',
  missingProjectRouteRefusal: 'pull the project route',
  rejectedProjectRouteRefusal: 'accept the space invitation',
}

test.each([
  {
    name: 'a bound project whose route has not been pulled',
    input: {
      project: 'unrouted-project',
      projectSpace: undefined,
      activeSpace: 'active-space',
      localAuthoritative: false,
      ...refusals,
    },
    expected: { refused: 'pull the project route' },
  },
])('workflow reads resolve $name', ({ input, expected }) => {
  expect(workflowReadSpace(input)).toEqual(expected)
})
