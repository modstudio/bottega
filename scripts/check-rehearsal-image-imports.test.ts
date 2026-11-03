import { expect, test } from 'bun:test'
import { rehearsalImageImportFindings } from './check-rehearsal-image-imports.ts'

test('reports the uncopied runtime closure of rehearsal eval imports', () => {
  const sources: Record<string, string> = {
    'app/start.ts':
      "import { value } from './runtime.ts'\nimport type { Shape } from './types.ts'\nimport { type OtherShape } from './other-types.ts'\nexport { value }\n",
    'app/runtime.ts': "import './nested/value.ts'\nexport const value = true\n",
    'app/nested/value.ts': 'export const nested = true\n',
  }
  const script = `bun --eval '
    import { value } from "./app/start.ts";
    console.log(value);
  '`
  const dockerfile = 'COPY app/start.ts app/start.ts\nCOPY app/runtime.ts app/runtime.ts\n'

  expect(rehearsalImageImportFindings(script, dockerfile, (path) => sources[path]!)).toEqual([
    'app/nested/value.ts',
  ])
})

test('accepts an ancestor directory copy', () => {
  const script = `bun --eval 'import "./app/start.ts";'`
  expect(
    rehearsalImageImportFindings(script, 'COPY app app\n', (path) => {
      expect(path).toBe('app/start.ts')
      return ''
    }),
  ).toEqual([])
})
