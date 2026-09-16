import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './shared/record/schema.ts',
    './shared/record/schema-auth.ts',
    './shared/record/schema-run.ts',
    './shared/record/schema-review.ts',
    './shared/record/schema-landing.ts',
  ],
  out: './shared/record/migrations',
})
