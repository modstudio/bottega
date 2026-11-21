import { describe, expect, test } from 'bun:test'
import { browserProbeVerdict, headlessShellExecutable } from './confinement-browser-probe.ts'

function directoryListing(entries: Record<string, readonly string[]>) {
  return (directory: string) => {
    const listing = entries[directory]
    if (!listing) throw new Error(`missing ${directory}`)
    return listing
  }
}

describe('headlessShellExecutable', () => {
  test('selects the newest numeric build with an executable', () => {
    const root = '/home/worker/.cache/ms-playwright'
    expect(
      headlessShellExecutable({
        platform: 'linux',
        homeDirectory: '/home/worker',
        playwrightBrowsersPath: undefined,
        listDirectory: directoryListing({
          [root]: ['chromium_headless_shell-999', 'chromium_headless_shell-1248'],
          [`${root}/chromium_headless_shell-999/chrome-headless-shell-linux64`]: [
            'chrome-headless-shell',
          ],
          [`${root}/chromium_headless_shell-1248/chrome-headless-shell-linux64`]: [
            'chrome-headless-shell',
          ],
        }),
      }),
    ).toBe(
      `${root}/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`,
    )
  })

  test('skips a newer build whose executable is absent', () => {
    const root = '/home/worker/.cache/ms-playwright'
    expect(
      headlessShellExecutable({
        platform: 'linux',
        homeDirectory: '/home/worker',
        playwrightBrowsersPath: undefined,
        listDirectory: directoryListing({
          [root]: ['chromium_headless_shell-1248', 'chromium_headless_shell-999'],
          [`${root}/chromium_headless_shell-1248/chrome-headless-shell-linux64`]: [],
          [`${root}/chromium_headless_shell-999/chrome-headless-shell-linux64`]: [
            'chrome-headless-shell',
          ],
        }),
      }),
    ).toBe(
      `${root}/chromium_headless_shell-999/chrome-headless-shell-linux64/chrome-headless-shell`,
    )
  })

  test('uses PLAYWRIGHT_BROWSERS_PATH instead of the platform default', () => {
    const root = '/browser-cache'
    expect(
      headlessShellExecutable({
        platform: 'darwin',
        homeDirectory: '/Users/worker',
        playwrightBrowsersPath: root,
        listDirectory: directoryListing({
          [root]: ['chromium_headless_shell-1248'],
          [`${root}/chromium_headless_shell-1248/chrome-headless-shell-mac-x64`]: [
            'chrome-headless-shell',
          ],
        }),
      }),
    ).toBe(
      `${root}/chromium_headless_shell-1248/chrome-headless-shell-mac-x64/chrome-headless-shell`,
    )
  })

  test('returns null on an unsupported platform', () => {
    expect(
      headlessShellExecutable({
        platform: 'win32',
        homeDirectory: 'C:\\Users\\worker',
        playwrightBrowsersPath: undefined,
        listDirectory: () => {
          throw new Error('must not list')
        },
      }),
    ).toBeNull()
  })
})

describe('browserProbeVerdict', () => {
  test('reports no executable as not covered', () => {
    expect(browserProbeVerdict({ executable: null, exitCode: 0, stdout: '' })).toEqual({
      status: 'not covered',
      reason:
        'no Playwright chrome-headless-shell installed (npx playwright install chromium-headless-shell)',
    })
  })

  test('reports a successful DOM dump as ran', () => {
    expect(
      browserProbeVerdict({
        executable: '/cache/chrome-headless-shell',
        exitCode: 0,
        stdout: '<html><body></body></html>',
      }),
    ).toEqual({ status: 'ran' })
  })

  test('reports a nonzero exit and names its code', () => {
    expect(
      browserProbeVerdict({
        executable: '/cache/chrome-headless-shell',
        exitCode: 133,
        stdout: '',
        stderr: 'bootstrap_check_in denied\nmore detail',
      }),
    ).toEqual({ status: 'failed', reason: 'exit 133: bootstrap_check_in denied' })
  })
})
