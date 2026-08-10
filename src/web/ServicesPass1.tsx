'use client'

import { SERVICE_GROUPS, SERVICE_ITEMS, OPTION_LISTS, type ServiceValueInput } from '@/form-schema'
import { useLocale } from '@/i18n/context'

const EMPTY: Omit<ServiceValueInput, 'available'> = {
  chargeType: null, price: null, currency: null,
  slotMinutes: null, bookingRequired: null, details: null,
}

export function ServicesPass1(props: {
  values: Record<string, ServiceValueInput>
  onChange: (itemKey: string, value: ServiceValueInput) => void
}): React.JSX.Element {
  const { pick, t } = useLocale()

  return (
    <section className="pass1">
      <h2>{t('services.pass1Title')}</h2>
      <p className="subtitle">{t('services.pass1Hint')}</p>

      {SERVICE_GROUPS.map((group) => (
        <div key={group.key} className="pass1-group">
          <h3>{pick(group.label)}</h3>
          {SERVICE_ITEMS.filter((i) => i.group === group.key).map((item) => {
            const current = props.values[item.key]
            const options = OPTION_LISTS[item.availabilityList]
            const isBinary = item.availabilityList === 'yesNo'

            // The whole row is a <label>, not just the <input>: on a phone,
            // standing in a lounge thumbing through 58 items, the tappable
            // area needs to be the entire row (finger-sized, per the mobile
            // constraint), not the visual checkbox alone. A <label> wrapping
            // both the item text and its control forwards a tap anywhere in
            // the row to that control natively — toggling the checkbox, or
            // opening the <select> — no extra JS needed.
            return (
              <label key={item.key} className="pass1-row">
                <span>{pick(item.label)}</span>
                {isBinary ? (
                  <input
                    type="checkbox"
                    checked={current?.available === 'yes'}
                    onChange={(e) =>
                      props.onChange(item.key, {
                        ...EMPTY,
                        ...current,
                        available: e.target.checked ? 'yes' : 'no',
                      })
                    }
                  />
                ) : (
                  <select
                    value={current?.available ?? ''}
                    onChange={(e) =>
                      props.onChange(item.key, {
                        ...EMPTY, ...current, available: e.target.value,
                      })
                    }
                  >
                    <option value="">—</option>
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {pick(option.label)}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )
          })}
        </div>
      ))}
    </section>
  )
}
