'use client'

import type { Field, SelectValue } from '@/form-schema'
import { OPTION_LISTS, needsDetail } from '@/form-schema'
import { useLocale } from '@/i18n/context'

/**
 * Merges a partial change into a select-family value (`{ option, detail,
 * slots }`) without ever dropping a member the caller isn't touching this
 * time. `option` and `detail` fall back to whatever `current` already holds
 * when the patch omits them; `slots` merges key-by-key on top of
 * `current.slots` rather than replacing the whole object, so patching one
 * slot can never erase a sibling slot.
 *
 * This exists because hand-rolling `{ ...current, ... }` at each call site
 * is exactly how the dropdown's `onChange` once dropped `III.3.2`'s `age`
 * slot: it built `{ option: e.target.value, detail: current.detail }`
 * directly, without spreading `current` first, so any `slots` already
 * entered vanished the moment the operator touched the dropdown again —
 * silently, with no error and no indication anything was lost. Every
 * select-family handler below routes through this single function instead,
 * so that class of bug can't recur at a fourth call site later.
 */
export function nextSelectValue(
  current: SelectValue,
  patch: { option?: string; detail?: string | null; slots?: Record<string, number | null> },
): SelectValue {
  const next: SelectValue = {
    option: patch.option ?? current.option,
    detail: patch.detail !== undefined ? patch.detail : current.detail,
  }
  if (patch.slots || current.slots) {
    next.slots = { ...current.slots, ...patch.slots }
  }
  return next
}

/**
 * Converts a number `<input>`'s raw string value to what should reach
 * `onChange`: `null` when the box is empty, the parsed number otherwise.
 * Extracted — like `nextSelectValue` above — so the empty case is directly
 * testable without a DOM (see `src/web/__tests__/fieldContract.test.ts`) and
 * so all three number inputs below (plain `number` field, template slot,
 * compound select-field slot) share one definition of "empty" instead of
 * three copies that could drift.
 *
 * `Number(e.target.value)` alone — this function's entire previous form —
 * was Important finding I4: an emptied box has `e.target.value === ''`, and
 * `Number('') === 0`, so clearing a number field silently wrote `0` — a
 * value indistinguishable from a genuine answer of zero, and one
 * `validateField` happily accepts as a complete answer. `null` is the
 * actual "nothing answered" value `validateField`'s own `isEmpty` already
 * expects.
 */
export function numberFieldValue(raw: string): number | null {
  return raw === '' ? null : Number(raw)
}

/**
 * Membership after a tap on one chip of a `multi_select`: already selected →
 * drop it (`filter` keeps the order of the remaining ids untouched), not yet
 * selected → append at the END. This is byte-for-byte the emission the old
 * checkboxes produced from `e.target.checked` — the control changed shape
 * (checkbox → toggle chip), the emitted value did not, so `renderValues`, the
 * validator and the server see exactly what they always saw.
 *
 * Exported pure — the unit suite has no DOM to click in — the same technique
 * `nextSelectValue`/`numberFieldValue` above and `availabilityAfterTap` in
 * `ServiceItemCard` already use; pinned in `fieldContract.test.ts`.
 */
export function multiSelectAfterTap(selected: string[], optionId: string): string[] {
  return selected.includes(optionId)
    ? selected.filter((id) => id !== optionId)
    : [...selected, optionId]
}

