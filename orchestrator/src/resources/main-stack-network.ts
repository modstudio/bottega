// concern: exact host network destinations exposed by a declared main stack

type PublishedPort = {
  host_ip?: unknown
  published?: unknown
}

type ComposeConfig = {
  services?: Record<string, { ports?: PublishedPort[] | null }>
}

function hostForPublishedPort(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value === '0.0.0.0' || value === '::') {
    return '127.0.0.1'
  }
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
}

/** Reduce Compose's resolved config to the exact host:port destinations a gate can reach. */
export function mainStackPublishedAddresses(
  config: ComposeConfig,
  requiredServices?: readonly string[],
): string[] {
  const services = config.services ?? {}
  const names = requiredServices ?? Object.keys(services)
  const addresses: string[] = []
  for (const name of names) {
    const service = services[name]
    if (!service)
      throw new Error(`declared main-stack service ${name} is absent from Compose config`)
    for (const port of service.ports ?? []) {
      const published = port.published
      if (
        (typeof published !== 'string' && typeof published !== 'number') ||
        !/^\d+$/.test(String(published)) ||
        Number(published) < 1 ||
        Number(published) > 65535
      ) {
        throw new Error(`main-stack service ${name} has no exact published host port`)
      }
      addresses.push(`${hostForPublishedPort(port.host_ip)}:${published}`)
    }
  }
  return [...new Set(addresses)]
}

type GateMainStackProject = {
  path: string
  settings: {
    mainStack?: { consumers: readonly string[]; requiredServices?: readonly string[] }
  }
}

/** Resolve gate destinations before an ACP writer's one immutable network profile is built. */
export function mainStackGateAddresses(project: GateMainStackProject): string[] {
  const declaration = project.settings.mainStack
  if (!declaration?.consumers.includes('gate')) return []
  const command = ['docker', 'compose', 'config', '--format', 'json']
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(command, {
      cwd: project.path,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    })
  } catch (error) {
    throw new Error(
      `writing ACP sandbox could not resolve the gate main-stack network: ${(error as Error).message}; run ${command.join(' ')} in ${project.path}, then retry`,
    )
  }
  if (result.exitCode !== 0 || result.exitedDueToTimeout) {
    throw new Error(
      `writing ACP sandbox could not resolve the gate main-stack network: ${result.stderr?.toString().trim() || 'timed out'}; run ${command.join(' ')} in ${project.path}, then retry`,
    )
  }
  let config: ComposeConfig
  try {
    config = JSON.parse(result.stdout?.toString() ?? '') as ComposeConfig
  } catch (error) {
    throw new Error(
      `writing ACP sandbox could not read the gate main-stack network from Compose JSON: ${(error as Error).message}; run ${command.join(' ')} in ${project.path}, then retry`,
    )
  }
  try {
    return mainStackPublishedAddresses(config, declaration.requiredServices)
  } catch (error) {
    throw new Error(
      `writing ACP sandbox could not name the gate main-stack network exactly: ${(error as Error).message}; give every gate-reachable service a fixed published port, then retry`,
    )
  }
}
