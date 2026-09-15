import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: [
    './src/schema-core.ts',
    './src/schema-docs.ts',
    './src/schema-review.ts',
    './src/schema-lens.ts',
    './src/schema-workflow.ts',
    './src/schema-port.ts',
  ],
  out: './migrations',
})
