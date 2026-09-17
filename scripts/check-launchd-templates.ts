import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'

const plutil = Bun.which('plutil')
if (!plutil) {
  console.log('check-launchd-templates: skipped; plutil is not available')
  process.exit(0)
}

const repositoryRoot = new URL('..', import.meta.url).pathname
const templateDirectories = ['ops/launchd', 'hub/launchd'] as const
const stateHomeExemptions = new Map<string, string>([
  [
    'ops/launchd/com.user.brew-auto-upgrade.plist.template',
    'runs Homebrew only; never opens a platform store',
  ],
  [
    'ops/launchd/com.user.hub-tunnel.plist.template',
    'runs cloudflared only; never opens a platform store',
  ],
  [
    'ops/launchd/com.user.local-model-tunnel.plist.template',
    'runs ssh only; never opens a platform store',
  ],
])
const templates = templateDirectories
  .flatMap((directory) =>
    readdirSync(join(repositoryRoot, directory))
      .filter((name) => name.endsWith('.plist.template'))
      .map((name) => join(directory, name)),
  )
  .sort()
const renderedDirectory = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-launchd-lint-`))
let failed = false

try {
  for (const name of templates) {
    const template = readFileSync(join(repositoryRoot, name), 'utf8')
    if (!stateHomeExemptions.has(name) && !template.includes('<key>__STATE_HOME_ENV__</key>')) {
      failed = true
      console.error(`${name}: launchd template is missing the state-home environment entry`)
    }
    const rendered = template
      .replaceAll('__ROOT__', '/tmp/repo')
      .replaceAll('__REPO__', '/tmp/repo/ops')
      .replaceAll('__HOME__', '/tmp')
      .replaceAll('__STATE_HOME_ENV__', `${PLATFORM_SLUG.toUpperCase()}_STATE_HOME`)
      .replaceAll('__STATE_HOME__', `/tmp/${PLATFORM_SLUG}-state`)
      .replaceAll('__HUB_HOSTED_URL__', 'https://hub.example')
      .replaceAll('__MONITOR_BACKSTOP_SECONDS__', '14400')
      .replaceAll('__FIX_DEFECT_BACKSTOP_SECONDS__', '43200')
      .replaceAll('__MODEL_HOST__', 'example')
    const path = join(renderedDirectory, name.replaceAll('/', '-').replace(/\.template$/, ''))
    writeFileSync(path, rendered)
    const lint = Bun.spawnSync([plutil, '-lint', path], { stdout: 'pipe', stderr: 'pipe' })
    if (lint.exitCode !== 0) {
      failed = true
      console.error(`${name}: launchd template failed plutil -lint`)
      const detail = lint.stdout.toString() + lint.stderr.toString()
      if (detail.trim()) console.error(detail.trim())
    }
  }
  for (const [name, reason] of stateHomeExemptions) {
    if (!reason.trim()) {
      failed = true
      console.error(`${name}: state-home exemption must state a reason`)
    } else if (!templates.includes(name as (typeof templates)[number])) {
      failed = true
      console.error(`${name}: state-home exemption names no launchd template`)
    }
  }
} finally {
  rmSync(renderedDirectory, { recursive: true, force: true })
}

if (failed) process.exit(1)
