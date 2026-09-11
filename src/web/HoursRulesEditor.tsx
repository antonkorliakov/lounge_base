'use client'

import { useEffect, useState, type JSX } from 'react'
import {
  WEEKDAYS,
  collapseWeek,
  dayTexts,
  emptyRule,
  expandRules,
  hasMarker,
  isClock,
  nextWindowStart,
  splitDay,
  toggleDay,
  weekHoursProblem,
  type HoursOptions,
  type HoursRule,
  type Range,
  type WeekHours,
  type Weekday,
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
 * другое) пересобирает список через `collapseWeek`, но ТОЛЬКО когда оно
 * отличается от того, что дали бы текущие правила: иначе каждое собственное
 * сохранение стирало бы недозаполненные правила.
 */
function initialRules(value: unknown, options: HoursOptions): HoursRule[] {
  if (typeof value === 'string' || !value || typeof value !== 'object') return [emptyRule([...WEEKDAYS])]
  const week = value as WeekHours
  const clean: WeekHours = {}
  for (const day of WEEKDAYS) {
    const hours = week[day]
    if (hours === undefined) continue
    // Тот же вопрос, что `dayRenderable(dayHoursProblem(...))` в других
    // редакторах недели («можно прочитать `kind`/интервалы, чтобы
    // нарисовать»), заданный через `weekHoursProblem` на объекте с одним
    // днём — она в списке того, что читает этот компонент (Task 4 consumes).
    const problem = weekHoursProblem({ [day]: hours }, options)
    if (problem !== 'shape' && problem !== 'kind') clean[day] = hours
  }
  const rules = collapseWeek(clean)
  return rules.length > 0 ? rules : [emptyRule([...WEEKDAYS])]
}

export function HoursRulesEditor(props: {
  value: unknown
  options: HoursOptions
  onChange: (week: WeekHours) => void
  idPrefix: string
}): JSX.Element {
  const { t, locale } = useLocale()
  const { options, onChange } = props
  const legacy = typeof props.value === 'string' && props.value.trim() !== '' ? props.value : null
  const [rules, setRules] = useState<HoursRule[]>(() => initialRules(props.value, options))

  const incoming = JSON.stringify(props.value ?? null)
  useEffect(() => {
    if (JSON.stringify(expandRules(rules)) !== incoming && typeof props.value !== 'string') {
      setRules(initialRules(props.value, options))
    }
    // Пересборка только от внешнего значения (`incoming`) — иначе изменение
    // самих `rules` (наше же сохранение) перезапускало бы этот эффект и
    // стирало недозаполненные правила, которых `expandRules` не выводит.
  }, [incoming])

  const commit = (next: HoursRule[]): void => {
    setRules(next)
    onChange(expandRules(next))
  }
  const setRule = (i: number, rule: HoursRule): void => commit(rules.map((r, k) => (k === i ? rule : r)))
  const week = expandRules(rules)
  const texts = dayTexts(week, options, locale)

  const incomplete = rules.findIndex((r) => r.days.length === 0)
  const noTime = rules.findIndex((r) => r.hours.kind === 'windows' && r.hours.ranges.some((x) => x.from === ''))

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
                  onChange={(next) => {
                    const ranges = (rule.hours as { ranges: Range[] }).ranges.map((x, m) => (m === k ? next : x))
                    setRule(i, { ...rule, hours: { kind: 'windows', ranges } })
                  }}
                />
              ))}
            {rule.hours.kind === 'allDay' && <span className="hr-allday-text">{t('schedule.allDay')}</span>}

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
            <button type="button" className="hr-link" onClick={() => commit(splitDay(rules, day))}>
              {t('schedule.change')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Второй интервал предлагается только после полной пары времён без маркеров:
 *  у интервала с маркером второго не бывает (правило схемы), у ночного —
 *  следующий начинался бы уже завтра. */
function canAddRange(ranges: Range[]): boolean {
  const last = ranges[ranges.length - 1]
  if (!last || last.to === null || hasMarker({ from: last.from, to: last.to })) return false
  return isClock(last.from) && isClock(last.to) && nextWindowStart([{ from: last.from, to: last.to }]) !== null
}
