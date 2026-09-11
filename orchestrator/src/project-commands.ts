// concern: project-commands
/**
 * Knows project-register command semantics, validation, and presentation. Must
 * not know runs, routing, transports, reviews, the CLI, or worktrees by value.
 */
import { existsSync } from 'node:fs'
import { tryWriteContention, writeTransaction } from './db.ts'
import { selectProjectProfile } from './lenses.ts'
import {
  assertRegisterBranches, projectByName, projects, removeProject, renameProject,
  sniffStack, upsertProject, validateProjectSettings, worktreeWarnings,
  type ProjectSettings,
} from './projects.ts'
import { migrateCreate } from './worktree-template.ts'

type ProjectFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type ProjectPresentation = { log(...values: unknown[]): void; cwd(): string }

export function projectCommand(sub: string, argv: string[], flags: ProjectFlags, presentation: ProjectPresentation): void {
    const { has, flag } = flags

    if (sub === 'list') {
      const all = projects()
      /**
       * PUBLISHED, because hub cannot import this concern and must not open
       * `orch.db`.
       *
       * The boundary check forbids the import and a shared database would make
       * two concerns one, so what another concern needs is emitted here — the
       * same contract `orch state` already serves the dashboard under. A
       * project's identity, stack and settings are exactly the facts hub needs
       * to stop knowing four repository names of its own.
       */
      if (has('json')) {
        presentation.log(JSON.stringify(all.map((project) => ({
          ...project,
          problems: validateProjectSettings(project.settings),
          commit_hooks_skipped: true,
          gate: typeof project.settings.gate === 'string' ? project.settings.gate : null,
        }))))
        return
      }
      if (!all.length) {
        presentation.log(
          'no projects registered.\n\n' +
          '  orch project add <path> [--name X] [--stack Y] [--no-canon] [--json]\n\n' +
          'The stack is what lets routing tell "good at PHP" from "good at Vue";\n' +
          'two projects sharing one stack pool their evidence.',
        )
        return
      }
      for (const p of all) {
        presentation.log(
          `${p.name.padEnd(14)} ${(p.stack ?? '—').padEnd(22)} ` +
          `${p.canon ? 'canon' : '     '}  ${p.path}`,
        )
        const keys = Object.keys(p.settings)
        if (keys.length) presentation.log(`${' '.repeat(14)} settings: ${keys.join(', ')}`)
        for (const problem of validateProjectSettings(p.settings)) {
          presentation.log(`${p.name}: ${problem}`)
        }
        // Reported, not enforced: a half-configured project should say so and
        // keep working. Every one of these is a state that has actually
        // happened rather than one imagined here.
        for (const w of worktreeWarnings(p)) {
          presentation.log(`${' '.repeat(14)} ! ${w}`)
        }
      }
      return
    }

    if (sub === 'add') {
      const path = (argv[2] ?? presentation.cwd()).replace(/\/$/, '')
      if (!existsSync(path)) throw new Error(`no such directory: ${path}`)
      const name = flag('name') ?? path.split('/').filter(Boolean).pop()!
      // Sniffed only as a SUGGESTION, at the one moment a person is looking
      // straight at the project and can correct it. A guess that reruns on
      // every routing decision is a guess nobody ever reviews.
      const stack = flag('stack') ?? sniffStack(path)
      let settings = {} as ProjectSettings
      if (flag('settings')) {
        try { settings = JSON.parse(flag('settings')!) as typeof settings }
        catch (e) { throw new Error(`--settings must be JSON: ${e}`) }
        const malformed = validateProjectSettings(settings)
        if (malformed.length) throw new Error(malformed.join('\n'))
      }
      const candidate = { id: 0, name, path, stack, canon: !has('no-canon'), settings }
      const incomplete = worktreeWarnings(candidate).filter((w) =>
        w.startsWith('has a create command but no branch template') ||
        w.startsWith('has a create command with a {seed} placeholder but no seeds list'))
      if (incomplete.length && !has('allow-incomplete')) throw new Error(incomplete.join('\n'))
      assertRegisterBranches(candidate)
      upsertProject(candidate)
      if (has('json')) {
        presentation.log(JSON.stringify(projectByName(name)))
        return
      }
      presentation.log(`registered ${name}  ${stack ?? '(no stack — orch project set ' + name + ' --stack ...)'}  ${path}`)
      for (const w of worktreeWarnings(projectByName(name)!)) {
        presentation.log(`${' '.repeat(14)} ! ${w}`)
      }
      return
    }

    if (sub === 'set') {
      const name = argv[2]
      if (!name) throw new Error('orch project set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]')
      const p = projectByName(name)
      if (!p) throw new Error(`no project "${name}"`)
      /**
       * Merged DEEPLY, because one level was not enough.
       *
       * A settings blob holds unrelated concerns written at different times —
       * tracker vocabulary, trunk name, colour, the whole worktree lifecycle —
       * and replacing it wholesale to change one drops the others. A shallow
       * merge only moved the problem down a level: updating `worktree.notes`
       * replaced the entire `worktree` object and silently discarded its
       * create, remove, sweep and branch template. Which happened to one project,
       * minutes after the comment above was written promising it would not.
       *
       * Objects merge; JSON null deletes; anything else replaces. An array is
       * a value someone meant to set, not a thing to append to.
       */
      const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
        const out: Record<string, unknown> = { ...a }
        for (const [k, v] of Object.entries(b)) {
          if (v === null) {
            delete out[k]
            continue
          }
          const prev = out[k]
          out[k] = v && typeof v === 'object' && !Array.isArray(v)
                && prev && typeof prev === 'object' && !Array.isArray(prev)
            ? deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>)
            : v
        }
        return out
      }
      let settings = p.settings
      if (flag('settings')) {
        try { settings = deepMerge(settings, JSON.parse(flag('settings')!)) as typeof settings }
        catch (e) { throw new Error(`--settings must be JSON: ${e}`) }
      }
      const nextName = flag('name') ?? name
      const candidate = {
        id: p.id,
        name: nextName,
        path: flag('path') ?? p.path,
        stack: flag('stack') ?? p.stack,
        canon: has('no-canon') ? false : has('canon') ? true : p.canon,
        settings,
      }
      const malformed = validateProjectSettings(candidate.settings).filter((problem) =>
        !(typeof p.settings.worktree?.create === 'string' &&
          candidate.settings.worktree?.create === p.settings.worktree.create &&
          problem === 'worktree.create is a shell string; migrate it (DEV-308)'))
      if (malformed.length) throw new Error(malformed.join('\n'))
      const incomplete = worktreeWarnings(candidate).filter((w) =>
        w.startsWith('has a create command but no branch template') ||
        w.startsWith('has a create command with a {seed} placeholder but no seeds list'))
      if (incomplete.length && !has('allow-incomplete')) throw new Error(incomplete.join('\n'))
      assertRegisterBranches(candidate)
      if (nextName !== name) renameProject(name,nextName)
      const previousTrunk = typeof p.settings.trunk === 'string' ? p.settings.trunk : null
      const nextTrunk = typeof candidate.settings.trunk === 'string' ? candidate.settings.trunk : null
      writeTransaction(() => {
        upsertProject(candidate)
      })
      if (previousTrunk !== nextTrunk) {
        tryWriteContention({
          resourceKind: 'register', resourceKey: nextName, eventKind: 'invalidation',
          cause: `trunk ${previousTrunk ?? '(unset)'} -> ${nextTrunk ?? '(unset)'}`,
        })
      }
      if (has('json')) {
        presentation.log(JSON.stringify(projectByName(nextName)))
        return
      }
      presentation.log(`updated ${nextName}`)
      for (const w of worktreeWarnings(projectByName(nextName)!)) {
        presentation.log(`${' '.repeat(14)} ! ${w}`)
      }
      return
    }

    if (sub === 'select-profile') {
      const name=argv[2],axis=flag('axis'),profile=flag('name'),reason=flag('reason'),versionText=flag('version')
      if(!name||!axis||!profile||!reason?.trim())throw new Error('orch project select-profile <project> --axis A --name N [--lens ID] [--version N] --reason TEXT')
      const version=versionText===undefined?undefined:Number(versionText)
      const result=selectProjectProfile({project:name,axis,name:profile,lensId:flag('lens'),version,reason})
      presentation.log(has('json')?JSON.stringify(result):`selected ${axis}/${profile} for ${name}${flag('lens')?` lens ${flag('lens')}`:' all lenses'}`)
      return
    }

    if (sub === 'migrate-create') {
      const name = argv[2]
      if (!name) throw new Error('orch project migrate-create <name> [--apply]')
      const p = projectByName(name)
      if (!p) throw new Error(`no project "${name}"`)
      const create = p.settings.worktree?.create
      if (create === undefined && p.settings.worktree?.recipe) {
        presentation.log(`${name}: worktree.create is a recipe; nothing to migrate`)
        return
      }
      if (typeof create !== 'string') {
        presentation.log(`${name}: worktree.create is already structured; nothing to migrate`)
        return
      }
      presentation.log(`${name}: before ${JSON.stringify(create)}`)
      const migration = migrateCreate(create)
      if (migration.kind === 'refused') {
        presentation.log(`${name}: ${migration.message}`)
        return
      }
      presentation.log(`${name}: after  ${JSON.stringify(migration.after)}`)
      if (has('apply')) {
        upsertProject({
          ...p,
          settings: {
            ...p.settings,
            worktree: { ...p.settings.worktree!, create: migration.after },
          },
        })
      }
      return
    }

    if (sub === 'remove') {
      const name = argv[2]
      if (!name) throw new Error('orch project remove <name>')
      // The RUNS stay. They are evidence about agents, and that evidence did
      // not stop being true because the project was deregistered.
      presentation.log(removeProject(name) ? `removed ${name}` : `no project "${name}"`)
      return
    }

    throw new Error(`unknown: orch project ${sub}. Try list | add | set | remove`)
}
