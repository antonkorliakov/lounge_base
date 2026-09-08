'use client'

import type React from 'react'
import { END_OF_DAY, nextWindowBlockedReason, nextWindowStart, type Window } from '@/form-schema'
import { useLocale } from '@/i18n/context'

/**
 * Интервалы ОДНОГО дня (или одного графика уборки). Правил здесь нет: порядок,
 * непересечение и полнота живут в `schedule.ts` и проверяются сервером; этот
 * компонент только показывает список и отдаёт наверх новый массив.
 *
 * Новый интервал появляется с `to: null` — незакрытым. Так и задумано: отказ
 * на полпути набора уносил бы черновик, поэтому незакрытый интервал
 * сохраняется, а отправку держит правило полноты (`windowsFinished`).
 */
export function WindowsEditor(props: {
  windows: Window[]
  onChange: (windows: Window[]) => void
  /** Префикс id для связки label с полем: ключ поля плюс день, чтобы на
   *  странице с семью днями и двумя расписаниями id не столкнулись. */
  idPrefix: string
}): React.JSX.Element {
  const { t } = useLocale()
  const { windows, onChange } = props
  const nextStart = nextWindowStart(windows)
  const blockedReason = nextWindowBlockedReason(windows)

  const replace = (index: number, window: Window): void => {
    onChange(windows.map((current, position) => (position === index ? window : current)))
  }

  return (
    <div className="wh-windows">
      {windows.map((window, index) => {
        const id = `${props.idPrefix}-w${index}`
        const endOfDay = window.to === END_OF_DAY
        return (
          <div className="wh-window" key={index}>
            <label htmlFor={`${id}-from`}>{t('schedule.from')}</label>
            <input
              id={`${id}-from`}
              type="time"
              step={300}
              value={window.from}
              onChange={(e) => replace(index, { ...window, from: e.target.value })}
            />
            <label htmlFor={`${id}-to`}>{t('schedule.to')}</label>
            <input
              id={`${id}-to`}
              type="time"
              step={300}
              // `<input type="time">` не принимает 24:00 — при таком значении
              // поле осталось бы пустым, и «работаем до полуночи» выглядело бы
              // как незаполненный конец. Поэтому конец суток живёт нажатой
              // кнопкой рядом, а поле в это время пустое и выключено.
              value={endOfDay ? '' : (window.to ?? '')}
              disabled={endOfDay}
              onChange={(e) => replace(index, { ...window, to: e.target.value === '' ? null : e.target.value })}
            />
            {/* `.chip-row` несёт то же правило нажатости `[aria-pressed='true']`,
                что и `.avail-toggle` (см. globals.css) — кнопка получает
                общий вид нажатого чипа без второй копии цветового правила. */}
            <span className="chip-row">
              <button
                type="button"
                aria-pressed={endOfDay}
                onClick={() => replace(index, { ...window, to: endOfDay ? null : END_OF_DAY })}
              >
                {t('schedule.untilEndOfDay')}
              </button>
            </span>
            <button
              type="button"
              className="wh-drop"
              aria-label={t('schedule.removeWindow')}
              onClick={() => onChange(windows.filter((_, position) => position !== index))}
            >
              ×
            </button>
            {/* I4: факт о ЗНАЧЕНИИ интервала (`to === null`), видимый
                безусловно — не только когда отправка отказала. Это
                избавляет от необходимости тащить состояние отправки внутрь
                редактора ради одной сетки (см. WeekHoursEditor's
                `dayUnanswered`, тот же приём для дня целиком). */}
            {window.to === null && (
              <p className="field-hint wh-window-unfinished">{t('schedule.windowUnfinished')}</p>
            )}
          </div>
        )
      })}
      <button
        type="button"
        className="wh-add"
        // `aria-disabled`, НЕ `disabled` (Important 1, сквозное ревью):
        // `disabled` убирает кнопку из таб-порядка, и тогда причина рядом с
        // ней (см. `blockedReason` ниже) недостижима — ни клавиатурой, ни
        // скринридером, который эту кнопку вообще не озвучит. Обработчик
        // остаётся сторожем сам по себе (`nextStart !== null &&`) — клик по
        // недоступной кнопке по-прежнему ничего не делает, недоступность
        // здесь чисто визуальная и структурная, не функциональная преграда.
        aria-disabled={nextStart === null}
        onClick={() => nextStart !== null && onChange([...windows, { from: nextStart, to: null }])}
      >
        {t('schedule.addWindow')}
      </button>
      {/* Обе причины — `nextWindowBlockedReason` в schedule.ts, эта разметка
          не решает, когда именно кнопка недоступна, только называет ЧЬЮ из
          двух причин та уже назвала: раньше `nextWindowStart` отдавал один
          `null` на обе, и ни на экране, ни в дереве доступности не было
          ничего, что объясняло бы выключенную кнопку с первого мгновения
          после «По часам» (первый интервал сразу не закрыт). */}
      {blockedReason && (
        <p className="field-hint wh-add-reason">
          {t(blockedReason === 'unfinished' ? 'schedule.finishPrevious' : 'schedule.dayIsFull')}
        </p>
      )}
    </div>
  )
}
