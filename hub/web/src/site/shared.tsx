import { Link } from '@tanstack/react-router'
import { Button } from '@/ui/button/button'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../../shared/brand.ts'

export const installCommand = `curl -fsSL https://raw.githubusercontent.com/modstudio/${PLATFORM_SLUG}/main/install.sh | sh`

export function Actions({ secondary }: { secondary?: [string, string] }) {
  return (
    <div className="site-actions">
      <Button variant="primary" size="lg" render={<Link to="/docs" />}>
        Install {PLATFORM_NAME}
      </Button>
      {secondary ? (
        <Button variant="secondary" size="lg" render={<Link to={secondary[0]} />}>
          {secondary[1]}
        </Button>
      ) : null}
    </div>
  )
}

export function Section({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow?: string
  title: string
  intro?: string
  children: React.ReactNode
}) {
  return (
    <section className="site-section">
      <div className="site-wrap">
        <div className="site-section-head">
          {eyebrow ? <span className="site-eyebrow">{eyebrow}</span> : null}
          <h2>{title}</h2>
          {intro ? <p>{intro}</p> : null}
        </div>
        {children}
      </div>
    </section>
  )
}

export function Cards({
  items,
  two = false,
}: {
  items: { eyebrow?: string; title: string; text: string; bullets?: string[]; to?: string }[]
  two?: boolean
}) {
  return (
    <div className={`site-grid${two ? ' two' : ''}`}>
      {items.map((item) => {
        const body = (
          <>
            <span className="site-eyebrow">{item.eyebrow}</span>
            <h3>{item.title}</h3>
            <p>{item.text}</p>
            {item.bullets ? (
              <ul>
                {item.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </>
        )
        return item.to ? (
          <Link className="site-card" to={item.to} key={item.title}>
            {body}
          </Link>
        ) : (
          <div className="site-card" key={item.title}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

export function PageHero({
  crumb,
  title,
  muted,
  copy,
  actions,
}: {
  crumb: string
  title: string
  muted: string
  copy: string
  actions?: [string, string][]
}) {
  return (
    <div className="site-wrap site-page-hero">
      <div className="site-eyebrow">
        {PLATFORM_NAME} / {crumb}
      </div>
      <h1>
        {title}
        <br />
        <em>{muted}</em>
      </h1>
      <p>{copy}</p>
      {actions ? (
        <div className="site-actions">
          {actions.map(([to, label], index) => (
            <Button
              key={to}
              variant={index ? 'secondary' : 'primary'}
              size="lg"
              render={<Link to={to} />}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function Cta({ title, copy }: { title: React.ReactNode; copy?: string }) {
  return (
    <div className="site-wrap">
      <div className="site-cta">
        <h2>{title}</h2>
        {copy ? <p>{copy}</p> : null}
        <Actions />
      </div>
    </div>
  )
}
