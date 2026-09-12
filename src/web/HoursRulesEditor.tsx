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
  // Обе границы: раньше здесь смотрели только на `from === ''` — правило
  // с заданным началом и негодным/пустым концом (`to === null`) молчало,
  // хотя граница так же не отвечена (Important, whole-branch fix wave,
  // Finding 2). Текст подсказки один на оба конца — `schedule.ruleSetTime`
  // не называет, какая граница не набрана, только что правило не готово.
  const noTime = rules.findIndex((r) => r.hours.kind === 'windows' && r.hours.ranges.some((x) => x.from === '' || x.to === null))
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

      {rules.map((rule, i) => {
        const name = t('schedule.ruleN').replace('{n}', String(i + 1))
        const ranges = rule.hours.kind === 'windows' ? rule.hours.ranges : []
        const setRanges = (next: Range[]): void => setRule(i, { ...rule, hours: { kind: 'windows', ranges: next } })
        return (
          <div className="hr-rule" key={i}>
            <div className="hr-head">
              <p className="hr-name">{name}</p>
              {rules.length > 1 && (
                <button type="button" className="hr-x" aria-label={t('schedule.removeRule')} onClick={() => commit(rules.filter((_, k) => k !== i))}>
                  ×
                </button>
              )}
            </div>

            <span className="chip-row hr-days" role="group" aria-label={name}>
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

            {/* Режим дня — переключатель под днями, а не чип посреди строки
                с часами (Anton, 2026-09-13): «Круглосуточно» — ответ целиком,
                «По часам» раскрывает интервалы. Пиковые часы и уборка режима
                не имеют (`options.allDay` false) — у них сразу интервалы. */}
            {options.allDay && (
              <span className="hr-seg hr-mode" role="group">
                <button type="button" aria-pressed={rule.hours.kind === 'allDay'} onClick={() => rule.hours.kind !== 'allDay' && setRule(i, { ...rule, hours: { kind: 'allDay' } })}>
                  {t('schedule.allDayMode')}
                </button>
                <button type="button" aria-pressed={rule.hours.kind === 'windows'} onClick={() => rule.hours.kind !== 'windows' && setRanges([{ from: '', to: null }])}>
                  {t('schedule.hoursMode')}
                </button>
              </span>
            )}

            {rule.hours.kind === 'windows' && (
              <div className="hr-ints">
                {ranges.map((range, k) => (
                  <div className="hr-int" key={k}>
                    {/* Заголовок с «убрать» — только когда интервалов больше
                        одного: единственный интервал убирать некуда. */}
                    {ranges.length > 1 && (
                      <div className="hr-int-head">
                        <p className="hr-int-name">{t('schedule.intervalN').replace('{n}', String(k + 1))}</p>
                        <button type="button" className="hr-link" onClick={() => setRanges(ranges.filter((_, m) => m !== k))}>
                          {t('schedule.removeRange')}
                        </button>
                      </div>
                    )}
                    <RangeEditor
                      id={`${props.idPrefix}-r${i}-${k}`}
                      range={range}
                      // Рейсы — только у единственного интервала: окно с маркером
                      // должно быть единственным в своём дне (`windowsProblem`,
                      // 'markerBeside'), так что при двух интервалах кнопки
                      // «Первый/Последний рейс» вели бы к отказу сервера.
                      // Зеркало `canAddRange`, которая не даёт добавить второй
                      // интервал к маркерному.
                      options={{ ...options, flightBounds: options.flightBounds && ranges.length === 1 }}
                      // Только последнее правило, только его первый диапазон —
                      // именно туда переезжает фокус, когда список правил растёт
                      // (I5, см. эффект выше).
                      fromRef={i === rules.length - 1 && k === 0 ? lastFromInputRef : undefined}
                      onChange={(next) => setRanges(ranges.map((x, m) => (m === k ? next : x)))}
                    />
                  </div>
                ))}
                {canAddRange(ranges) && (
                  <button
                    type="button"
                    className="hr-link hr-add-int"
                    onClick={() => {
                      const start = nextWindowStart(ranges.map((x) => ({ from: x.from, to: x.to })))
                      if (start) setRanges([...ranges, { from: start, to: null }])
                    }}
                  >
                    {t('schedule.addBreak')}
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}

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
