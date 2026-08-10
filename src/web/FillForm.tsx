'use client'

import { useEffect, useMemo, useState } from 'react'
import { FIELDS, type Localized, type ServiceValueInput } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { saveFieldAction, saveServiceAction, submitAction } from '@/app/f/[token]/actions'
import { useAutosave } from './useAutosave'
import { FormShell } from './FormShell'
import { FieldInput } from './FieldInput'
import { ServicesPass1 } from './ServicesPass1'
import { ServicesPass2 } from './ServicesPass2'
import { PhotoSlots } from './PhotoSlots'
import { FixesOnly, type Flag } from './FixesOnly'

export function FillForm(props: {
  token: string
  submissionId: string
  /** Статус анкеты на момент открытия ссылки — решает, что показывать: весь
   *  19-шаговый проход или экран правок по отмеченным полям (см. FixesOnly). */
  status: string
  /** Незакрытые отметки рецензента (`resolvedAt IS NULL`), если есть. */
  flags: Flag[]
  initialFields: Record<string, unknown>
  initialServices: Record<string, ServiceValueInput>
  initialPhotos: Record<string, string[]>
}): React.JSX.Element {
  const { t, pick, locale, setLocale } = useLocale()
  const [fields, setFields] = useState(props.initialFields)
  const [services, setServices] = useState(props.initialServices)
  const [photos, setPhotos] = useState(props.initialPhotos)
  const [submitError, setSubmitError] = useState<Localized | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const fieldsByKey = useMemo(() => new Map(FIELDS.map((f) => [f.key, f])), [])

  const autosave = useAutosave({
    submissionId: props.submissionId,
    // `useAutosave` (untouched by this fix) expects `SaveOutcome.error` to be
    // a plain string — it's only ever used internally for `rejected`
    // bookkeeping, never rendered (see its own file). `ActionResult.error` is
    // now the full `Localized` pair, so it's picked down to a string right
    // at this boundary rather than changing `useAutosave`'s shape.
    save: async (key, value) => {
      const result =
        key.startsWith('svc:')
          ? await saveServiceAction(props.token, key.slice(4), value as ServiceValueInput)
          : await saveFieldAction(props.token, key, value)
      return result.ok ? result : { ok: false, error: pick(result.error) }
    },
  })

  const statusText =
    autosave.status === 'offline' ? t('form.savingOffline')
    : autosave.status === 'saved' ? t('form.saved')
    : ''

  // Whatever `useAutosave` found still queued in local storage when it
  // mounted (the tab died, or the page reloaded, before the 600ms debounce
  // sent it) belongs back on screen, not only back on the wire — see
  // `recovered`'s own doc comment in useAutosave.ts. Runs once, right after
  // mount, when `autosave.recovered` first becomes non-empty; a later edit
  // never touches it again (`recovered` itself is never repopulated after
  // mount), so this can never clobber a newer answer with a stale one.
  useEffect(() => {
    const entries = Object.entries(autosave.recovered)
    if (entries.length === 0) return

    const recoveredFields: Record<string, unknown> = {}
    const recoveredServices: Record<string, ServiceValueInput> = {}
    for (const [key, value] of entries) {
      if (key.startsWith('svc:')) {
        recoveredServices[key.slice(4)] = value as ServiceValueInput
      } else {
        recoveredFields[key] = value
      }
    }

    if (Object.keys(recoveredFields).length > 0) {
      setFields((prev) => ({ ...prev, ...recoveredFields }))
    }
    if (Object.keys(recoveredServices).length > 0) {
      setServices((prev) => ({ ...prev, ...recoveredServices }))
    }
  }, [autosave.recovered])

  function changeField(key: string, value: unknown): void {
    setFields((prev) => ({ ...prev, [key]: value }))
    autosave.push(key, value)
  }

  function changeService(key: string, value: ServiceValueInput): void {
    setServices((prev) => ({ ...prev, [key]: value }))
    autosave.push(`svc:${key}`, value)
  }

  async function submit(): Promise<void> {
    const result = await submitAction(props.token)
    if (result.ok) {
      setSubmitError(null)
      setSubmitted(true)
    } else {
      setSubmitError(result.error)
    }
  }

  if (submitted) {
    return (
      <div className="shell">
        <main className="shell-body">
          <p>{t('form.submitted')}</p>
        </main>
      </div>
    )
  }

  // A submission that came back with flagged fields gets a single-screen
  // "fix just these" view instead of the full form again — that is the
  // whole point of FixesOnly. The same `submitAction` that drives the
  // review step below resubmits it: `submitSubmission` already accepts
  // both draft -> submitted and changes_requested -> submitted (see
  // src/submissions/transitions.ts), so a separate "resubmit" action is
  // neither present in the codebase nor needed here.
  if (props.status === 'changes_requested' && props.flags.length > 0) {
    return (
      <div className="shell">
        <header className="shell-top">
          <div className="shell-top-row">
            <span className="shell-status">{statusText}</span>
            <button
              type="button"
              className="shell-locale"
              onClick={() => setLocale(locale === 'en' ? 'ru' : 'en')}
            >
              {locale === 'en' ? 'RU' : 'EN'}
            </button>
          </div>
        </header>
        <main className="shell-body">
          <FixesOnly
            flags={props.flags}
            fields={fieldsByKey}
            values={fields}
            onChange={changeField}
          />
          {submitError && <p className="fix-comment">{pick(submitError)}</p>}
          <button type="button" onClick={submit}>
            {t('form.submit')}
          </button>
        </main>
      </div>
    )
  }

  return (
    <FormShell status={statusText}>
      {(step) => {
        if (step.kind === 'fields') {
          return FIELDS.filter((f) => f.block === step.blockKey).map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={fields[field.key]}
              onChange={(value) => changeField(field.key, value)}
            />
          ))
        }

        if (step.kind === 'services1') {
          return <ServicesPass1 values={services} onChange={changeService} />
        }

        if (step.kind === 'services2') {
          return <ServicesPass2 values={services} onChange={changeService} />
        }

        if (step.kind === 'photos') {
          return (
            <PhotoSlots
              token={props.token}
              uploaded={photos}
              onUploaded={(slot, url) =>
                setPhotos((prev) => ({ ...prev, [slot]: [...(prev[slot] ?? []), url] }))
              }
            />
          )
        }

        return (
          <div className="review">
            {submitError && <p className="fix-comment">{pick(submitError)}</p>}
            <button type="button" onClick={submit}>
              {t('form.submit')}
            </button>
          </div>
        )
      }}
    </FormShell>
  )
}
