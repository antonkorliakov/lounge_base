'use client'

import type { Field } from '@/form-schema'
import { OPTION_LISTS } from '@/form-schema'
import { useLocale } from '@/i18n/context'

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
      const current = (value ?? { option: '', detail: null }) as {
        option: string
        detail: string | null
        slots?: Record<string, number | null>
      }
      const chosen = options.find((o) => o.id === current.option)

      return (
        <div className="field">
          {label}
          {hint}
          <select
            id={field.key}
            value={current.option}
            onChange={(e) => onChange({ option: e.target.value, detail: current.detail })}
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
              onChange={(e) => onChange({ ...current, detail: e.target.value })}
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
                      onChange({
                        ...current,
                        slots: {
                          ...current.slots,
                          [slot.key]: e.target.value === '' ? null : Number(e.target.value),
                        },
                      })
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
