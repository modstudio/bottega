import { readFileSync, writeFileSync } from 'node:fs'

export const LAUNCH_AGENT_PLACEHOLDERS = [
  '__INSTALL_ROOT__',
  '__BOTTEGA_BIN__',
  '__CONCERN__',
  '__HOME__',
  '__STATE_HOME_ENV__',
  '__STATE_HOME__',
  '__MONITOR_BACKSTOP_SECONDS__',
  '__FIX_DEFECT_BACKSTOP_SECONDS__',
  '__MODEL_HOST__',
  '__TUNNEL_LOCAL_PORT__',
  '__TUNNEL_REMOTE_PORT__',
  '__FLYCTL__',
  '__SPARE_START_HOUR__',
  '__SPARE_START_MINUTE__',
  '__RECORD_TUNNEL_APP__',
  '__RECORD_TUNNEL_LOCAL_PORT__',
  '__RECORD_TUNNEL_REMOTE_PORT__',
  '__HUB_PORT__',
  '__HUB_HOSTED_URL__',
] as const

export type LaunchAgentPlaceholder = (typeof LAUNCH_AGENT_PLACEHOLDERS)[number]
export type LaunchAgentRenderValues = Readonly<Record<LaunchAgentPlaceholder, string>>

/** Render the placeholder vocabulary shared by both launch-agent installers. */
export function renderLaunchAgentTemplate(
  template: string,
  values: LaunchAgentRenderValues,
): string {
  let rendered = template
  for (const placeholder of LAUNCH_AGENT_PLACEHOLDERS) {
    rendered = rendered.replaceAll(placeholder, values[placeholder])
  }
  const unresolved = rendered.match(/__[A-Z0-9_]+__/g)
  if (unresolved) {
    throw new Error(
      `unresolved launch-agent placeholder(s): ${[...new Set(unresolved)].join(', ')}`,
    )
  }
  return rendered
}

/** Read the executable launchd invokes from a rendered plist definition. */
export function launchAgentProgramPath(plist: string): string | null {
  return (
    /<key>Program(?:Arguments)?<\/key>\s*(?:<array>\s*)?<string>([^<]+)<\/string>/.exec(
      plist,
    )?.[1] ?? null
  )
}

function commandValues(args: string[]): LaunchAgentRenderValues {
  const values = Object.fromEntries(
    LAUNCH_AGENT_PLACEHOLDERS.map((placeholder) => [placeholder, '']),
  ) as Record<LaunchAgentPlaceholder, string>
  for (let index = 0; index < args.length; index += 2) {
    const placeholder = args[index]
    const value = args[index + 1]
    if (
      !LAUNCH_AGENT_PLACEHOLDERS.includes(placeholder as LaunchAgentPlaceholder) ||
      value === undefined
    )
      throw new Error(`invalid launch-agent render argument ${placeholder ?? '(missing)'}`)
    values[placeholder as LaunchAgentPlaceholder] = value
  }
  return values
}

if (import.meta.main) {
  const [templatePath, targetPath, ...args] = process.argv.slice(2)
  if (!templatePath || !targetPath) {
    throw new Error('usage: launch-agent-render.ts <template> <target> [<placeholder> <value> ...]')
  }
  writeFileSync(
    targetPath,
    renderLaunchAgentTemplate(readFileSync(templatePath, 'utf8'), commandValues(args)),
    'utf8',
  )
}
