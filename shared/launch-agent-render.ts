import { readFileSync, writeFileSync } from 'node:fs'

export const LAUNCH_AGENT_PLACEHOLDERS = [
  '__INSTALL_ROOT__',
  '__BOTTEGA_BIN__',
  '__CONCERN__',
  '__HOME__',
  '__STATE_HOME_ENV__',
  '__STATE_HOME__',
  '__RECORD_SYNC_QUEUE__',
  '__RECORD_SYNC_MARKER__',
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

type LaunchAgentPlaceholder = (typeof LAUNCH_AGENT_PLACEHOLDERS)[number]
export type LaunchAgentRenderValues = Readonly<Record<LaunchAgentPlaceholder, string>>

/**
 * Provisional: stale runs were 16-40h old and ghost intervals 19h old when this
 * backstop was introduced, so four hours caught every measured case without
 * hourly noise. Each pass records condition ages; revisit after enough evidence.
 */
export const MONITOR_BACKSTOP_SECONDS = 4 * 60 * 60
export const FIX_DEFECT_BACKSTOP_SECONDS = 12 * 60 * 60

/** Render the placeholder vocabulary shared by both launch-agent installers. */
export function renderLaunchAgentTemplate(
  template: string,
  values: Readonly<Partial<LaunchAgentRenderValues>>,
): string {
  let rendered = template
  for (const placeholder of LAUNCH_AGENT_PLACEHOLDERS) {
    const value = values[placeholder]
    if (value !== undefined) rendered = rendered.replaceAll(placeholder, value)
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

export function launchAgentRenderCommandValues(
  args: string[],
): Readonly<Partial<LaunchAgentRenderValues>> {
  const values: Partial<Record<LaunchAgentPlaceholder, string>> = {}
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
  if (!args.includes('__MONITOR_BACKSTOP_SECONDS__'))
    values.__MONITOR_BACKSTOP_SECONDS__ = String(MONITOR_BACKSTOP_SECONDS)
  if (!args.includes('__FIX_DEFECT_BACKSTOP_SECONDS__'))
    values.__FIX_DEFECT_BACKSTOP_SECONDS__ = String(FIX_DEFECT_BACKSTOP_SECONDS)
  return values
}

if (import.meta.main) {
  const [templatePath, targetPath, ...args] = process.argv.slice(2)
  if (!templatePath || !targetPath) {
    throw new Error('usage: launch-agent-render.ts <template> <target> [<placeholder> <value> ...]')
  }
  writeFileSync(
    targetPath,
    renderLaunchAgentTemplate(
      readFileSync(templatePath, 'utf8'),
      launchAgentRenderCommandValues(args),
    ),
    'utf8',
  )
}
