import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import {
  CONFIG_HOME_ENV,
  HARNESS_ENV_FILE_ENV,
  resolveConfigRoot,
  resolveEnvFilePaths,
} from './config-directory.ts'

describe('config root resolution', () => {
  test('platform override wins over XDG and HOME', () => {
    expect(
      resolveConfigRoot({
        [CONFIG_HOME_ENV]: '/override/config',
        XDG_CONFIG_HOME: '/xdg/config',
        HOME: '/home/person',
      }),
    ).toBe('/override/config')
  })

  test('absolute XDG config home wins over HOME', () => {
    expect(resolveConfigRoot({ XDG_CONFIG_HOME: '/xdg/config', HOME: '/home/person' })).toBe(
      join('/xdg/config', PLATFORM_SLUG),
    )
  })

  test('HOME fallback also handles a relative XDG config home', () => {
    expect(resolveConfigRoot({ XDG_CONFIG_HOME: 'relative', HOME: '/home/person' })).toBe(
      join('/home/person', '.config', PLATFORM_SLUG),
    )
  })

  test('a relative platform override is refused with its remedy', () => {
    expect(() => resolveConfigRoot({ [CONFIG_HOME_ENV]: 'relative/config' })).toThrow(
      `${CONFIG_HOME_ENV} must be an absolute config root; set it to an absolute path`,
    )
  })

  test('the harness source can be disabled', () => {
    expect(
      resolveEnvFilePaths({
        HOME: '/home/person',
        [HARNESS_ENV_FILE_ENV]: '',
      }),
    ).toEqual([join('/home/person', '.config', PLATFORM_SLUG, `${PLATFORM_SLUG}.env`)])
  })
})
