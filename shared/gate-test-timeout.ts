export const CI_TEST_HANG_TIMEOUT_MS = 60_000

export function gateTestTimeoutArguments(ci: boolean): string[] {
  return ci ? [`--timeout=${CI_TEST_HANG_TIMEOUT_MS}`] : []
}

type SuiteCommand = {
  argv: readonly string[]
  unitTests?: boolean
}

// Python unit suites are timing-category peers, but Bun's per-test timeout cannot apply to them.
export function isBunUnitTestCommand(command: SuiteCommand): boolean {
  return command.unitTests === true && command.argv[0] === 'bun'
}

export function checkSuiteTestTimeoutArguments(
  commands: readonly SuiteCommand[],
  ci: boolean,
): void {
  const timeout = `--timeout=${CI_TEST_HANG_TIMEOUT_MS}`
  for (const command of commands) {
    if (!isBunUnitTestCommand(command)) continue
    const carriesTimeout = command.argv.includes(timeout)
    if (ci === carriesTimeout) continue
    throw new Error(
      ci
        ? `CI Bun unit-test command must carry ${timeout}: ${command.argv.join(' ')}`
        : `local Bun unit-test command must keep Bun's default timeout: ${command.argv.join(' ')}`,
    )
  }
}

export function checkSingleBunTestScript(script: string, name: string): void {
  if (/^bun test(?:\s+[^\n]*)?$/.test(script) && !/(?:&&|\|\||;|\|)/.test(script)) return
  throw new Error(
    `${name} must be a single bun test invocation so CI timeout arguments reach it; got ${JSON.stringify(script)}`,
  )
}
