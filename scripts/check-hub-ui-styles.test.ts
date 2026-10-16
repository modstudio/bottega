import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { analyzeComponentStyleCalls, analyzeStyleModule } from './check-hub-ui-styles.ts'

const stylesPath = join(process.cwd(), 'hub/ui/src/example/example.styles.ts')
const componentPath = join(process.cwd(), 'hub/ui/src/example/example.tsx')

describe('hub-ui styles decisions', () => {
  test('refuses an exported plain style function', () => {
    const result = analyzeStyleModule(
      "import { variant } from '../text/variant.ts'\nexport const exampleStyles = () => () => 'text-sm'",
      stylesPath,
    )
    expect(result.violations).toContainEqual(
      expect.stringContaining('must be created by the shared variant function'),
    )
  })

  test('refuses literal appearance classes in a style call', () => {
    const violations = analyzeComponentStyleCalls(
      "import { exampleStyles } from './example.styles.ts'\nexport const Example = () => <div className={exampleStyles({ class: 'text-sm' })} />",
      componentPath,
      './example.styles.ts',
      new Set(),
    )
    expect(violations).toContainEqual(
      expect.stringContaining('may only pass through layout className'),
    )
  })

  test('accepts declared variant values and a layout className passthrough', () => {
    const source =
      "import { exampleStyles } from './example.styles.ts'\nexport function Example({ className, active }: { className?: string; active: boolean }) { return <div className={exampleStyles({ tone: 'quiet', active, class: className })} /> }"
    expect(
      analyzeComponentStyleCalls(source, componentPath, './example.styles.ts', new Set(['quiet'])),
    ).toEqual([])
  })
})
