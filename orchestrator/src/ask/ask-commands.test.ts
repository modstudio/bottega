import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { setupAskCommand } from './ask-commands.ts'

test('setup-ask exits non-zero when any registration fails', async () => {
  const output: string[] = []
  const code = await setupAskCommand(
    [`/bin/${PLATFORM_SLUG}`, 'mcp', 'ask-server'],
    { log: (line) => output.push(line) },
    {
      find: (name) => `/bin/${name}`,
      runner: (argv) => ({
        exitCode: argv[0] === '/bin/grok' ? 1 : 0,
        stdout: argv.includes('get')
          ? `Command: /bin/${PLATFORM_SLUG}\nArgs: ["mcp","ask-server"]`
          : argv.includes('list')
            ? '[]'
            : '',
        stderr: argv[0] === '/bin/grok' ? 'registration failed' : '',
        timedOut: false,
        error: null,
      }),
    },
  )
  expect(code).toBe(1)
  expect(output.join('\n')).toContain('FAIL grok')
})

test('setup-ask guards a differing registration and directs replacement through setup apply', async () => {
  const output: string[] = []
  const calls: string[][] = []
  const code = await setupAskCommand(
    [`/bin/${PLATFORM_SLUG}`, 'mcp', 'ask-server'],
    { log: (line) => output.push(line) },
    {
      find: (name) => `/bin/${name}`,
      runner: (argv) => {
        calls.push(argv)
        const stdout = argv.includes('get')
          ? JSON.stringify({
              transport: { type: 'stdio', command: '/somewhere/else', args: [] },
            })
          : JSON.stringify([{ name: 'orch-ask', command: '/somewhere/else', args: [] }])
        return { exitCode: 0, stdout, stderr: '', timedOut: false, error: null }
      },
    },
  )
  expect(code).toBe(1)
  expect(calls.some((argv) => argv.includes('add'))).toBe(false)
  expect(output.join('\n')).toContain(
    `run ${PLATFORM_SLUG} machine setup apply to review and replace it`,
  )
})
