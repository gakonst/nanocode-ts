import type { ReactNode } from 'react'
import { Code } from './index.tsx'
import * as styles from './site.styles.ts'

export { styles }

export const origin = 'https://nanocode.xyz'

export type Link = { href: string; label: string }

export const sections: readonly Link[] = [
  { href: `${origin}/`, label: 'Home' },
  { href: `${origin}/experiments`, label: 'Experiments' },
  { href: `${origin}/docs/introduction/getting-started`, label: 'Docs' },
  { href: `${origin}/playground`, label: 'Playground' },
  { href: `${origin}/prompts`, label: 'Prompts' },
  { href: 'https://github.com/gakonst/nanocode', label: 'GitHub' },
]

export const experiments: readonly Link[] = [
  { href: `${origin}/docs/guides/xframes`, label: 'xframes' },
  { href: `${origin}/machines/`, label: 'nanocode-machines' },
  { href: `${origin}/docs/guides/nanocode-ts`, label: 'nanocode-ts' },
  { href: `${origin}/vercel`, label: 'nanocode on Vercel' },
  { href: `${origin}/cloudflare/`, label: 'nanocode on Cloudflare' },
]

export type Demo = 'cloudflare' | 'machines' | 'vercel'

export const demos: readonly (Link & { id: Demo; logo: string; viewBox: string })[] = [
  {
    href: `${origin}/cloudflare/`,
    id: 'cloudflare',
    label: 'Cloudflare',
    logo: 'M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727',
    viewBox: '0 3 24 18',
  },
  {
    href: `${origin}/machines/`,
    id: 'machines',
    label: 'Tempo',
    logo: 'M6.71995 19.786H1.38045L6.32925 4.48482H0L1.38045 0H19.0138L17.6333 4.48482H11.6427L6.71995 19.786Z',
    viewBox: '-2.13 -1.75 23.28 23.28',
  },
  {
    href: `${origin}/vercel`,
    id: 'vercel',
    label: 'Vercel',
    logo: 'm12 1.608 12 20.784H0Z',
    viewBox: '0 0 24 24',
  },
]

export function Header(props: { current?: string; experiment?: string }) {
  return (
    <header {...styles.header()}>
      <nav aria-label="Site" {...styles.navigation()}>
        {sections.map((section, index) => {
          const label = `${String(index + 1).padStart(2, '0')} ${section.label}`
          const current =
            (props.current ?? (props.experiment ? 'Experiments' : undefined)) === section.label
          if (section.label !== 'Experiments')
            return (
              <a
                aria-current={current ? 'page' : undefined}
                href={section.href}
                key={section.href}
                {...styles.link({ current })}
              >
                {label}
              </a>
            )
          return (
            <div key={section.href} {...styles.menu()}>
              <a
                aria-current={current ? 'page' : undefined}
                href={section.href}
                {...styles.link({ current })}
              >
                {label}
              </a>
              <div {...styles.menuList()}>
                {experiments.map((experiment) => (
                  <a
                    aria-current={experiment.href === props.experiment ? 'page' : undefined}
                    href={experiment.href}
                    key={experiment.href}
                    {...styles.link({ current: experiment.href === props.experiment })}
                  >
                    {experiment.label}
                  </a>
                ))}
              </div>
            </div>
          )
        })}
      </nav>
    </header>
  )
}

export function Demos(props: { current: Demo }) {
  return (
    <p {...styles.demos()}>
      nanocode on
      <span {...styles.toggle()}>
        {demos.map((demo) => (
          <a
            aria-current={demo.id === props.current ? 'page' : undefined}
            aria-label={`nanocode on ${demo.label}`}
            href={demo.href}
            key={demo.href}
            {...styles.demo({ current: demo.id === props.current })}
          >
            <svg aria-hidden="true" viewBox={demo.viewBox} {...styles.logo()}>
              <path d={demo.logo} />
            </svg>
            {demo.label}
          </a>
        ))}
      </span>
    </p>
  )
}

export function Main(props: { children: ReactNode }) {
  return <main {...styles.main()}>{props.children}</main>
}

export function Page(props: { children: ReactNode }) {
  return <div {...styles.page()}>{props.children}</div>
}

export function Title(props: { children: ReactNode; subtitle?: ReactNode }) {
  return (
    <h1>
      {props.children}
      <span {...styles.dot()}>.</span>
      {props.subtitle && (
        <>
          <br />
          {props.subtitle}
        </>
      )}
    </h1>
  )
}

export function Lead(props: { children: ReactNode }) {
  return <p {...styles.lead()}>{props.children}</p>
}

export function Docs(props: { children: ReactNode }) {
  return <article {...styles.docs()}>{props.children}</article>
}

export function Block(props: { code: string; label?: string; language: string }) {
  return (
    <div {...styles.block()}>
      {props.label && (
        <div {...styles.blockHeader()}>
          <span {...styles.blockLabel()}>{props.label}</span>
        </div>
      )}
      <Code code={props.code} language={props.language} />
    </div>
  )
}

export function Diagram(props: { children: string }) {
  return (
    <div {...styles.block()}>
      <div {...styles.diagram()}>
        <pre>{props.children}</pre>
      </div>
    </div>
  )
}

export function Cards(props: { children: ReactNode }) {
  return <div {...styles.cards()}>{props.children}</div>
}

export function Card(props: { href: string; title: string; children: ReactNode }) {
  return (
    <a href={props.href} {...styles.card()}>
      <span {...styles.cardTitle()}>{props.title}</span>
      <span>{props.children}</span>
    </a>
  )
}
