'use client'

import type { Field, SelectValue } from '@/form-schema'
import { OPTION_LISTS } from '@/form-schema'
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
      // `chosen.requiresDetail` covers options that always need a detail
      // (see `option-lists.ts`); `field.detailRequiredFor` covers options
      // that are `plain()` on the list itself but need one for this
      // particular field (see `III.2.4` — every `airlineAccess` option is
      // `plain()`, yet "specific airlines" is meaningless unqualified).
      // Without the second check the detail textarea never renders for such
      // a field, and `validateSelect` refuses every save forever.
      const needsDetail =
        chosen != null && (chosen.requiresDetail || field.detailRequiredFor.includes(chosen.id))

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
          {needsDetail && (
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

      return (
        <div className="field">
          {label}
          {hint}
          {options.map((option) => (
            <label key={option.id} className="field-check">
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, option.id]
                      : selected.filter((id) => id !== option.id),
                  )
                }
              />
              {pick(option.label)}
            </label>
          ))}
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
