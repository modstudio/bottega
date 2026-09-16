import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'

const plutil = Bun.which('plutil')
if (!plutil) {
  console.log('check-launchd-templates: skipped; plutil is not available')
  process.exit(0)
}

const root = new URL('../ops/launchd', import.meta.url).pathname
const templates = readdirSync(root)
  .filter((name) => name.endsWith('.plist.template'))
  .sort()
const renderedDirectory = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-launchd-lint-`))
let failed = false

try {
  for (const name of templates) {
    const rendered = readFileSync(join(root, name), 'utf8')
      .replaceAll('__ROOT__', '/tmp/repo')
      .replaceAll('__REPO__', '/tmp/repo/ops')
      .replaceAll('__HOME__', '/tmp')
      .replaceAll('__MONITOR_BACKSTOP_SECONDS__', '14400')
      .replaceAll('__FIX_DEFECT_BACKSTOP_SECONDS__', '43200')
      .replaceAll('__MODEL_HOST__', 'example')
    const path = join(renderedDirectory, name.replace(/\.template$/, ''))
    writeFileSync(path, rendered)
    const lint = Bun.spawnSync([plutil, '-lint', path], { stdout: 'pipe', stderr: 'pipe' })
    if (lint.exitCode !== 0) {
      failed = true
      console.error(`ops/launchd/${name}: launchd template failed plutil -lint`)
      const detail = lint.stdout.toString() + lint.stderr.toString()
      if (detail.trim()) console.error(detail.trim())
    }
  }
} finally {
  rmSync(renderedDirectory, { recursive: true, force: true })
}

if (failed) process.exit(1)
