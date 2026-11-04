import { describe, expect, test } from 'bun:test'
import {
  FIX_DEFECT_BACKSTOP_SECONDS,
  launchAgentProgramPath,
  launchAgentRenderCommandValues,
  MONITOR_BACKSTOP_SECONDS,
  renderLaunchAgentTemplate,
} from './launch-agent-render.ts'

describe('launch-agent renderer', () => {
  test('reads the first launchd program path', () => {
    expect(
      launchAgentProgramPath(
        '<key>ProgramArguments</key><array><string>/missing/program</string></array>',
      ),
    ).toBe('/missing/program')
  })

  test('the renderer CLI supplies the shared backstop defaults when callers omit them', () => {
    const values = launchAgentRenderCommandValues([])
    expect(values.__MONITOR_BACKSTOP_SECONDS__).toBe(String(MONITOR_BACKSTOP_SECONDS))
    expect(values.__FIX_DEFECT_BACKSTOP_SECONDS__).toBe(String(FIX_DEFECT_BACKSTOP_SECONDS))

    const overridden = launchAgentRenderCommandValues(['__MONITOR_BACKSTOP_SECONDS__', '60'])
    expect(overridden.__MONITOR_BACKSTOP_SECONDS__).toBe('60')
  })

  test('the renderer CLI leaves unpassed placeholders unresolved', () => {
    const values = launchAgentRenderCommandValues(['__HOME__', '/Users/example'])
    expect(values.__INSTALL_ROOT__).toBeUndefined()
    expect(() => renderLaunchAgentTemplate('__HOME__ __INSTALL_ROOT__', values)).toThrow(
      'unresolved launch-agent placeholder(s): __INSTALL_ROOT__',
    )
  })
})
