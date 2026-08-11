'use client'

import {
  OPTION_LISTS,
  serviceItemByKey,
  isOfferedAvailability,
  requiresPrice,
  type ServiceValueInput,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'

/**
 * Детали спрашиваются только там, где на первом проходе ответили «есть».
 *
 * Delegates to `isOfferedAvailability`, the schema's own predicate, rather
 * than restating "'no'/'not_allowed' close the item" here — that duplicate
 * copy (in agreement with `validation.ts`'s only by accident) is exactly
 * the shape of bug Critical 1 was, per the whole-branch review's second
 * round. `isOfferedAvailability` already treats `''` the same as `null`:
 * `''` is what `ServicesPass1`'s `<select>` writes as `available` when the
 * operator deliberately reverts a choice back to the placeholder
 * `<option value="">—</option>` — a real path, not a hypothetical one.
 * Without this, an item the operator un-selected would reappear here
 * demanding charge/price/slot/booking/details for a service they just said
 * the lounge doesn't have.
 */
export function offeredKeys(values: Record<string, ServiceValueInput>): string[] {
  return Object.entries(values)
    .filter(([key, v]) => {
      const item = serviceItemByKey(key)
      return item != null && isOfferedAvailability(item, v.available)
    })
    .map(([key]) => key)
}

export function ServicesPass2(props: {
  values: Record<string, ServiceValueInput>
  onChange: (itemKey: string, value: ServiceValueInput) => void
  /** The server's refusal message for an item's most recent save, keyed by
   *  the item's own key (already stripped of the queue's `svc:` prefix by
   *  the caller — see `FillForm`'s `serviceErrors`). */
  errors?: Record<string, string>
}): React.JSX.Element {
  const { pick, t } = useLocale()
  const keys = offeredKeys(props.values)

  return (
    <section className="pass2">
      <h2>{t('services.pass2Title')}</h2>
      {keys.map((key) => {
        const item = serviceItemByKey(key)
        const value = props.values[key]
        if (!item || !value) return null
        const needsPrice = requiresPrice(value.chargeType)

        return (
          <div key={key} className="pass2-card">
            <h3>{pick(item.label)}</h3>
            {item.hint && <p className="field-hint">{pick(item.hint)}</p>}

            <label>{t('services.charge')}</label>
            <select
              value={value.chargeType ?? ''}
              onChange={(e) =>
                props.onChange(key, {
                  ...value,
                  chargeType: e.target.value === '' ? null : e.target.value,
                })
              }
            >
              <option value="">—</option>
              {OPTION_LISTS.chargeType.map((option) => (
                <option key={option.id} value={option.id}>{pick(option.label)}</option>
              ))}
            </select>

            {needsPrice && (
              <>
                <label>{t('services.price')}</label>
                <input
                  type="number" min={0}
                  value={value.price ?? ''}
                  onChange={(e) =>
                    props.onChange(key, {
                      ...value, price: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
                <label>{t('services.currency')}</label>
                <input
                  value={value.currency ?? ''}
                  onChange={(e) => props.onChange(key, { ...value, currency: e.target.value })}
                />
              </>
            )}

            <label>{t('services.slot')}</label>
            <input
              type="number" min={0}
              value={value.slotMinutes ?? ''}
              onChange={(e) =>
                props.onChange(key, {
                  ...value, slotMinutes: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />

            <label className="field-check">
              <input
                type="checkbox"
                checked={value.bookingRequired ?? false}
                onChange={(e) => props.onChange(key, { ...value, bookingRequired: e.target.checked })}
              />
              {t('services.booking')}
            </label>

            <label>{t('services.details')}</label>
            <textarea
              value={value.details ?? ''}
              onChange={(e) => props.onChange(key, { ...value, details: e.target.value })}
            />

            {props.errors?.[key] && <p className="fix-comment">{props.errors[key]}</p>}
          </div>
        )
      })}
    </section>
  )
}
