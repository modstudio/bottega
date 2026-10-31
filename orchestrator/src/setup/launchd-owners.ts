// concern: launchd installer ownership
/** Inventories installer-owned launch agents from their canonical templates. */

import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export type InstalledPlistOwner = { label: string; command: string }

const LAUNCHD_TEMPLATE_OWNERS = [
  { concern: 'hub', directory: 'launchd', command: 'hub/bin/install-launchd.sh' },
  { concern: 'ops', directory: 'launchd', command: 'ops/install.sh' },
] as const

/** Derive every installed label and its owning installer from template paths. */
export function installedPlistOwners(
  templates: ReadonlyArray<{ path: string; text: string }>,
): InstalledPlistOwner[] {
  return templates
    .filter(({ path }) => path.endsWith('.plist.template'))
    .map(({ path, text }) => {
      const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
      if (!label) throw new Error(`launchd template ${path} has no Label`)
      const concern = basename(dirname(dirname(path)))
      const owner = LAUNCHD_TEMPLATE_OWNERS.find((candidate) => candidate.concern === concern)
      if (!owner) throw new Error(`launchd template ${path} has unknown concern ${concern}`)
      return {
        label,
        command: owner.command,
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label))
}

/** Read every installer-owned launchd template from the checkout. */
export async function installationPlistOwners(): Promise<InstalledPlistOwner[]> {
  const root = resolve(import.meta.dir, '../../..')
  const templates: Array<{ path: string; text: string }> = []
  for (const owner of LAUNCHD_TEMPLATE_OWNERS) {
    const directory = join(root, owner.concern, owner.directory)
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.plist.template')) continue
      const path = join(directory, name)
      templates.push({ path, text: await readFile(path, 'utf8') })
    }
  }
  return installedPlistOwners(templates)
}
