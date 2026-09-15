/**
 * A worktree, built from a project's DECLARATION rather than its script.
 *
 * Three of the projects on this machine have a `scripts/worktree` of their own,
 * each several hundred lines, and they do substantially the same things: branch
 * from a base, install dependencies, generate an env file, give the tree its own
 * database, migrate, serve on a port of its own, and tear all of it down again.
 * They differ in the details and agree on the shape.
 *
 * A project adopting bottega should not have to write that fourth time. So a
 * project can DECLARE the shape instead — and bottega runs it. `worktree.create`
 * (a command) stays the escape hatch for a project that already has one or needs
 * something this cannot express; `worktree.recipe` is for everyone else.
 *
 * WHAT THIS DELIBERATELY IS NOT. It does not talk to a database server itself.
 * Every provider below is a template for the project's OWN client — `psql`,
 * `mysql`, `docker compose` — because the alternative is bottega holding
 * credentials for every project's database and taking responsibility for other
 * people's data. It knows the SHAPE of provisioning; the project keeps the keys.
 *
 * Every step is optional. A project that needs nothing but a branch declares an
 * empty recipe and gets exactly what plain git would have given it — which is
 * the right answer for a repo where a checkout is just files, and the wrong one
 * everywhere a checkout is a running application.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How a worktree gets a database of its own.
 *
 * Read off what the three existing scripts actually do, rather than invented:
 * one project clones a Postgres template, another restores a MySQL bundle at a
 * chosen size, and a third brings up a container per tree. `none` is first because
 * it is the honest default and the other three are opt-in.
 */
export type DbProvider =
  | { kind: 'none' }
  /**
   * `CREATE DATABASE <name> TEMPLATE <template>` — the cheapest real database
   * there is, and the reason one project's worktrees carry the full dataset without
   * seeding. The template must already exist; bottega will not build one,
   * because building it is a project decision about which data is safe to copy.
   */
  | { kind: 'postgres-template'; template: string; psql?: string }
  /** Restore a dump into a fresh database. `{db}` and `{dump}` are filled in. */
  | { kind: 'mysql-dump'; dump: string; mysql?: string }
  /** The project's own compose file brings the tree's services up and down. */
  | { kind: 'compose'; up: string; down: string }

export type Recipe = {
  /** What to branch from. `origin/develop` in two of these repos, HEAD in another. */
  baseRef?: string
  /** Dependencies. Run in the worktree, after it exists. */
  install?: string
  /**
   * The env file this tree needs, as a template written into the worktree.
   *
   * `{db}` is the database name bottega derived, `{path}` the worktree, `{name}`
   * its directory name, `{port}` the port it was allocated. Written LAST among
   * the setup steps that produce files, so a generated value cannot be
   * overwritten by an install that rewrites config.
   */
  env?: { path: string; contents: string; append?: boolean }
  database?: DbProvider
  /** Migrations, if the project does not fold them into install. */
  migrate?: string
  /** Bring the tree up / take it down. Reported to the worker, not run by orch. */
  serve?: string
  stop?: string
  /** Anything else, last, once the tree is otherwise ready. */
  after?: string
}

/** One step's outcome, kept so a failure can say which step and why. */
export type StepResult = { step: string; ok: boolean; detail: string }

function verifySqlCounts(result: StepResult & { out: string }, step: string): StepResult {
  const numbers = result.out.trim().split(/\s+/).map(Number)
  const tables = numbers[0]
  const constraints = numbers[1]
  if (!result.ok || !Number.isFinite(tables) || !Number.isFinite(constraints)) {
    return {
      step: `${step} verify`,
      ok: false,
      detail: `restore reported success but row/constraint counts were not readable: ${result.out || result.detail}`,
    }
  }
  return {
    step: `${step} verify`,
    ok: true,
    detail: `${tables} tables, ${constraints} constraints`,
  }
}

function sh(cmd: string, cwd: string, env?: Record<string, string>): StepResult & { out: string } {
  const p = Bun.spawnSync(['sh', '-c', cmd], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(env ?? {}) },
  })
  const out = `${p.stdout.toString()}${p.stderr.toString()}`.trim()
  return { step: cmd.slice(0, 60), ok: p.exitCode === 0, detail: out, out }
}

/**
 * A database name derived from the run, safe for both engines.
 *
 * Postgres folds unquoted identifiers to lower case and MySQL forbids most
 * punctuation, so the safe intersection is lower-case alphanumerics and
 * underscores. Derived from the run id rather than the branch because a branch
 * name carries slashes and a ticket key's case, and a name that needs quoting
 * is a name that will one day be used unquoted.
 */
