import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/postgres-schema.ts',
    './src/postgres-schema-run.ts',
    './src/postgres-schema-review.ts',
  ],
  out: './postgres/migrations',
})
