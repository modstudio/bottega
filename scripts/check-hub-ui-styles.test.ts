import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  analyzeComponentStory,
  analyzeComponentStyleCalls,
  analyzeStyleModule,
} from './check-hub-ui-styles.ts'

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

  test('requires a sibling story that covers a value-imported markup component', () => {
    const component = 'export function Example() { return <div /> }'
    expect(analyzeComponentStory(component, undefined, componentPath)).toContainEqual(
      expect.stringContaining('requires sibling example.stories.tsx'),
    )
    expect(
      analyzeComponentStory(
        component,
        "import { Example } from './example'; export default { component: Example }; export const Default = {}",
        componentPath,
      ),
    ).toEqual([])
    expect(
      analyzeComponentStory(
        component,
        "import { Example } from './example'; export const Default = {}",
        componentPath,
      ),
    ).toContainEqual(expect.stringContaining('must name an imported subject'))
    expect(
      analyzeComponentStory(
        component,
        "import { Example } from './example'; export default { component: Example }; export const Default = { render: () => <p>{Example.name}</p> }",
        componentPath,
      ),
    ).toContainEqual(expect.stringContaining('must name an imported subject'))
    expect(
      analyzeComponentStory(
        component,
        "import { Example } from './example'; export default {}; export const Default = { render: () => <Example /> }",
        componentPath,
      ),
    ).toEqual([])
    expect(
      analyzeComponentStory(
        component,
        "import './example'; export const Default = { render: () => <div /> }",
        componentPath,
      ),
    ).toContainEqual(expect.stringContaining('must value-import'))
    expect(
      analyzeComponentStory(
        component,
        "import { Example } from './example'; const Other = () => <div />; export default { component: Other }; export const Default = {}",
        componentPath,
      ),
    ).toContainEqual(expect.stringContaining('must name an imported subject'))
  })

  test('requires interactive components to have a play with a post-interaction assertion', () => {
    const component = 'export function Example() { return <button type="button">Run</button> }'
    const prefix =
      "import { Example } from './example'; export default { component: Example }; export const Keyboard = "
    expect(analyzeComponentStory(component, `${prefix}{}`, componentPath)).toContainEqual(
      expect.stringContaining('requires a story with a play function'),
    )
    expect(
      analyzeComponentStory(
        component,
        `${prefix}{ play: async () => { await expect(true).toBe(true); await userEvent.keyboard('{Enter}') } }`,
        componentPath,
      ),
    ).toContainEqual(expect.stringContaining('must call expect after its last userEvent'))
    expect(
      analyzeComponentStory(
        component,
        `${prefix}{ play: async () => { await userEvent.keyboard('{Enter}'); await expect(true).toBe(true) } }`,
        componentPath,
      ),
    ).toEqual([])
  })
})