export function dbNameFor(base: string, runId: number): string {
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${clean || 'app'}_wt_${runId}`
}

const fillPlain = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')

export const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (placeholder, k: string, offset: number) => {
    const value = vars[k] ?? ''
    let quote: "'" | '"' | null = null
    for (let i = 0; i < offset; i++) {
      const char = template[i]
      if (char === '\\' && quote !== "'") {
        i++
      } else if (char === "'" && quote !== '"') {
        quote = quote === "'" ? null : "'"
      } else if (char === '"' && quote !== "'") {
        quote = quote === '"' ? null : '"'
      }
    }
    if (quote === "'") return value.replace(/'/g, "'\\''")
    if (quote === '"') return value.replace(/[\\"$`]/g, '\\$&')
    return `'${value.replace(/'/g, "'\\''")}'`
  })

/**
 * Provision a database for a worktree, through the project's own client.
 *
 * Returns the commands actually run, so a failure names the step rather than
 * leaving a half-made tree and a generic error. A provider that fails is fatal:
 * a worker given a tree whose database never appeared will run tests against
 * nothing, and this whole file exists because that failure reports itself as a
 * pass.
 */
export function provisionDb(db: DbProvider, dbName: string, cwd: string): StepResult[] {
  switch (db.kind) {
    case 'none':
      return []
    case 'postgres-template': {
      const psql = db.psql ?? 'psql'
      // Dropped first so a re-run is idempotent: a half-made tree that is being
      // rebuilt must not fail on a database its previous attempt created.
      const drop = sh(`${psql} -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS "${dbName}"'`, cwd)
      const create = sh(
        `${psql} -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "${dbName}" TEMPLATE "${db.template}"'`,
        cwd,
      )
      const counts = sh(
        `${psql} -v ON_ERROR_STOP=1 -d "${dbName}" -tAc "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')) || ' ' || (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema NOT IN ('pg_catalog','information_schema'))"`,
        cwd,
      )
      const verified = verifySqlCounts(counts, `clone ${db.template}`)
      return [
        { ...drop, step: 'drop database if it exists' },
        { ...create, step: `clone ${db.template}` },
        verified,
      ]
    }
    case 'mysql-dump': {
      const mysql = db.mysql ?? 'mysql'
      // MySQL quotes identifiers with a backtick, which a template literal
      // cannot carry without escaping that is easy to get wrong and unreadable
      // once it is right. Held as a constant instead.
      const q = String.fromCharCode(96)
      const create = sh(
        `${mysql} -e 'DROP DATABASE IF EXISTS ${q}${dbName}${q}; CREATE DATABASE ${q}${dbName}${q}'`,
        cwd,
      )
      const load = sh(`${mysql} ${dbName} < ${fill(db.dump, { db: dbName })}`, cwd)
      const counts = sh(
        `${mysql} -N -e "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${dbName}') AS tables, (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema='${dbName}') AS constraints"`,
        cwd,
      )
      const verified = verifySqlCounts(counts, 'load dump')
      return [{ ...create, step: 'create database' }, { ...load, step: 'load dump' }, verified]
    }
    case 'compose': {
      const up = sh(fill(db.up, { db: dbName }), cwd)
      return [{ ...up, step: 'compose up' }]
    }
  }
}

/** Take a worktree's database down again. Best effort: a sweep is the backstop. */
export function teardownDb(db: DbProvider, dbName: string, cwd: string): StepResult[] {
  switch (db.kind) {
    case 'none':
      return []
    case 'postgres-template': {
      const psql = db.psql ?? 'psql'
      // Connections are terminated first: Postgres refuses to drop a database
      // anything is still attached to, and a dev server that outlived the
      // worktree is exactly what will still be attached.
      const kick = sh(
        `${psql} -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}'"`,
        cwd,
      )
      const drop = sh(`${psql} -c 'DROP DATABASE IF EXISTS "${dbName}"'`, cwd)
      return [
        { ...kick, step: 'disconnect' },
        { ...drop, step: 'drop database' },
      ]
    }
    case 'mysql-dump': {
      const mysql = db.mysql ?? 'mysql'
      const q = String.fromCharCode(96)
      return [
        {
          ...sh(`${mysql} -e 'DROP DATABASE IF EXISTS ${q}${dbName}${q}'`, cwd),
          step: 'drop database',
        },
      ]
    }
    case 'compose':
      return [{ ...sh(fill(db.down, { db: dbName }), cwd), step: 'compose down' }]
  }
}

