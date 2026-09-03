'use client'

import {
  serviceItemByKey,
  isOfferedAvailability,
  needsPass2,
  type ServiceValueInput,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { ServiceItemCard } from './ServiceItemCard'

/**
 * Keys of the items pass 2 lists: answered as OFFERED on pass 1, AND with a
 * profile that has something left to ask (`needsPass2`, i.e. not `none`).
 * An offered `none` item — Air Conditioning, Toilets, Halal Options… — is
 * closed by pass 1's yes/no alone and never appears here; the full set of
 * 58 used to, each demanding charge/price/slot/booking/details.
 *
 * Both halves delegate to the schema's own predicates rather than restating
 * them here — that duplicate copy (in agreement with `validation.ts`'s only
 * by accident) is exactly the shape of bug Critical 1 was, per the
 * whole-branch review's second round. `isOfferedAvailability` already treats
 * `''` the same as `null`: `''` is what pass 1 writes as `available` when
 * the operator deliberately clears an answer (second tap on the pressed
 * button, see `availabilityAfterTap`) — a real path, not a hypothetical one.
 * Without this, an item the operator un-selected would reappear here
 * demanding details for a service they just said the lounge doesn't have.
 */
export function pass2Keys(values: Record<string, ServiceValueInput>): string[] {
  return offeredKeys(values).filter((key) => needsPass2(serviceItemByKey(key)!))
}

/**
 * Keys answered as offered on pass 1, profile disregarded — the "anything
 * offered at all?" question that picks between the two empty states below.
 * Kept exported for the unit suite; `pass2Keys` is what the screen lists.
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
 * screen must NOT inherit: the `pass2Keys` filter. The fixes screen has to
 * open exactly the flagged item whether or not it is currently offered, and
 * whatever its profile.
 */
export function ServicesPass2(props: {
  values: Record<string, ServiceValueInput>
  onChange: (itemKey: string, value: ServiceValueInput) => void
  /** The server's refusal message for an item's most recent save, keyed by
   *  the item's own key (already stripped of the queue's `svc:` prefix by
   *  the caller — see `FillForm`'s `serviceErrors`). */
  errors?: Record<string, string>
  /** Ключи позиций, чью последнюю правку внесла команда, — карточка несёт
   *  значок «исправлено командой» (см. `FillForm`'s `teamEdited`). */
  teamEdited?: ReadonlySet<string>
}): React.JSX.Element {
  const { t } = useLocale()
  const keys = pass2Keys(props.values)

  return (
    <section className="pass2">
      {/* Название шага (`services.pass2Title`) ушло в заголовок-навигатор
          шелла — тот же довод, что у `ServicesPass1`: один heading с этим
          именем, а не два. И раз навигатор позволяет прыгнуть сюда, не
          пройдя первый проход, у пустого списка есть объяснение, а не
          пустой экран. Объяснений два, потому что причины две: ничего не
          отмечено как «есть» (`services.pass2Empty` — идите на шаг назад) —
          или отмечено, но всё отмеченное с профилем `none`, и уточнять
          нечего (`services.pass2NothingToDetail` — шаг пройден, идите
          дальше). Смешать их в одну фразу значило бы отправлять назад того,
          кому назад не нужно. */}
      {keys.length === 0 && (
        <p className="subtitle">
          {t(offeredKeys(props.values).length === 0 ? 'services.pass2Empty' : 'services.pass2NothingToDetail')}
        </p>
      )}
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
            teamEdited={props.teamEdited?.has(key) ?? false}
          />
        )
      })}
    </section>
  )
}
