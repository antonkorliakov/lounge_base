'use client'

import { SERVICE_GROUPS, SERVICE_ITEMS, type ServiceValueInput } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { ServiceAvailabilityInput } from './ServiceItemCard'

export function ServicesPass1(props: {
  values: Record<string, ServiceValueInput>
  onChange: (itemKey: string, value: ServiceValueInput) => void
}): React.JSX.Element {
  const { pick, t } = useLocale()

  return (
    <section className="pass1">
      {/* Название шага (`services.pass1Title`) больше не рендерится здесь:
          шелл теперь называет КАЖДЫЙ шаг в своём заголовке-навигаторе (см.
          `stepTitle` в FormShell.tsx), и второй <h2> с тем же текстом прямо
          под ним был бы дублем — и, что хуже, вторым heading с тем же
          accessible name для e2e-локаторов. Подсказка остаётся: она — часть
          этого экрана, а не его имя. */}
      <p className="subtitle">{t('services.pass1Hint')}</p>

      {SERVICE_GROUPS.map((group) => (
        <div key={group.key} className="pass1-group">
          <h3>{pick(group.label)}</h3>
          {SERVICE_ITEMS.filter((i) => i.group === group.key).map((item) => (
            // The whole row is a <label>, not just the <input>: on a phone,
            // standing in a lounge thumbing through 58 items, the tappable
            // area needs to be the entire row (finger-sized, per the mobile
            // constraint), not the visual checkbox alone. A <label> wrapping
            // both the item text and its control forwards a tap anywhere in
            // the row to that control natively — toggling the checkbox, or
            // opening the <select> — no extra JS needed.
            //
            // The control itself (and the `{ ...EMPTY, ...current }` merge it
            // emits) moved to `ServiceAvailabilityInput` so the fixes screen
            // can render the same one — see `./ServiceItemCard.tsx`.
            <label key={item.key} className="pass1-row">
              <span>{pick(item.label)}</span>
              <ServiceAvailabilityInput
                item={item}
                value={props.values[item.key]}
                onChange={(value) => props.onChange(item.key, value)}
              />
            </label>
          ))}
        </div>
      ))}
    </section>
  )
}
