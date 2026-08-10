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

export function FieldInput(props: {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
}): React.JSX.Element {
  const { field, value, onChange } = props
  const { pick, t } = useLocale()

  const label = (
    <label className="field-label" htmlFor={field.key}>
      {pick(field.label)}
      {field.required && <span className="field-required">{t('form.required')}</span>}
    </label>
  )

  const hint = field.hint && <p className="field-hint">{pick(field.hint)}</p>

  switch (field.type) {
    case 'select':
    case 'select_with_detail': {
      const options = field.optionList ? OPTION_LISTS[field.optionList] : []
      const current: SelectValue = (value ?? { option: '', detail: null }) as SelectValue
      const chosen = options.find((o) => o.id === current.option)

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
          {chosen?.requiresDetail && (
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
                          slots: {
                            [slot.key]: e.target.value === '' ? null : Number(e.target.value),
                          },
                        }),
                      )
                    }
                  />
                  {pick(slot.unit)}
                </span>
              ))}
            </div>
          )}
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
                  onChange({
                    ...slots,
                    [slot.key]: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
              {pick(slot.unit)}
            </span>
          ))}
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
              onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)
            }
          />
          {field.example && <p className="field-example">{field.example}</p>}
        </div>
      )
  }
}
