import { expect, test } from 'bun:test'
import { isAskServerInvocation } from './ask-invocation.ts'

test('the ask server is recognized by its own command name and by its public path', () => {
  expect(isAskServerInvocation(['ask-server'])).toBeTrue()
  expect(isAskServerInvocation(['mcp', 'ask-server'])).toBeTrue()
  expect(
    isAskServerInvocation([], { ownerPath: ['ask-server'], publicPath: ['mcp', 'ask-server'] }),
  ).toBeTrue()
})

test('no other invocation declares itself the ask server', () => {
  expect(isAskServerInvocation([])).toBeFalse()
  expect(isAskServerInvocation(['ask'])).toBeFalse()
  expect(isAskServerInvocation(['machine', 'migrate'])).toBeFalse()
  expect(isAskServerInvocation(['mcp', 'gate'])).toBeFalse()
  expect(isAskServerInvocation(['mcp'])).toBeFalse()
  expect(
    isAskServerInvocation([], {
      ownerPath: ['machine', 'migrate'],
      publicPath: ['machine', 'migrate'],
    }),
  ).toBeFalse()
})
