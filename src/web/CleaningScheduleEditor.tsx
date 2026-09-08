'use client'

import type React from 'react'
import {
  CADENCES,
  CLEANING_DAY_OPTIONS,
  NTHS,
  WEEKDAYS,
  cleaningProblem,
  switchCadence,
  type Cadence,
  type CleaningSchedule,
  type Nth,
  type Weekday,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { WindowsEditor } from './WindowsEditor'
import { WeekHoursEditor } from './WeekHoursEditor'

/** Подписи периодичности и порядкового номера — в интерфейсе, а не в
 *  `schedule.ts`: там живут подписи КАНОНИЧЕСКОГО текста (короткие, для файла
 *  и экрана проверки), здесь — подписи кнопок. Совпадать они не обязаны, и
 *  сведение их в одну таблицу связало бы формулировку файла с формулировкой
 *  кнопки. */
const CADENCE_BUTTON: Record<Cadence, { en: string; ru: string }> = {
  daily: { en: 'Daily', ru: 'Ежедневно' },
  weekly: { en: 'Weekly', ru: 'Еженедельно' },
  monthly: { en: 'Monthly', ru: 'Ежемесячно' },
  quarterly: { en: 'Quarterly', ru: 'Ежеквартально' },
}

const NTH_BUTTON: Record<string, { en: string; ru: string }> = {
  '1': { en: '1st', ru: '1-й' }, '2': { en: '2nd', ru: '2-й' }, '3': { en: '3rd', ru: '3-й' },
  '4': { en: '4th', ru: '4-й' }, last: { en: 'last', ru: 'последний' },
}

/** Сохранённое значение → расписание. Старый свободный текст остаётся
 *  текстом (см. `asWeek` в `WeekHoursEditor.tsx` — тот же приём и та же
 *  причина).
 *
 *  `cleaningProblem(value) === 'empty'` — законная форма, не порча: это
 *  ровно то состояние, в которое попадает оператор через мгновение после
 *  выбора периодичности (`switchCadence(null, 'daily')` и аналоги для
 *  `monthly`/`quarterly` дают `{ cadence, windows: [] }`), и то же
 *  состояние остаётся после снятия «×» у последнего интервала. Прятать его
 *  значило бы, что нажатие кнопки «Daily» выглядит так, будто ничего не
 *  произошло: ни одна кнопка периодичности не подсвечена, ни список
 *  интервалов (а для monthly/quarterly — ни выбор «какой по счёту» и дня
 *  недели) не появляется, хотя `onChange` уже отправил корректное значение.
 *  Для `weekly` тот же тег `'empty'` в принципе недостижим на нетронутой
 *  сетке: `weekHoursProblem({}, …)` возвращает `null` (сетка без единого
 *  дня — это ещё не проблема, см. её комментарий), пустой список интервалов
 *  внутри отдельного дня — уже дело `dayHoursProblem`/`asWeek`, которая сама
 *  решает, что делать с таким днём. Этот разбор ветки затрагивает только
 *  периодичности с общим списком интервалов (`daily`/`monthly`/`quarterly`).
 *
 *  Любой другой тег (`'cadence'`, `'shape'`, `'nth'`, `'day'` и т.п.) — это
 *  по-прежнему не расписание: значение либо отсутствует, либо действительно
 *  не разобрать, и тогда честнее показать четыре кнопки без нажатой, чем
 *  выдать требуемую форму за то, что было сохранено. */
function asSchedule(value: unknown): { schedule: CleaningSchedule | null; legacy: string | null } {
  if (typeof value === 'string' && value.trim() !== '') return { schedule: null, legacy: value }
  const problem = cleaningProblem(value)
  if (problem !== null && problem !== 'empty') return { schedule: null, legacy: null }
  return { schedule: value as CleaningSchedule, legacy: null }
}

export function CleaningScheduleEditor(props: {
  value: unknown
  onChange: (schedule: CleaningSchedule) => void
  idPrefix: string
}): React.JSX.Element {
  const { t, pick } = useLocale()
  const { schedule, legacy } = asSchedule(props.value)

  return (
    <div className="wh">
      {legacy !== null && (
        <div className="wh-legacy">
          <p className="wh-legacy-value">{legacy}</p>
          <p className="field-hint">{t('form.freeFormAnswer')}</p>
        </div>
      )}

      <span className="wh-day">{t('schedule.cadence')}</span>
      <span className="chip-row" role="group" aria-label={t('schedule.cadence')}>
        {CADENCES.map((cadence) => (
          <button
            key={cadence}
            type="button"
            aria-pressed={schedule?.cadence === cadence}
            // Перенос интервалов при смене — правило схемы (`switchCadence`),
            // не решение кнопки: она передаёт туда текущее значение и кладёт
            // обратно то, что вернули.
            onClick={() => props.onChange(switchCadence(schedule, cadence))}
          >
            {pick(CADENCE_BUTTON[cadence])}
          </button>
        ))}
      </span>

      {schedule?.cadence === 'weekly' && (
        <WeekHoursEditor
          value={schedule.days}
          options={CLEANING_DAY_OPTIONS}
          idPrefix={props.idPrefix}
          onChange={(days) => props.onChange({ cadence: 'weekly', days })}
        />
      )}

      {(schedule?.cadence === 'monthly' || schedule?.cadence === 'quarterly') && (
        <div className="wh-window">
          <label htmlFor={`${props.idPrefix}-nth`}>{t('schedule.nth')}</label>
          <select
            id={`${props.idPrefix}-nth`}
            value={String(schedule.nth)}
            onChange={(e) =>
              props.onChange({ ...schedule, nth: (e.target.value === 'last' ? 'last' : Number(e.target.value)) as Nth })
            }
          >
            {NTHS.map((nth) => (
              <option key={String(nth)} value={String(nth)}>{pick(NTH_BUTTON[String(nth)]!)}</option>
            ))}
          </select>
          <label htmlFor={`${props.idPrefix}-weekday`}>{t('schedule.weekday')}</label>
          <select
            id={`${props.idPrefix}-weekday`}
            value={schedule.weekday}
            onChange={(e) => props.onChange({ ...schedule, weekday: e.target.value as Weekday })}
          >
            {WEEKDAYS.map((day) => (
              <option key={day} value={day}>{t(`schedule.day.${day}`)}</option>
            ))}
          </select>
        </div>
      )}

      {schedule && schedule.cadence !== 'weekly' && (
        <WindowsEditor
          windows={schedule.windows}
          idPrefix={props.idPrefix}
          onChange={(windows) => props.onChange({ ...schedule, windows })}
        />
      )}
    </div>
  )
}
