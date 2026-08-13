'use client'

import {
  SERVICE_GROUPS,
  SERVICE_ITEMS,
  isBinaryAvailability,
  type ServiceValueInput,
} from '@/form-schema'
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
          {SERVICE_ITEMS.filter((i) => i.group === group.key).map((item) => {
            // Which element the row is depends on which control it holds —
            // and that is a correctness rule, not styling, so it is derived
            // from the same schema predicate that picks the control
            // (`isBinaryAvailability` in `ServiceAvailabilityInput`), never
            // decided here a second time.
            //
            // A NON-binary row (8.3 Vaping today) keeps the whole-row
            // <label>: its control is a <select>, and a label wrapping both
            // the item text and its control forwards a tap anywhere in the
            // row to that control natively — the finger-sized-row constraint
            // this list was built around.
            //
            // A binary row must NOT be a <label>: its control is a pair of
            // <button>s, buttons are labelable elements, and a label
            // forwards activation to its FIRST labelable descendant —
            // meaning a tap on the item's name would press "Yes", a wrong
            // answer nobody typed. Not hypothetical: verified in the browser
            // on this branch with the label still in place — clicking the
            // text "Air Conditioning" pressed its Yes button and autosaved
            // it. This is the exact trap that got radios rejected in the I2
            // fix wave, one control shape later. So the binary row is a
            // plain <div>; the whole-row tap affordance it loses mattered
            // when the row's only target was a lone checkbox, and matters
            // little now that the row holds two ≥44px buttons of its own.
            //
            // The control itself (and the `{ ...EMPTY, ...current }` merge it
            // emits) lives in `ServiceAvailabilityInput` so the fixes screen
            // can render the same one — see `./ServiceItemCard.tsx`.
            const Row = isBinaryAvailability(item) ? 'div' : 'label'
            return (
              <Row key={item.key} className="pass1-row">
                <span>{pick(item.label)}</span>
                <ServiceAvailabilityInput
                  item={item}
                  value={props.values[item.key]}
                  onChange={(value) => props.onChange(item.key, value)}
                />
              </Row>
            )
          })}
        </div>
      ))}
    </section>
  )
}
