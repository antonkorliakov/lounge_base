'use client'

import {
  OPTION_LISTS,
  isOfferedAvailability,
  requiresPrice,
  type ServiceItem,
  type ServiceValueInput,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'

/**
 * The two controls that ask about ONE service item, extracted so that the
 * main form and the fixes screen render the same ones rather than two
 * copies that agree by accident.
 *
 * Before this file existed, the whole per-item attribute set lived inline in
 * `ServicesPass2` and the availability control inline in `ServicesPass1`, and
 * the fixes screen (`FixesOnly`) had NEITHER — a reviewer could flag any of
 * the 58 service items and the filler got the comment with no control to fix
 * it (see the Critical entry at the end of P2 Task 7 in
 * `.superpowers/sdd/2026-08-06-review/progress.md`). The obvious repair —
 * writing the attribute set a second time on the fixes screen — is the exact
 * defect class this branch has already hit twice (Critical 1's duplicated
 * `needsDetail` rule, `DETAIL_REQUIRED_BY_OPTION` private to `validation.ts`),
 * so both controls moved here and all three screens now render them.
 *
 * `requiresPrice` and `isOfferedAvailability` stay delegated to the schema,
 * for the same reason `offeredKeys` delegates rather than restating "'no'/
 * 'not_allowed' close the item".
 */

/**
 * Every attribute a service answer carries besides `available` — the value
 * shape both passes emit for an item nobody has answered yet. This is the
 * one definition; `ServicesPass1` used to hold its own private `EMPTY` and
 * `src/web/__tests__/fieldContract.test.ts` a hand-copied mirror of it, with
 * a comment asking the reader to keep the two in step.
 */
export const EMPTY_SERVICE_ATTRS: Omit<ServiceValueInput, 'available'> = {
  chargeType: null,
  price: null,
  currency: null,
  slotMinutes: null,
  bookingRequired: null,
  details: null,
}

/**
 * A complete `ServiceValueInput` for an item that may never have been
 * answered at all. `undefined` is a real case on the fixes screen: the
 * reviewer's most common reason code is `empty`, so the flagged item is
 * precisely the one with no row in `service_values` and therefore no entry
 * in `loadSubmissionValues`' `services` map. `ServicesPass2` never sees
 * `undefined` (its `offeredKeys` filter derives the key list FROM the map),
 * which is why its old `if (!value) return null` was unreachable there — and
 * why copying that early return onto the fixes screen would have rendered
 * nothing for exactly the items most likely to be flagged.
 */
export function serviceValueOrEmpty(
  current: ServiceValueInput | undefined,
): ServiceValueInput {
  return { ...EMPTY_SERVICE_ATTRS, ...current, available: current?.available ?? null }
}

/**
 * Whether the item's availability question renders as a checkbox (plain
 * yes/no) rather than as its own dropdown. One definition, because two call
 * sites need it — the control itself and the label that goes with it — and
 * two copies of `availabilityList === 'yesNo'` is precisely the shape of
 * duplication this file exists to remove.
 */
export function isBinaryAvailability(item: ServiceItem): boolean {
  return item.availabilityList === 'yesNo'
}

/**
 * Pass 1's question — "does the lounge have this?" — as a standalone control:
 * a checkbox for the ordinary yes/no item, the item's own option list as a
 * `<select>` for the few that have one (e.g. `8.3` Vaping policy).
 *
 * Emits a whole `ServiceValueInput`, merged over `EMPTY_SERVICE_ATTRS`, so a
 * first answer carries every attribute the server expects and a later one
 * never drops an attribute Pass 2 already filled in — the same merge Pass 1
 * did inline before, now in one place shared with the fixes screen.
 */
export function ServiceAvailabilityInput(props: {
  item: ServiceItem
  value: ServiceValueInput | undefined
  onChange: (value: ServiceValueInput) => void
}): React.JSX.Element {
  const { pick } = useLocale()
  const { item, value } = props
  const options = OPTION_LISTS[item.availabilityList]

  const emit = (available: string): void =>
    props.onChange({ ...serviceValueOrEmpty(value), available })

  return isBinaryAvailability(item) ? (
    <input
      type="checkbox"
      checked={value?.available === 'yes'}
      onChange={(e) => emit(e.target.checked ? 'yes' : 'no')}
    />
  ) : (
    <select value={value?.available ?? ''} onChange={(e) => emit(e.target.value)}>
      <option value="">—</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {pick(option.label)}
        </option>
      ))}
    </select>
  )
}

