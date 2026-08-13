'use client'

import { serviceItemByKey, isOfferedAvailability, type ServiceValueInput } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { ServiceItemCard } from './ServiceItemCard'

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

/**
 * The per-item card itself now lives in `./ServiceItemCard.tsx`, rendered
 * here and on the fixes screen (`FixesOnly`) from one definition — see that
 * file's header for why a second copy on the fixes screen was not an option.
 * What stays here is this screen's own job, and the one thing the fixes
 * screen must NOT inherit: the `offeredKeys` filter. The fixes screen has to
 * open exactly the flagged item whether or not it is currently offered.
 */
export function ServicesPass2(props: {
  values: Record<string, ServiceValueInput>
  onChange: (itemKey: string, value: ServiceValueInput) => void
  /** The server's refusal message for an item's most recent save, keyed by
   *  the item's own key (already stripped of the queue's `svc:` prefix by
   *  the caller — see `FillForm`'s `serviceErrors`). */
  errors?: Record<string, string>
}): React.JSX.Element {
  const { t } = useLocale()
  const keys = offeredKeys(props.values)

  return (
    <section className="pass2">
      {/* Название шага (`services.pass2Title`) ушло в заголовок-навигатор
          шелла — тот же довод, что у `ServicesPass1`: один heading с этим
          именем, а не два. И раз навигатор позволяет прыгнуть сюда, не
          пройдя первый проход, у пустого списка есть объяснение, а не
          пустой экран (см. `services.pass2Empty`). */}
      {keys.length === 0 && <p className="subtitle">{t('services.pass2Empty')}</p>}
      {keys.map((key) => {
        const item = serviceItemByKey(key)
        if (!item) return null

        return (
          <ServiceItemCard
            key={key}
            item={item}
            value={props.values[key]}
            onChange={(value) => props.onChange(key, value)}
            error={props.errors?.[key]}
          />
        )
      })}
    </section>
  )
}
