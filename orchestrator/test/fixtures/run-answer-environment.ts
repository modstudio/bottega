export function installRunAnswerEnvironment(): () => void {
  const prior = {
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    BOTTEGA_DEPTH: process.env.BOTTEGA_DEPTH,
    BOTTEGA_EXEC_PATH: process.env.BOTTEGA_EXEC_PATH,
  }
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  delete process.env.BOTTEGA_DEPTH
  process.env.BOTTEGA_EXEC_PATH = '/usr/bin/true'
  return () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