/** Take down everything a recipe may have provisioned before its tree goes. */
export function teardownRecipe(
  recipe: Recipe,
  worktreePath: string,
  dbName: string,
  port: string,
): StepResult[] {
  const results: StepResult[] = []
  const vars = {
    db: dbName,
    path: worktreePath,
    port,
    name: worktreePath.split('/').pop() ?? '',
  }
  if (recipe.stop) {
    const stopped = sh(fill(recipe.stop, vars), worktreePath, {
      WORKTREE_DB: dbName,
      WORKTREE_PORT: port,
    })
    results.push({ ...stopped, step: 'stop' })
  }
  if (recipe.database) results.push(...teardownDb(recipe.database, dbName, worktreePath))
  return results
}

/**
 * Run a recipe against a worktree that already exists.
 *
 * ORDERED, and the order is the design. Install first, because it is the step
 * most likely to rewrite config files; then the database, so the env file can
 * name one that exists; then env, so nothing later overwrites it; then migrate,
 * which needs both; then whatever the project wants last.
 *
 * Stops at the first failure and returns everything it ran. A partially
 * provisioned tree is worse than none — a worker in one runs tests that pass
 * against nothing — so the caller's job on a failure is to tear it down, not to
 * hand it over.
 */
export function runRecipe(
  recipe: Recipe,
  worktreePath: string,
  dbName: string,
  port: string,
): StepResult[] {
  const results: StepResult[] = []
  const vars = { db: dbName, path: worktreePath, port, name: worktreePath.split('/').pop() ?? '' }
  const step = (name: string, cmd: string) => {
    const r = sh(fill(cmd, vars), worktreePath, { WORKTREE_DB: dbName, WORKTREE_PORT: port })
    results.push({ ...r, step: name })
    return r.ok
  }

  if (recipe.install && !step('install', recipe.install)) return results
  if (recipe.database) {
    const db = provisionDb(recipe.database, dbName, worktreePath)
    results.push(...db)
    if (db.some((r) => !r.ok)) return results
  }
  if (recipe.env) {
    try {
      const target = join(worktreePath, recipe.env.path)
      const body = fillPlain(recipe.env.contents, vars)
      // Appended by default, because these files inherit the checkout's and add
      // a managed block. Bun and most loaders are last-wins, so an appended
      // block overrides what it inherits — which is what makes the inheritance
      // safe rather than a source of silent disagreement.
      const prior =
        recipe.env.append !== false && existsSync(target)
          ? `${readFileSync(target, 'utf8').replace(/\n*$/, '')}\n`
          : ''
      writeFileSync(target, `${prior}${body}\n`)
      results.push({ step: 'env', ok: true, detail: recipe.env.path })
    } catch (e) {
      results.push({ step: 'env', ok: false, detail: String(e) })
      return results
    }
  }
  if (recipe.migrate && !step('migrate', recipe.migrate)) return results
  if (recipe.after && !step('after', recipe.after)) return results
  return results
}

/**
 * What the WORKER is told, generated from the recipe.
 *
 * A worker that does not know it can serve its own tree will verify against
 * whatever is already running — a different branch's bundle — and that does not
 * fail, it passes against the wrong tree. A project writing its own `notes` says
 * this in its own words; a project using a recipe should not have to remember
 * to, so the facts bottega knows are stated for it.
 */
export function recipeNotes(recipe: Recipe, dbName: string, port: string): string {
  const lines: string[] = []
  if (recipe.database && recipe.database.kind !== 'none') {
    lines.push(`This worktree has its OWN database: ${dbName}. It is not shared with the main`)
    lines.push('checkout, and it must not be repointed at one — that is the isolation gone.')
  }
  if (recipe.serve) {
    lines.push('')
    lines.push(
      `  ${fill(recipe.serve, { db: dbName, port })}   serve THIS tree${port ? ` (port ${port})` : ''}`,
    )
    if (recipe.stop) lines.push(`  ${fill(recipe.stop, { db: dbName, port })}   stop it`)
    lines.push('')
    lines.push('NEVER verify against a server you did not start for this worktree. Borrowing one')
    lines.push('tests a different branch and PASSES, which is worse than failing.')
  }
  if (recipe.migrate) {
    lines.push('')
    lines.push(
      `Migrations were run when this tree was made (\`${recipe.migrate}\`). Run them again`,
    )
    lines.push('yourself if you add one.')
  }
  return lines.join('\n')
}