/**
 * One service item's full detail set: charge type, price/currency when the
 * charge type needs them, slot minutes, booking, free-text details.
 *
 * `withAvailability` is what differs between the two screens that render
 * this card, and it is a difference in what the screen can REACH, not a
 * styling choice:
 *  - `ServicesPass2` renders it `false`. Availability is Pass 1's question,
 *    one screen back and reachable by the Back button, and Pass 2 only ever
 *    lists items already answered as offered.
 *  - `FixesOnly` renders it `true`. The fixes screen is the ONLY screen the
 *    filler gets while a flag is open (`FillForm` returns it instead of the
 *    19-step form), so if availability were omitted there, a flag on the
 *    availability answer itself — "you ticked Shower but there is no shower"
 *    — would be unfixable, the same dead end one level down. `flags.ts` is
 *    explicit that a flag addresses the whole item and that a complaint
 *    about one attribute is carried by the comment text, so the whole item
 *    is what the fixes screen must open.
 *
 * The detail attributes are gated on `isOfferedAvailability`, not rendered
 * unconditionally: answering "no" here must collapse them exactly as it does
 * on the main form, where `offeredKeys` would have dropped the item from
 * Pass 2 entirely. For Pass 2 the gate is a no-op (its caller already
 * filtered to offered items and it renders no control that could change
 * availability), so this is one rule for both screens rather than a second
 * rule for the new one.
 */
export function ServiceItemCard(props: {
  item: ServiceItem
  value: ServiceValueInput | undefined
  onChange: (value: ServiceValueInput) => void
  /** Server refusal for this item's most recent save, if any. */
  error?: string
  withAvailability?: boolean
}): React.JSX.Element {
  const { pick, t } = useLocale()
  const { item } = props
  const value = serviceValueOrEmpty(props.value)
  const offered = isOfferedAvailability(item, value.available)
  const needsPrice = requiresPrice(value.chargeType)

  return (
    <div className="pass2-card">
      <h3>{pick(item.label)}</h3>
      {item.hint && <p className="field-hint">{pick(item.hint)}</p>}

      {/* Галочка и дропдаун подписываются по-разному, как и везде в этой
          карточке: у чекбокса подпись стоит рядом внутри `.field-check`
          (как у «Нужна бронь» ниже), у списка — над ним отдельной строкой
          (как у «Платно/бесплатно»). Один вариант на оба выглядел бы
          сломанным для одного из них: `.pass2-card select` тянется на всю
          ширину карточки, так что внутри flex-строки `.field-check` подпись
          оказалась бы выдавлена за край. Из 58 позиций дропдаун только у
          одной (8.3, Vaping policy) — но именно поэтому её легко не
          заметить. */}
      {props.withAvailability &&
        (isBinaryAvailability(item) ? (
          <label className="field-check">
            <ServiceAvailabilityInput item={item} value={props.value} onChange={props.onChange} />
            {t('services.available')}
          </label>
        ) : (
          <>
            <label>{t('services.available')}</label>
            <ServiceAvailabilityInput item={item} value={props.value} onChange={props.onChange} />
          </>
        ))}

      {offered && (
        <>
          <label>{t('services.charge')}</label>
          <select
            value={value.chargeType ?? ''}
            onChange={(e) =>
              props.onChange({
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
                  props.onChange({
                    ...value, price: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
              <label>{t('services.currency')}</label>
              <input
                value={value.currency ?? ''}
                onChange={(e) => props.onChange({ ...value, currency: e.target.value })}
              />
            </>
          )}

          <label>{t('services.slot')}</label>
          <input
            type="number" min={0}
            value={value.slotMinutes ?? ''}
            onChange={(e) =>
              props.onChange({
                ...value, slotMinutes: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />

          <label className="field-check">
            <input
              type="checkbox"
              checked={value.bookingRequired ?? false}
              onChange={(e) => props.onChange({ ...value, bookingRequired: e.target.checked })}
            />
            {t('services.booking')}
          </label>

          <label>{t('services.details')}</label>
          <textarea
            value={value.details ?? ''}
            onChange={(e) => props.onChange({ ...value, details: e.target.value })}
          />
        </>
      )}

      {props.error && <p className="fix-comment">{props.error}</p>}
    </div>
  )
}
