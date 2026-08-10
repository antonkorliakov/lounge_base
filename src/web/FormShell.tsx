'use client'

import { useState, type ReactNode } from 'react'
import { BLOCKS, blockOf } from '@/form-schema'
import { useLocale } from '@/i18n/context'

export type StepKind = 'fields' | 'services1' | 'services2' | 'photos' | 'review'

export type Step = {
  key: string
  kind: StepKind
  blockKey: string | null
}

/**
 * Порядок прохождения формы. Услуги идут двумя проходами: сначала отбор
 * всех 58 позиций одним списком, потом детали только по отмеченным.
 */
export function buildSteps(): Step[] {
  const fieldSteps: Step[] = BLOCKS.filter((b) => b.kind === 'fields').map((b) => ({
    key: `fields:${b.key}`,
    kind: 'fields',
    blockKey: b.key,
  }))

  return [
    ...fieldSteps,
    { key: 'services:pass1', kind: 'services1', blockKey: null },
    { key: 'services:pass2', kind: 'services2', blockKey: null },
    { key: 'photos', kind: 'photos', blockKey: 'photos' },
    { key: 'review', kind: 'review', blockKey: null },
  ]
}

export function FormShell(props: {
  children: (step: Step) => ReactNode
  status: string
}): React.JSX.Element {
  const steps = buildSteps()
  const [index, setIndex] = useState(0)
  const { t, pick, locale, setLocale } = useLocale()
  const step = steps[index]!

  // Fifteen field-block screens in a row before the services matrix is a
  // long tunnel on a phone with only a bare "1 / 19" counter for orientation.
  // A thin progress bar plus the current block's own (localized, schema-
  // sourced) title gives the operator a sense of both "how far" and "what
  // this screen is about" without any extra UI-dictionary strings or a
  // design system — just the block label the schema already carries for
  // 'fields' and 'photos' steps. Services steps already render their own
  // heading (ServicesPass1/2), so they are left without a duplicate here.
  const block = step.blockKey ? blockOf(step.blockKey) : undefined
  const percent = Math.round(((index + 1) / steps.length) * 100)

  return (
    <div className="shell">
      <header className="shell-top">
        <div className="shell-top-row">
          <span className="shell-progress">
            {index + 1} / {steps.length}
          </span>
          <span className="shell-status">{props.status}</span>
          <button
            type="button"
            className="shell-locale"
            onClick={() => setLocale(locale === 'en' ? 'ru' : 'en')}
          >
            {locale === 'en' ? 'RU' : 'EN'}
          </button>
        </div>
        <div className="shell-bar" aria-hidden="true">
          <div className="shell-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        {block && <h1 className="shell-title">{pick(block.label)}</h1>}
      </header>

      <main className="shell-body">{props.children(step)}</main>

      <footer className="shell-foot">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          {/* Pass 2's item list is built from pass 1's answers, so the one
              place "Back" needs a more specific label than the generic
              form.back is the step right after pass 1 — that is exactly
              what services.backToPass1 names. */}
          {step.kind === 'services2' ? t('services.backToPass1') : t('form.back')}
        </button>
        <button
          type="button"
          disabled={index === steps.length - 1}
          onClick={() => setIndex((i) => Math.min(steps.length - 1, i + 1))}
        >
          {t('form.next')}
        </button>
      </footer>
    </div>
  )
}
