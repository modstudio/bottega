// concern: launchd installer ownership
/** Inventories installer-owned launch agents from their canonical templates. */

import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { listInstallAssetPaths, readInstallAsset } from '../../../shared/embedded-assets.ts'
import { resolveInstallRoot } from '../../../shared/install-root.ts'
import { LAUNCHD_TEMPLATE_OWNERS, launchdOwnerCommand } from '../../../shared/launchd-owners.ts'

export type InstalledPlistOwner = {
  label: string
  command: string
  templatePath?: string
  template?: string
  standardOutPath?: string
}

/** The StandardOutPath a launchd plist or template names, if any. */
export function plistStandardOutPath(text: string): string | undefined {
  return /<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
}

/** Derive every installed label and its owning installer from template paths. */
export function installedPlistOwners(
  templates: ReadonlyArray<{ path: string; text: string }>,
): InstalledPlistOwner[] {
  return templates
    .filter(({ path }) => path.endsWith('.plist.template'))
    .map(({ path, text }) => {
      const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
      if (!label) throw new Error(`launchd template ${path} has no Label`)
      const standardOutPath = plistStandardOutPath(text)
      const concern = basename(dirname(dirname(path)))
      return {
        label,
        command: launchdOwnerCommand(concern),
        templatePath: path,
        template: text,
        ...(standardOutPath ? { standardOutPath } : {}),
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label))
}

/** Answer whether this platform has launch agents to inspect. */
export function includesLaunchAgents(platform: NodeJS.Platform): boolean {
  return platform === 'darwin'
}

/** Read every installer-owned launchd template from the checkout. */
export async function installationPlistOwners(): Promise<InstalledPlistOwner[]> {
  const root = resolveInstallRoot(import.meta.dir, process.env)
  const templates: Array<{ path: string; text: string }> = []
  for (const owner of LAUNCHD_TEMPLATE_OWNERS) {
    const prefix = `${owner.concern}/${owner.directory}`
    const embeddedPaths = listInstallAssetPaths(prefix)
    if (embeddedPaths) {
      for (const path of embeddedPaths) {
        if (!path.endsWith('.plist.template')) continue
        templates.push({ path, text: readInstallAsset(path, '') })
      }
      continue
    }
    const directory = join(root, prefix)
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.plist.template')) continue
      const path = join(prefix, name)
      templates.push({ path, text: await readFile(join(root, path), 'utf8') })
    }
  }
  return installedPlistOwners(templates)
}
