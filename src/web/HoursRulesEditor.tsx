'use client'

import { useEffect, useRef, useState, type JSX } from 'react'
import {
  MARKER_BESIDE_TEXT,
  WEEKDAYS,
  canAddRange,
  dayHoursProblem,
  dayRenderable,
  dayTexts,
  emptyRule,
  expandRules,
  nextWindowStart,
  rulesFromWeek,
  splitDay,
  toggleDay,
  weekHoursProblem,
  weekKey,
  type HoursOptions,
  type HoursRule,
  type Range,
  type WeekHours,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { RangeEditor } from './RangeEditor'

/**
 * Редактор часов ПРАВИЛАМИ: «эти дни — такой режим». Список правил живёт в
 * состоянии компонента, а не выводится из значения на каждом рендере: правило,
 * у которого ещё нет дней или времени, в неделю не ложится (`expandRules` его
 * пропускает), и выведенный заново список его бы потерял — оператор нажал
 * «другие часы», а строка исчезла. Наружу уходит `expandRules(rules)` — тот же
 * `onChange`, что у любого поля; сервер видит только дни.
 *
 * Значение снаружи (первый рендер, правка командой, автосохранение вернуло
 * другое) пересобирает список через `rulesFromWeek`, но ТОЛЬКО когда оно
 * отличается от того, что дали бы текущие правила: иначе каждое собственное
 * сохранение стирало бы недозаполненные правила.
 */
function initialRules(value: unknown, options: HoursOptions): HoursRule[] {
  // Старый текстовый ответ и любое нечитаемое значение — тот же старт, что у
  // пустого поля: `rulesFromWeek({})` даёт одно правило на все семь дней.
  if (typeof value === 'string' || !value || typeof value !== 'object') return rulesFromWeek({})
  const week = value as WeekHours
  const clean: WeekHours = {}
  for (const day of WEEKDAYS) {
    const hours = week[day]
    if (hours === undefined) continue
    // Тот же вопрос, что у других редакторов недели («можно прочитать
    // `kind`/интервалы, чтобы нарисовать») — вызывается напрямую, а не через
    // повторную реализацию её тела (Fix-before-merge minor, сквозное ревью).
    if (dayRenderable(dayHoursProblem(hours, options))) clean[day] = hours
  }
  // `rulesFromWeek`, не `collapseWeek`: день, отсутствующий в `clean` (не
  // пришёл вовсе или отфильтрован как нерисуемый), — «не отвечено», легальный
  // черновик (C2). `collapseWeek` такой день молча роняет, `expandRules`
  // читает его отсутствие как «нет правила → закрыто», и следующий `commit()`
  // записал бы это закрытие как настоящий ответ оператора.
  return rulesFromWeek(clean)
}

export function HoursRulesEditor(props: {
  value: unknown
  options: HoursOptions
  onChange: (week: WeekHours) => void
  idPrefix: string
}): JSX.Element {
  const { t, locale, pick } = useLocale()
  const { options, onChange } = props
  const legacy = typeof props.value === 'string' && props.value.trim() !== '' ? props.value : null
  const [rules, setRules] = useState<HoursRule[]>(() => initialRules(props.value, options))

  const incoming = weekKey(props.value)
  useEffect(() => {
    // `weekKey`, не `JSON.stringify`: сравнение по значению дней в
    // каноническом порядке `WEEKDAYS` и по канонической форме каждого дня
    // (массив `[from, to]` на окно, а не объект) — Postgres jsonb не хранит
    // порядок ключей ни у недели, ни ВНУТРИ объекта одного дня, и та же
    // неделя, вернувшаяся с автосохранения в другом порядке ключей на любом
    // из двух уровней, раньше не совпадала со своей же строкой и заставляла
    // пересобирать правила на каждой загрузке (I1, затем I2 — тот же довод,
    // на уровень глубже). Гарантия та же, что и была: пересборка только от
    // внешнего значения (`incoming`) — изменение самих `rules` (наше же
    // сохранение) не перезапускает этот эффект и не стирает недозаполненные
    // правила, которых `expandRules` не выводит.
    if (weekKey(expandRules(rules)) !== incoming && typeof props.value !== 'string') {
      setRules(initialRules(props.value, options))
    }
  }, [incoming])

  // I5: после `splitDay`/«другие часы» новое правило появляется в конце
  // списка пустым — оператор уже видел, зачем оно возникло (нажал «изменить»
  // у дня или «другие часы для части дней»), и это фокус, который он бы искал
  // сам. Ref — на поле «с» первого диапазона ПОСЛЕДНЕГО правила; эффект
  // срабатывает только когда список правил ВЫРОС, а не на любое изменение
  // (иначе перевод дня между уже существующими правилами тоже дёргал бы
  // фокус — там оператор уже там, где кликнул).
  const lastFromInputRef = useRef<HTMLInputElement | null>(null)
  const previousRuleCount = useRef(rules.length)
  useEffect(() => {
    if (rules.length > previousRuleCount.current) lastFromInputRef.current?.focus()
    previousRuleCount.current = rules.length
  }, [rules.length])

  const commit = (next: HoursRule[]): void => {
    setRules(next)
    onChange(expandRules(next))
  }
  const setRule = (i: number, rule: HoursRule): void => commit(rules.map((r, k) => (k === i ? rule : r)))
  const week = expandRules(rules)
  const texts = dayTexts(week, options, locale)

  const incomplete = rules.findIndex((r) => r.days.length === 0)
  const noTime = rules.findIndex((r) => r.hours.kind === 'windows' && r.hours.ranges.some((x) => x.from === ''))
  // I3: маркер, делящий день с чужим окном (обычно — ночной хвост
  // предыдущего дня), не сходится в правило независимо от того, как
  // оператор переставляет дни между правилами — сервер всё равно откажет
  // (`validation.ts`), клиент называет причину заранее.
  const markerBeside = weekHoursProblem(week, options) === 'markerBeside'

  return (
    <div className="hr">
      {legacy !== null && (
        <div className="hr-legacy">
          <p className="hr-legacy-value">{legacy}</p>
          <p className="field-hint">{t('form.freeFormAnswer')}</p>
        </div>
      )}

      {rules.map((rule, i) => (
        <div className="hr-rule" key={i}>
          <p className="hr-name">{t('schedule.ruleN').replace('{n}', String(i + 1))}</p>
          <div className="hr-row">
            <span className="chip-row hr-days" role="group" aria-label={t('schedule.ruleN').replace('{n}', String(i + 1))}>
              {WEEKDAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={rule.days.includes(day)}
                  aria-label={t(`schedule.day.${day}`)}
                  onClick={() => commit(toggleDay(rules, i, day))}
                >
                  {t(`schedule.dayShort.${day}`)}
                </button>
              ))}
            </span>

            {rule.hours.kind === 'windows' &&
              rule.hours.ranges.map((range, k) => (
                <RangeEditor
                  key={k}
                  id={`${props.idPrefix}-r${i}-${k}`}
                  range={range}
                  options={options}
                  // Только последнее правило, только его первый диапазон —
                  // именно туда переезжает фокус, когда список правил растёт
                  // (I5, см. эффект выше).
                  fromRef={i === rules.length - 1 && k === 0 ? lastFromInputRef : undefined}
                  onChange={(next) => {
                    const ranges = (rule.hours as { ranges: Range[] }).ranges.map((x, m) => (m === k ? next : x))
                    setRule(i, { ...rule, hours: { kind: 'windows', ranges } })
                  }}
                />
              ))}

            {options.allDay && (
              <button
                type="button"
                className="hr-chip"
                aria-pressed={rule.hours.kind === 'allDay'}
                onClick={() =>
                  setRule(i, {
                    ...rule,
                    hours: rule.hours.kind === 'allDay' ? { kind: 'windows', ranges: [{ from: '', to: null }] } : { kind: 'allDay' },
                  })
                }
              >
                {t('schedule.allDayShort')}
              </button>
            )}

            {rule.hours.kind === 'windows' && canAddRange(rule.hours.ranges) && (
              <button
                type="button"
                className="hr-link"
                onClick={() => {
                  const ranges = (rule.hours as { ranges: Range[] }).ranges
                  const start = nextWindowStart(ranges.map((x) => ({ from: x.from, to: x.to })))
                  if (start) setRule(i, { ...rule, hours: { kind: 'windows', ranges: [...ranges, { from: start, to: null }] } })
                }}
              >
                {t('schedule.addRange')}
              </button>
            )}

            {rules.length > 1 && (
              <button type="button" className="hr-x" aria-label={t('schedule.removeRule')} onClick={() => commit(rules.filter((_, k) => k !== i))}>
                ×
              </button>
            )}
          </div>
        </div>
      ))}

      <button type="button" className="hr-link hr-add" onClick={() => commit([...rules, emptyRule([])])}>
        {t('schedule.otherHours')}
      </button>

      {incomplete >= 0 && <p className="field-hint">{t('schedule.rulePickDays').replace('{n}', String(incomplete + 1))}</p>}
      {incomplete < 0 && noTime >= 0 && <p className="field-hint">{t('schedule.ruleSetTime').replace('{n}', String(noTime + 1))}</p>}

      <div className="hr-sum">
        <p className="hr-sum-title">{t('schedule.weekSummary')}</p>
        {WEEKDAYS.map((day) => (
          <div className="hr-sum-row" key={day}>
            <span className="hr-sum-day">{t(`schedule.day.${day}`)}</span>
            <span className={week[day]?.kind === 'none' ? 'hr-sum-closed' : undefined}>{texts[day]}</span>
            {/* I5: семь кнопок делили один accessible name («change») —
                экранный читалка не могла сказать, какая строка какому дню
                отвечает. `aria-label` называет и действие, и день. */}
            <button
              type="button"
              className="hr-link"
              aria-label={`${t('schedule.change')} — ${t(`schedule.day.${day}`)}`}
              onClick={() => commit(splitDay(rules, day))}
            >
              {t('schedule.change')}
            </button>
          </div>
        ))}
        {/* I3: клиентский намёк под итогом — сервер остаётся воротами
            (`validation.ts`'s `INVALID_SCHEDULE_MARKER`), это только чтобы
            отказ не пришёл издалека после «отправить». */}
        {markerBeside && <p className="field-hint">{pick(MARKER_BESIDE_TEXT)}</p>}
      </div>
    </div>
  )
}
