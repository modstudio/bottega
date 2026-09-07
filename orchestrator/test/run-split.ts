const legs = ['test:unit', 'test:cli'] as const

const results = await Promise.all(legs.map(async (leg) => {
  const process = Bun.spawn(['bun', 'run', leg], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return { leg, exitCode: await process.exited }
}))

for (const result of results) {
  if (result.exitCode !== 0) console.error(`${result.leg} failed with exit ${result.exitCode}`)
}
process.exit(results.some((result) => result.exitCode !== 0) ? 1 : 0)