export function FieldInput(props: {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
  /**
   * The server's own refusal message for this field's most recent save
   * attempt, if any (`useAutosave`'s `rejected[field.key]`, threaded down
   * through `FillForm`). Rendered with `.fix-comment` — the existing red
   * error style — never `.field-hint`, which is muted grey and would make a
   * genuine refusal read as a passive suggestion. Before this prop existed,
   * a refused save was computed and then dropped on the floor: the operator
   * saw the global "Saved" status while the database still held the old
   * value (see `useAutosave.ts` / Critical 2 in the whole-branch review).
   */
  error?: string
}): React.JSX.Element {
  const { field, value, onChange, error } = props
  const { pick, t } = useLocale()

  const label = (
    <label className="field-label" htmlFor={field.key}>
      {pick(field.label)}
      {field.required && <span className="field-required">{t('form.required')}</span>}
    </label>
  )

  const hint = field.hint && <p className="field-hint">{pick(field.hint)}</p>
  const errorNode = error && <p className="fix-comment">{error}</p>

  switch (field.type) {
    case 'select':
    case 'select_with_detail': {
      const options = field.optionList ? OPTION_LISTS[field.optionList] : []
      const current: SelectValue = (value ?? { option: '', detail: null }) as SelectValue
      const chosen = options.find((o) => o.id === current.option)
      // Shared with `validateSelect` (see `needsDetail`'s own doc comment
      // in `src/form-schema/validation.ts`) — this used to be a second,
      // independently-written copy of that rule, which is exactly how
      // Critical 1 happened: the two copies silently drifted apart.
      const showDetail = chosen != null && needsDetail(field, chosen.id)

      return (
        <div className="field">
          {label}
          {hint}
          <select
            id={field.key}
            value={current.option}
            onChange={(e) => onChange(nextSelectValue(current, { option: e.target.value }))}
          >
            <option value="">—</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {pick(option.label)}
              </option>
            ))}
          </select>
          {showDetail && (
            <textarea
              className="field-detail"
              value={current.detail ?? ''}
              onChange={(e) => onChange(nextSelectValue(current, { detail: e.target.value }))}
            />
          )}
          {/* Составное поле: у III.3.2 к дропдауну добавляется числовой слот. */}
          {field.templateSlots.length > 0 && (
            <div className="field-compound">
              <p className="field-template">
                {field.templateText ? pick(field.templateText) : ''}
              </p>
              {field.templateSlots.map((slot) => (
                <span key={slot.key} className="field-slot">
                  <input
                    type="number"
                    min={0}
                    value={current.slots?.[slot.key] ?? ''}
                    onChange={(e) =>
                      onChange(
                        nextSelectValue(current, {
                          slots: { [slot.key]: numberFieldValue(e.target.value) },
                        }),
                      )
                    }
                  />
                  {pick(slot.unit)}
                </span>
              ))}
            </div>
          )}
          {errorNode}
        </div>
      )
    }

    case 'multi_select': {
      const selected = Array.isArray(value) ? (value as string[]) : []
      const options = field.optionList ? OPTION_LISTS[field.optionList] : []

      // Чипы вместо чекбоксов: чекбокс попадал под общее правило
      // `.field input { width: 100% }` и растягивался на всю карточку на
      // ОБЕИХ ширинах (та же болезнь, что у «Нужна бронь» до
      // `.pass2-card input[type='checkbox']` — а этот случай тем правилом не
      // накрыт). Визуальный язык — тот же, что у пары Да|Нет
      // (`ServiceAvailabilityInput` / `.avail-toggle`): нажато = акцентная
      // заливка, не нажато = тихая рамка, состояние читается из
      // `aria-pressed` — но раскладка своя (`.chip-row`): членство в
      // множестве, каждый чип независим, поэтому чипы разделены зазором и
      // свободно переносятся на новую строку, а не слиты в сегменты.
      //
      // Заголовок поля здесь — <span>, не общий `label` сверху: <label> над
      // рядом настоящих <button> — в точности форма ловушки b (переадресация
      // клика по заголовку первой labelable-кнопке, см.
      // `servicesPass1.test.tsx` и решение `ServicesPass1` сделать бинарную
      // строку <div>). Сегодня `htmlFor={field.key}` не находит адресата
      // (у чипов нет id), но не-label — защита структурой, а не совпадением.
      // Имя группы для скринридера даёт `aria-label`, как у пары.
      return (
        <div className="field">
          <span className="field-label">
            {pick(field.label)}
            {field.required && <span className="field-required">{t('form.required')}</span>}
          </span>
          {hint}
          <div className="chip-row" role="group" aria-label={pick(field.label)}>
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected.includes(option.id)}
                onClick={() => onChange(multiSelectAfterTap(selected, option.id))}
              >
                {pick(option.label)}
              </button>
            ))}
          </div>
          {errorNode}
        </div>
      )
    }

    case 'template': {
      const slots = (value ?? {}) as Record<string, number | null>
      return (
        <div className="field">
          {label}
          {hint}
          <p className="field-template">
            {field.templateText ? pick(field.templateText) : ''}
          </p>
          {field.templateSlots.map((slot) => (
            <span key={slot.key} className="field-slot">
              <input
                type="number"
                min={0}
                value={slots[slot.key] ?? ''}
                onChange={(e) =>
                  onChange({ ...slots, [slot.key]: numberFieldValue(e.target.value) })
                }
              />
              {pick(slot.unit)}
            </span>
          ))}
          {errorNode}
        </div>
      )
    }

    case 'textarea':
      return (
        <div className="field">
          {label}
          {hint}
          <textarea
            id={field.key}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.example && <p className="field-example">{field.example}</p>}
          {errorNode}
        </div>
      )

    default:
      return (
        <div className="field">
          {label}
          {hint}
          <input
            id={field.key}
            type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
            min={field.type === 'number' ? 0 : undefined}
            value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
            onChange={(e) =>
              onChange(field.type === 'number' ? numberFieldValue(e.target.value) : e.target.value)
            }
          />
          {field.example && <p className="field-example">{field.example}</p>}
          {errorNode}
        </div>
      )
  }
}
