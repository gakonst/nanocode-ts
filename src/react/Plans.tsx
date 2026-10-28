'use client'

import { type FormEvent, useCallback, useEffect, useState } from 'react'
import * as Plans from '../client/Plans.ts'
import { usePart } from './Provider.tsx'

export type PlanState = {
  status?: Plans.Status
  pending?: Plans.SignIn
  error?: string
  busy: boolean
  signIn(provider: Plans.Provider): void
  complete(code: string): void
  signOut(provider: Plans.Provider): void
  cancel(): void
  refresh(): void
}

export function usePlans(client: Plans.Client | undefined): PlanState {
  const [status, setStatus] = useState<Plans.Status>()
  const [pending, setPending] = useState<Plans.SignIn>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    (operation: (client: Plans.Client) => Promise<void>) => {
      if (!client) return
      setBusy(true)
      setError(undefined)
      void operation(client)
        .catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure)),
        )
        .finally(() => setBusy(false))
    },
    [client],
  )

  const refresh = useCallback(() => run(async (client) => setStatus(await client.status())), [run])
  useEffect(refresh, [refresh])

  const codex = pending?.provider === 'codex' ? (status?.codex ?? pending.status) : undefined
  useEffect(() => {
    if (!client || codex?.state !== 'pending') return
    const timer = setTimeout(() => {
      void client.status().then(
        (next) => {
          setStatus(next)
          if (next.codex.state !== 'pending') setPending(undefined)
        },
        (failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure)),
      )
    }, codex.poll_after_ms)
    return () => clearTimeout(timer)
  }, [client, codex])

  return {
    ...(status ? { status } : {}),
    ...(pending ? { pending } : {}),
    ...(error ? { error } : {}),
    busy,
    refresh,
    cancel: () => setPending(undefined),
    signIn: (provider) =>
      run(async (client) => {
        const started = await client.signIn(provider)
        setPending(started)
        if (started.provider === 'codex')
          setStatus((current) => current && { ...current, codex: started.status })
      }),
    complete: (code) =>
      run(async (client) => {
        const claude = await client.complete(code.trim())
        setStatus((current) => current && { ...current, claude })
        setPending(undefined)
      }),
    signOut: (provider) =>
      run(async (client) => {
        await client.signOut(provider)
        setStatus(await client.status())
      }),
  }
}

export function PlanConnect(props: PlanConnect.Props) {
  const { plans } = props
  const part = usePart()
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const providers = props.providers ?? (['codex', 'claude'] as const)
  const pending = plans.pending
  const codex = plans.status?.codex

  if (pending?.provider === 'codex' && codex?.state === 'pending') {
    const copy = () =>
      void navigator.clipboard?.writeText(codex.user_code).then(
        () => setCopied(true),
        () => setCopied(false),
      )
    return (
      <div aria-label="Use your ChatGPT plan" role="region" {...part('plan')}>
        <p {...part('planTitle')}>Use your ChatGPT plan</p>
        <p {...part('planText')}>
          Open ChatGPT's device page, sign in and enter this code. Your plan's credential stays
          sealed on this deployment's server, and signing out removes it.
        </p>
        <pre {...part('planCode')}>{codex.user_code}</pre>
        <p {...part('planActions')}>
          <a href={codex.verification_url} rel="noreferrer" target="_blank" {...part('planButton')}>
            open ChatGPT ↗
          </a>
          <button onClick={copy} type="button" {...part('planButton')}>
            {copied ? 'copied' : 'copy'}
          </button>
          <button onClick={plans.cancel} type="button" {...part('planButton')}>
            cancel
          </button>
          <span aria-live="polite" {...part('planStatus')}>
            {plans.error ?? 'waiting for your approval…'}
          </span>
        </p>
      </div>
    )
  }

  if (pending?.provider === 'claude') {
    const submit = (event: FormEvent) => {
      event.preventDefault()
      if (code.trim()) plans.complete(code)
    }
    return (
      <form aria-label="Use your Claude plan" onSubmit={submit} {...part('plan')}>
        <p {...part('planTitle')}>Use your Claude plan</p>
        <p {...part('planText')}>
          Open Claude, approve the sign-in and paste the code it shows here. Your plan's credential
          stays sealed on this deployment's server, and signing out removes it.
        </p>
        <p {...part('planActions')}>
          <a
            href={pending.authorization_url}
            rel="noreferrer"
            target="_blank"
            {...part('planButton')}
          >
            open Claude ↗
          </a>
          <input
            aria-label="Code from Claude"
            autoComplete="off"
            onChange={(event) => setCode(event.target.value)}
            placeholder="paste the code"
            value={code}
            {...part('planInput')}
          />
          <button disabled={plans.busy || !code.trim()} type="submit" {...part('planButton')}>
            connect
          </button>
          <button onClick={plans.cancel} type="button" {...part('planButton')}>
            cancel
          </button>
          {plans.error && (
            <span aria-live="polite" {...part('planStatus')}>
              {plans.error}
            </span>
          )}
        </p>
      </form>
    )
  }

  return (
    <>
      {providers.map((provider) => {
        const connected = plans.status?.[provider].state === 'authenticated'
        return (
          <p key={provider} {...part('row')}>
            <span aria-hidden="true" {...part('chevron')}>
              ❯
            </span>
            {connected ? (
              <button onClick={() => plans.signOut(provider)} type="button" {...part('suggestion')}>
                {Plans.name(provider)} plan connected · sign out
              </button>
            ) : (
              <button
                disabled={plans.busy || !plans.status}
                onClick={() => plans.signIn(provider)}
                type="button"
                {...part('suggestion')}
              >
                {plans.error && !pending ? plans.error : `Use your ${Plans.name(provider)} plan →`}
              </button>
            )}
          </p>
        )
      })}
    </>
  )
}

export declare namespace PlanConnect {
  type Props = {
    plans: PlanState
    providers?: readonly Plans.Provider[]
  }
}
