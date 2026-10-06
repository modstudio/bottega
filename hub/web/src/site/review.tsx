import { Cards, Cta, PageHero, Section } from './shared'

export function ReviewPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Review"
        title="Review that knows"
        muted="when to stop."
        copy="Independent lenses, each answering one named question, on a round budget the change itself decides. Agent review usually fails in one of two ways: one pass that misses things, or an endless ladder of findings nobody triages. The tier fixes both ends before the first lens runs."
        actions={[
          ['/docs', 'How findings are judged'],
          ['/product/workflows', 'See it as a workflow step'],
        ]}
      />
      <Section
        eyebrow="The tier"
        title="The change decides how much review it gets"
        intro="Not your mood, and not the agent's enthusiasm. The tier is computed from the diff before the first lens runs, and it fixes both the number of lenses and a hard ceiling on rounds."
      >
        <Cards
          items={[
            {
              eyebrow: 'Risk',
              title: 'Where the change landed',
              text: 'Paths carry a risk level. Schema and migrations, landing safety, worktree lifecycle, run execution, repository hooks and cross-concern shared code sit at the top.',
            },
            {
              eyebrow: 'Size',
              title: 'How much of it there is',
              text: 'Product lines changed, with a bump when the change is spread across many product files — breadth is its own kind of risk.',
            },
            { eyebrow: 'Tier 0', title: 'No lenses', text: 'Docs, tests and config only.' },
            {
              eyebrow: 'Tier 1',
              title: 'One lens, one round',
              text: 'A surface change with little blast radius.',
            },
            { eyebrow: 'Tier 2', title: 'Two rounds', text: 'Ordinary product source.' },
            {
              eyebrow: 'Tier 3',
              title: 'Three rounds',
              text: 'The paths where a mistake is expensive and quiet.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Multi-lens"
        title="One question each, asked independently"
        intro="A lens is a named viewpoint with a stable identity, one question and explicit exclusions."
      >
        <Cards
          items={[
            {
              title: 'The same lens over time',
              text: 'A lens keeps its id across runs, so its findings accumulate into a record.',
            },
            {
              title: 'No shared anchor',
              text: "Lenses do not see each other's findings. Agreement means they arrived separately.",
            },
            {
              title: 'What it will not say',
              text: 'Each lens names what is out of scope, so the same nit does not arrive from five directions.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Multi-round"
        title="A ladder that ends"
        intro="The first review is the only full one. After a fix round you read the fix and land it. Re-lensing happens only at the top tier, only when the fix touched a top-tier path, and only with the lenses whose dimension the fix actually touched."
      >
        <Cards
          items={[
            {
              title: 'Fix real findings',
              text: 'Real findings are fixed in the round that raised them.',
            },
            {
              title: 'Drop speculation',
              text: 'Speculation is dropped in triage, not carried into a fix.',
            },
            {
              title: 'Stop',
              text: 'A clean round ends the ladder immediately. At the ceiling it stops and asks you.',
            },
          ]}
        />
      </Section>
      <Section eyebrow="It measures itself" title="Lenses earn their place, or lose it">
        <Cards
          items={[
            {
              eyebrow: 'Yield',
              title: 'What a lens actually finds',
              text: 'How many findings survive triage, over time.',
            },
            {
              eyebrow: 'Calibration',
              title: 'How much to trust a reviewer',
              text: "An agent's accepted-versus-rejected record on a lens travels with it into routing.",
            },
            {
              eyebrow: 'Coverage',
              title: 'Whether the diff was looked at',
              text: 'An audit of what the lenses actually reached.',
            },
          ]}
        />
      </Section>
      <Cta
        title={
          <>
            Enough review.
            <br />
            Then stop.
          </>
        }
      />
    </main>
  )
}
