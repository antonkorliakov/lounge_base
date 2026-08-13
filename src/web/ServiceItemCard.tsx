'use client'

import {
  OPTION_LISTS,
  isBinaryAvailability,
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
 * What one tap on a toggle button emits: the tapped option when it wasn't the
 * answer, and `''` — cleared back to unanswered — when it already was. `''`,
 * not `null`, deliberately: it is byte-for-byte what the `<select>`'s `—`
 * placeholder emitted through `e.target.value`, and `saveServiceValue`
 * normalises exactly that (`available === '' ? null : available`) at the
 * write boundary. The un-tap is the toggle pair's replacement for `—`: a
 * pair of buttons has no third button, so the deliberate un-selection path
 * the dropdown provided must live in the second tap or nowhere.
 *
 * The merge over `serviceValueOrEmpty` is the same one the select's onChange
 * does below — a first answer carries every attribute the server expects, a
 * later one never drops an attribute Pass 2 already filled in.
 *
 * Exported pure, like `FieldInput`'s `nextSelectValue`, because the unit
 * suite has no DOM to click in (`renderToStaticMarkup` only) — this is the
 * function `fieldContract.test.ts` pins the clearing semantics on.
 */
export function availabilityAfterTap(
  current: ServiceValueInput | undefined,
  optionId: string,
): ServiceValueInput {
  const base = serviceValueOrEmpty(current)
  return { ...base, available: base.available === optionId ? '' : optionId }
}

/**
 * Pass 1's question — "does the lounge have this?" — as a standalone control.
 * Two renderings, chosen by the schema (`isBinaryAvailability`, i.e. "does
 * this item's own option list hold exactly two options" — never a hand-kept
 * item list):
 *
 *  - binary items (57 of 58 today): a Yes|No toggle-button pair, labels from
 *    `OPTION_LISTS[item.availabilityList]`'s own localized labels. Neither
 *    button pressed IS the third state — unanswered stays visible, which is
 *    the tri-state requirement (I2) that killed the original checkbox:
 *    `checked = available === 'yes'` drew "no" and "nothing said" identically,
 *    so a filler whose truthful correction was "no" (the natural answer to the
 *    reviewer's most common reason code, `empty`) saw a control that already
 *    looked like "no". `aria-pressed` on both buttons makes the same three
 *    states real for a screen reader, and `role="group"` named after the item
 *    keeps 58 pairs of otherwise identical "Yes"/"No" buttons tellable apart.
 *    Tapping the pressed button clears back to unanswered — see
 *    `availabilityAfterTap` above.
 *
 *  - everything else (`8.3` Vaping policy's three-option list today): the
 *    `<select>` with the same `—` placeholder every other dropdown in this
 *    form uses for "nothing answered yet".
 *
 * History, because this control has been all three shapes now. Checkbox →
 * dropdown was I2 (the fixes-screen fix wave): tri-state answer, two-state
 * control. That change rejected RADIOS for a concrete hazard: the Pass 1 row
 * is a `<label>` wrapping item text + control, a label forwards activation to
 * its first labelable descendant, so tapping an item's NAME would have
 * answered "Yes" — a wrong answer nobody typed. Real `<button>`s are
 * labelable too, so the toggle pair steps into the SAME trap if left inside
 * that label — verified in the browser on this branch, not assumed: with the
 * row still a `<label>`, a click on "Air Conditioning"'s name pressed its Yes
 * button. The fix is structural and lives in `ServicesPass1`: a binary row is
 * a plain `<div>`, not a label (see the comment there); this component stays
 * wrapper-agnostic. Dropdown → toggle pair trades that solved problem's
 * one-tap cost back: 57 of 58 answers are now one tap again, without giving
 * up the third state or the deliberate un-selection path.
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

  if (isBinaryAvailability(item)) {
    return (
      <span className="avail-toggle" role="group" aria-label={pick(item.label)}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value?.available === option.id}
            onClick={() => props.onChange(availabilityAfterTap(value, option.id))}
          >
            {pick(option.label)}
          </button>
        ))}
      </span>
    )
  }

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
