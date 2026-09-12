// concern: cli
/** Retains the legacy whole-program help fallback until the final Commander slice. */
import { REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP, REVIEW_REPRODUCED, REVIEW_SEVERITY } from './review-vocabulary.ts'

const argv = process.argv.slice(2)

const { registerStandardRuntime } = await import('./runtime-registration.ts')
registerStandardRuntime()
const { program, run } = await import('./program.ts')
if (program.commands.some((command) => command.name() === argv[0] || command.aliases().includes(argv[0]!))) {
  process.exit(await run(argv))
}

function baseHelp(description: string): string {
  return description
}

function usage(): never {
  console.log(`orch — delegate work to external agents and score them per job type

  orch do <job> [prompt]        run a job; prompt from argv, --file, or stdin
      --detach                  print a run id and return at once (the default); collect with
                                'orch wait' and 'orch result'. This is how a
                                fan-out is done: N detaches, one wait.
      --porcelain               print exactly the run id, for machine callers
      --agent <name>            force an agent instead of routing
      --transport cli|acp       driver seam; default cli. acp covers codex/grok read-only jobs
      --avoid <agent>[,...]     route to any other agent when possible
      --distinct-from <id>[,...] avoid models used by earlier fan-out runs
      --base <ref>              ${baseHelp('base an implement or fix worktree on this git commit')}
      --review <branch|run-id>  review that branch tip explicitly (review-lens, safety, craft)
      --carry                   carry this checkout's uncommitted work into the worker (off by default)
      --file <path>             read the prompt from a file
      --schema <path>           bind JSON schema (Codex normalizes it to OpenAI strict mode)
      --mcp                     require a successful pre-launch MCP tool call
      --mcp=prefer              record MCP call evidence; continue if unavailable or unverified
      --model <name>            override the agent's model
      --label <text>            name this run in listings and pending reminders
      --lens <stable-id>        required identity for findings-producing review jobs
      --quiet                   print only the reply
      --probe                   a calibration run: recorded, but not routing evidence
      --seed <spec>             choose a required project-specific database seed spec (writing jobs only)
      --seed=<spec>             same; quote a multi-token spec as one value in either form
      --key <KEY-123>           attribute a read-only run, or supply a writing run's required branch key
      --repo <name>             attribute work launched outside a registered project
      --cwd <path>              resolve and carry from this path as if orch started there
      --follow                  block and watch the run instead of returning its id
      --no-failover             do not retry vendor failures on another agent
      --no-wait-capacity        take the next eligible agent when the preferred row is at its concurrency cap
      --deliverable <text>      declare a named reader deliverable (repeatable; diagnose, understand, file-question)
      --timeout <minutes>       override the job's default timeout, within that job's ceiling
      --keep-tree               keep a lens or reader worktree instead of reclaiming it at terminalisation

  orch issue <TASK-KEY>         reproduce, diagnose, fix and independently verify one filed issue

  orch contract <job>          print the preamble prepended to that job's prompt
  orch note "<text>" [--same-as ID|--new]
                                file a cwd-bound suggestion through hub

  orch score <run-id> <none|partial|full> [wrong|mixed|right] [--note "..."|--note-file PATH]
      delivery first (did an answer arrive), then quality (was it right).
      'none' takes no quality — there was nothing to judge.
      findings-producing lenses with an answer also require:
      --reproduced <${REVIEW_REPRODUCED.join('|')}> --coverage <${REVIEW_COVERAGE.join('|')}>
      --limits <${REVIEW_LIMITS.join('|')}> --overlap <${REVIEW_OVERLAP.join('|')}>
      only the session that MADE a run may score it; --force overrides.
      --better-than <id>[,<id>] record this run winning a pairwise comparison
      --worse-than <id>[,<id>]  record the named run winning the comparison
      --same-as <id>[,<id>]     mark a tie without recording a duel
      --scorer <who>            record the named human/UI scorer; only the local
                                hub-dashboard capability bypasses ownership
      --void                    retain the run and output, but exclude it from routing evidence
  orch judge <run-id> <none|partial|full> [wrong|mixed|right] [drifted|partial|faithful]
      closes scoring, findings triage/review completion, and any comparable pair in one call
      --finding N=<accepted|modified|skipped>:<severity>
      --finding N=rejected:<category>
      --discard                 reclaim the terminal run's worktree after close-out
  orch recalibrate [--n 12]    re-score old outputs blind and measure agreement
      --scorer <who>            use the same scorer identity as orch score
      --force                   sample any scorer's old scores
  orch routing-backtest [--job X] [--json]
                                replay current routing and Thompson sampling over judgements
  orch wait <run-id>...         block until those runs finish (--timeout SECONDS, default 1800)
  orch result <run-id>          print a finished run's output; exit 2 if still running
      --artifacts               list files kept under runs/<id>/artifacts/
  orch retry <run-id>           re-send a run's exact prompt [--agent NAME] [--model MODEL]
      --agent <name>            ... or to a different one, deliberately
  orch review tier <branch|run-id|from..to> classify review breadth without writing
  orch review yield [--project P] [--since ISO] [--task KEY|--key KEY] [--lens L] [--agent A] [--json]
                                findings and cost by lens, round ordinal, agent and model
  orch review record <run-id>... record completed lens outputs before triage
  orch review triage <review-id> <finding> <accepted|modified|rejected|skipped>
      --category <name>         required rejection category for rejected findings
      --severity <${REVIEW_SEVERITY.join('|')}> architect-assessed severity, including explicit agreement
  orch review complete <review-id> mark a fully triaged review complete
  orch review calibration <lens> <agent> <model> [--json]  (--json: one JSON document)
  orch review coverage-audit [--json]  list completed reviews that inspected trunk history (--json: one JSON document)
  orch pending                  runs YOU made that are still unscored (exit 1 if any)
  orch runs [--id ID]... [--job X] [--agent Y] [--limit N] [--unscored] [--since ISO] [--json|--json=v1]
      --json                    NDJSON, one envelope per line
      --json=v1                 transition format: NDJSON bare run objects
                         --id resolves a turn to its chain root and identifies the requested id
      --id queries exactly those run ids; repeat it for a union of ids
      --id and --since cannot be combined
      --json                    print one JSON object per line, with cwd, session id and questions: the interface hub reads
  orch stats [--job X]          success rate per agent per job
  orch guide [--job X] [--prompt-bytes N] [--lens LENS]
                                what to use for what, separated by prompt-size bucket
  orch spawns [--limit N]       what the subagent gate allowed and denied, and why
  orch pick <job>               show which agent would be chosen, and why
      --agent <name>            preview an explicit agent pin
      --avoid <agent>[,...]     preview routing away from these agents
      --distinct-from <id>[,...] preview routing away from models used by these runs
  orch state [--days N]         the dashboard payload as JSON (what hub renders)
      the dashboard itself is 'hub serve' - this concern routes and scores
  orch run <run-id> [--receipt] one exact turn's detail as JSON, with its chain root;
                                --receipt marks worker messages read
  orch search <query>           consult score notes, rulings, review findings, and saved outputs
      --limit <n>               compact results to return (default 20)
      --full                    include the complete matched records after choosing them
      --json                    print one JSON document, including unavailable output count
  orch metric [collect]         Claude tokens per shipped task (the ratio this exists to move)
  orch blockers [--days N] [--json]
      what stopped agents verifying their work, ordered by recurrence
      --json                    print one JSON document (the published surface; never orch.db)
  orch monitor [--backstop]     detect, record, report, and safely reconcile machine state
      --history [--limit N]     query recorded invocations; --json emits one JSON document
      --notices                 read this session's addressed conditions without consuming them
      --ack-notices IDS         mark emitted notice ids delivered (hook capability required)
      --json                    emit one JSON document; silent on a clean live pass
  orch reclaim worktree <path> [--dry-run]
      remove an orch worktree only after recipe/base, clean-state, reachability, and liveness proofs
  orch reclaim branch <project>:<branch> [--dry-run]
      remove a local branch only when every commit is reachable or its exact kept tip is recorded
  orch inbox [--all] [--json]   design questions a worker is waiting on you to rule on
      --json                    print one JSON document
  orch peek <run-id> [--events N] [--json]
                                observe a worker's event stream without interrupting it
  orch tell <id> ["<message>"]   queue non-authoritative context for a running worker
      --file <path>             read a long message from a file
      --ping                    also print the peek summary as of queue time
  orch setup-ask                register the live ask channel with codex and grok
  orch answer <id> ["<ruling>"] rule from argv, --file, or stdin; resume detached
      --file <path>             read the ruling from a file
      --q<id> --file <path>     read that question's ruling from a file
      --record-only             attach the ruling without resuming the worker
      --follow                  watch the resumed turn here instead
  orch continue <id> ["<what next>"]
      carry on a chain with no open question - one that was interrupted, or
      one you want to add to without paying for its context again
      --file <path>             read the follow-up from a file
      detaches by default; --follow watches the resumed turn here
      several questions: orch answer <id> --q<qid> "<ruling>" --q<qid> "<ruling>"
  orch diff <id>                inspect a run's worktree diff (review diffs are scratch)
      --since-base              compare with the recorded base instead of current trunk
  orch reconcile <id>           write a terminal run row from the persisted reply after a schema move
  orch confinement clear <run-id> --writer TEXT --note TEXT [--tip OID]
      clear a spurious escaped classification, attributing the outside edit and auditing the ruling
  orch review list [--open|--complete] [--project P] [--since ISO] [--json]
  orch review show <id> [--json]
  orch review calibration [<lens> <agent> <model>] [--json]
  orch review pins [--prune]    list reviewed-commit keepalive refs; explicitly prune landed reviews
  orch stop <id>                terminate a running run, reclaim its containers, and keep its worktree
  orch discard <id>             delete that run's worktree (the row stays)
      --force                   also delete a protected branch; bypass a refusing project tool
                                only for a tree marked as created by orch
  orch close-out <id>           release a terminal run's clean worktree and resources; keep its branch
      --non-blocking            return immediately when a cleanup lock is contested
  orch abandon <id> [--note "..."] [--force] retire an asking run and clean up its worktree
  orch sweep [--project <name>] [--force] [--dry-run]
      backstop close-out for terminal trees; clean trees are released and branches kept.
      more than ten kept rows are summarised by reason; --dry-run lists every row
  orch reclassify-failures [--dry-run]
      reclassify stored unclassified vendor quota/auth failures from their error text;
      prints every matched row and before/after counts before writing
  orch health [--days N] [--json] failure classes by count, time, last seen, false-verdict rate and the flake table
  orch epic <TASK-KEY> [--json] one computed scoreboard for an epic and its child tasks
  orch doctor                   agents, local endpoint, routing at a glance
  orch agent add <name> --harness H --backend B [--model M] [--base-url U] [--context-tokens N]
  orch agent set <name> [the add flags] [--jobs JOB,...|any] [--prefer JOB,...] [--max-concurrent N] [--enabled true|false] [--reason TEXT]
  orch agent remove <name>      delete only an agent with no run evidence
  orch agent probe <name>       run reply, file-tool, and structured-output registration probes
  orch agent list [--json]      registered harness + backend + model rows and probe eligibility
  orch project [list] [--json]  the register: where work lives, and what it is built from
      --json                    print one JSON document (the published surface; never orch.db)
      add <path> [--name X] [--stack Y] [--no-canon] [--json]  (--json: one JSON document)
      set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]  (--json: one JSON document)
          JSON null deletes that settings key; objects merge deeply
          worktree.readonly_create may provision detached read-only trees at {path} and {base}
          worktree.readonly_notes says what a detached read-only tree can and cannot run
          secretPaths lists sandbox-denied paths; absolute, ~-prefixed, or relative to the main checkout
          worktree.readonly_remove optionally tears them down and receives {path} only
          --allow-incomplete    save a create command missing branch or seed configuration
      remove <name>
  orch init-db                  create the database for a fresh main checkout
  orch migrate [--backfill-spec-sha]
                                apply schema, stamp user_version, re-run backfills including spec_sha
  orch doc list [--scope S] [--subject X] [--json]  (--json: one JSON document)
      show <slug> --scope S [--subject X] [--json]  (--json: one JSON document)
      set <slug> --scope S [--subject X] --title T --reason TEXT [--author NAME] [--delivery inject|demand] (--file F | body on stdin) [--json]  (--json: one JSON document)
      consume <slug> --scope S [--subject X] [--reason TEXT] [--author NAME] [--json]  (--json: one JSON document)
      rm <slug> --scope S [--subject X] --reason TEXT [--author NAME] [--json]  (--json: one JSON document)
      history <scope> <subject|-> <slug> [--json]
      diff <scope> <subject|-> <slug> [<rev-a> [<rev-b>]]
      restore <scope> <subject|-> <slug> <rev> --reason TEXT [--author NAME]
      subjects [--json]  (--json: one JSON document)
      export <dir> | import <dir> --reason TEXT [--author NAME] | brief [--cwd P] | resumes [--cwd P] [--json]
  orch workflow list [--json]  (--json: one JSON document)
      show <slug> [--version N] [--json]  (--json: one JSON document)
      set <slug> --file F --reason TEXT [--author NAME]
      promote <slug> <n> --reason TEXT [--author NAME]
      retire <slug> <n> --reason TEXT [--author NAME]
      fork <slug> [--from N] --reason TEXT [--author NAME]
      versions <slug> [--json]  (--json: one JSON document)
      compose <slug> [--mode M] [--arg k=v]... [--json]  (--json: one JSON document)
      step <slug> <step-slug> [--arg k=v]... [--json]  (--json: one JSON document)
      export <dir> | import <dir> --reason TEXT [--author NAME]
  orch canon check [--cwd P] [--job J] [--all] [--json]
  orch canon diff [--cwd P] [--job J] [--json]
  orch canon eval [--slug S] [--agent A] [--json] [--force]
      --force                   re-run even when canon is unchanged since last pass
  orch canon evals [--json]  (--json: one JSON document)
  orch port baseline show <source> <target> [--json]  (--json: one JSON document)
      baseline set <source> <target> <commit> [--clear] [--json]  (--json: one JSON document)
      skip list <source> <target> [--json]  (--json: one JSON document)
      skip add <source> <target> <candidate> --reason TEXT [--json]  (--json: one JSON document)
      ref list [--all] [--json]  (--json: one JSON document)
      ref show <task-key> [--json]  (--json: one JSON document)
      ref set <task-key> --sources JSON --note TEXT [--json]  (--json: one JSON document)
          sources: [{"project":"name","commits":[...],"paths":[...],"note":"..."}]
      ref resolve <task-key> [--json]  (--json: one JSON document)
      ref delete-error <task-key> [--json]  (--json: one JSON document; correction only)
      doctrine list [--all] [--json]  (--json: one JSON document)
      doctrine add <number> --title T (--file F | body on stdin) [--json]  (--json: one JSON document)
      doctrine retire <number> [--json]  (--json: one JSON document)
  orch mcp [--config]          serve project, doc, and port tools over stdio
  orch jobs [--json]            list job types
  orch agents [--json]          list agents and availability
`)
  process.exit(argv.length ? 1 : 0)
}

switch (argv[0]) {
  default: usage()
}
