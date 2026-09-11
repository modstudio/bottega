import { expect, test } from 'bun:test'
import { dispatchCommand } from './dispatch-commands.ts'

const flagsFor = (argv: string[]) => ({
  has: (name: string) => argv.includes(`--${name}`),
  flag: (name: string) => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 ? argv[at + 1] : undefined
  },
  values: () => [],
})

function presentation(errors: string[]) {
  return {
    usage: () => { throw new Error('usage') }, doUsage: () => { throw new Error('do usage') },
    error: (...values: unknown[]) => errors.push(values.join(' ')), printRunId: () => {},
    readPrompt: async () => { throw new Error('/definitely/not/a/prompt') },
    validateSchema: () => ({}), warnCallerDrift: () => {}, contractConflicts: () => [],
    warnImplementContractConflicts: () => {}, checkoutHasUncommittedWork: () => false,
    resolveBase: () => ({}), implicitReviewWarning: () => '',
    resolveDispatchOptions: async () => ({ agent: undefined, transport: 'cli' as const, transportExplicit: false, avoid: [], distinctModels: [], mcp: undefined }),
    detach: async () => 1, follow: async () => ({}),
  }
}

test('an unattributed run warns with the explicit repo remedy', async () => {
  const argv = ['do', 'summarize', '--file', '/definitely/not/a/prompt']; const errors: string[] = []
  await expect(dispatchCommand(argv, flagsFor(argv), presentation(errors))).rejects.toThrow('/definitely/not/a/prompt')
  expect(errors.join('\n')).toContain('will not be attributed to any project')
  expect(errors.join('\n')).toContain('--repo <name>')
})

test('an explicit repo is validated before the prompt is read', async () => {
  const argv = ['do', 'summarize', '--repo', 'not-registered', '--file', '/definitely/not/a/prompt']
  let read = false; const shown = presentation([])
  shown.readPrompt = async () => { read = true; throw new Error('prompt read') }
  await expect(dispatchCommand(argv, flagsFor(argv), shown)).rejects.toThrow('unknown repo "not-registered"')
  expect(read).toBe(false)
})

