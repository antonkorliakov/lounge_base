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
 * Pass 1's question — "does the lounge have this?" — as a standalone control:
 * the item's own availability option list as a `<select>`, ahead of the same
 * `—` placeholder every other dropdown in this form uses for "nothing
 * answered yet" (see `FieldInput`, and `renderValues` on the review side).
 *
 * It used to render a plain checkbox for the 57 `yesNo` items and this
 * `<select>` only for the one item with its own list (`8.3` Vaping policy).
 * A checkbox has two states and this answer has three, and the state it
 * could not express is the one a flagged item most often needs: `checked=
 * available === 'yes'` drew "no" and "nothing said" identically, so a filler
 * whose truthful correction was "no" — the natural answer to the reviewer's
 * most common reason code, `empty` — saw a control that already looked like
 * "no" and could do nothing with it. Doing nothing saved nothing: the flag
 * stayed open, `serviceItemAnswered` stayed false, `submitSubmission` kept
 * refusing and naming the item, and the only way out was to check the box and
 * uncheck it again. On the fixes screen that is the entire response surface
 * for the flag; on Pass 1 it is the same trap one screen over, since a lounge
 * that genuinely lacks 40 of the 58 items can only say so by ticking and
 * unticking 40 boxes. Both screens render this one control, so both are fixed
 * by the same change rather than by a second availability rule.
 *
 * `<select>` rather than a radio pair, though radios answer in one tap: the
 * Pass 1 row is itself a `<label>` wrapping the item text and the control, so
 * that a tap anywhere in a 58-row list lands on the answer (see
 * `ServicesPass1`). A `<label>` cannot wrap a radio GROUP — it forwards to
 * the first control — so radios would make a tap on the item's name answer
 * "Yes", which is worse than a slow control: it is a wrong answer nobody
 * typed. The dropdown also keeps the deliberate un-selection path (`''`,
 * normalised to `null` at the write boundary, see `saveServiceValue`) that
 * the checkbox never had.
 *
 * The options come from `OPTION_LISTS[item.availabilityList]`, so nothing
 * here restates what "yes"/"no" are — the last availability condition in the
 * codebase that was not delegated to the schema (`available === 'yes'`,
 * review Minor 8) is gone with the checkbox, along with the
 * `isBinaryAvailability` predicate that only existed to pick between the two
 * renderings.
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

  return (
    <select
      value={value?.available ?? ''}
      onChange={(e) =>
        props.onChange({ ...serviceValueOrEmpty(value), available: e.target.value })
      }
    >
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

      {/* Подпись — отдельной строкой над контролом, как у «Платно/бесплатно»
          и остальных списков этой карточки. Раньше здесь была вторая ветка
          для чекбокса (подпись рядом, внутри `.field-check`): контрол
          наличия стал одним для всех 58 позиций, так что и подписывается он
          теперь одним способом. */}
      {props.withAvailability && (
        <>
          <label>{t('services.available')}</label>
          <ServiceAvailabilityInput item={item} value={props.value} onChange={props.onChange} />
        </>
      )}

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
