#!/usr/bin/env bun
/** Generate the editor-facing project config schema from its one Zod definition. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { recipeJsonSchema } from '../orchestrator/src/recipe-schema.ts'

const outputPath = new URL('../orchestrator/schemas/project-config.schema.json', import.meta.url)

function generatedRecipeSchema(): string {
  const schema = recipeJsonSchema()
  const unformatted = `${JSON.stringify(schema, null, 2)}\n`
  const formatted = Bun.spawnSync(
    ['bunx', 'biome', 'format', `--stdin-file-path=${outputPath.pathname}`],
    {
      stdin: Buffer.from(unformatted),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (formatted.exitCode !== 0) {
    throw new Error(`could not format generated recipe schema: ${formatted.stderr.toString()}`)
  }
  return formatted.stdout.toString()
}

const generated = generatedRecipeSchema()
if (process.argv.includes('--check')) {
  const committed = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
  if (committed !== generated) {
    console.error('project config JSON Schema is stale; run bun scripts/generate-recipe-schema.ts')
    process.exit(1)
  }
  console.log('check-recipe-schema: ok')
} else {
  writeFileSync(outputPath, generated)
  console.log(`wrote ${outputPath.pathname}`)
}
