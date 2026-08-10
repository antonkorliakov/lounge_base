'use client'

import type { Field } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { FieldInput } from './FieldInput'

export type Flag = { fieldKey: string; reason: string | null; comment: string }

/**
 * Возврат на правку: заполняющий видит только отмеченные ответы,
 * а не всю анкету заново.
 */
export function FixesOnly(props: {
  flags: Flag[]
  fields: Map<string, Field>
  values: Record<string, unknown>
  onChange: (fieldKey: string, value: unknown) => void
  /** The server's refusal message for a flagged field's most recent save,
   *  keyed by field key (see `FillForm`'s `autosave.rejected`). Without this,
   *  a refusal on this screen only ever showed in the header status banner —
   *  not next to the specific answer that caused it, unlike the main form's
   *  `FieldInput` calls. */
  errors?: Record<string, string>
}): React.JSX.Element {
  const { t } = useLocale()

  return (
    <section className="fixes">
      <h2>{t('fixes.title')}</h2>
      <p className="subtitle">{t('fixes.intro')}</p>

      {props.flags.map((flag) => {
        const field = props.fields.get(flag.fieldKey)
        return (
          <div key={flag.fieldKey} className="fix-card">
            <p className="fix-comment">{flag.comment}</p>
            {field && (
              <FieldInput
                field={field}
                value={props.values[flag.fieldKey]}
                onChange={(value) => props.onChange(flag.fieldKey, value)}
                error={props.errors?.[flag.fieldKey]}
              />
            )}
          </div>
        )
      })}
    </section>
  )
}
