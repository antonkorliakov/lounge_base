'use client'

import { useState } from 'react'
import { useLocale } from '@/i18n/context'
import { FLAG_REASON_LABELS } from '@/i18n/dictionaries'
import type { FlagReason } from '@/review/flags'

/**
 * Коды замечаний для чипов — ВЫВЕДЕНЫ из подписей, а не перечислены здесь.
 *
 * Раньше на этом месте стоял массив `{ id: FlagReason; en; ru }[]` с
 * перечисленными от руки четырьмя кодами и их подписями — рядом с
 * `FLAG_REASONS` (`@/review/flags`), который эта ветка уже сделала
 * единственным источником кодов. Тот тип отвергает НЕВЕРНЫЙ id, но не
 * пропущенный: пятый код компилировался бы молча, не появлялся бы среди чипов
 * вовсе (то есть проверяющий не смог бы его выбрать), а уже стоящее замечание
 * с этим кодом рисовалось бы общей подписью «Flag» — причина, выбранная
 * проверяющим, доходила бы до оператора как отсутствие причины.
 *
 * Подписи теперь живут в `@/i18n/dictionaries` (`FLAG_REASON_LABELS`,
 * `satisfies Record<FlagReason, Localized>` — пятый код в `FLAG_REASONS` ломает
 * компиляцию там, плюс тест `src/i18n/__tests__/dictionaries.test.ts` идёт от
 * самого массива в рантайме). Один экземпляр на обе стороны анкеты: те же
 * подписи читает заполняющий на экране правок (`FixesOnly`). Здесь остаётся
 * только порядок чипов — и он тоже не отдельный список, а порядок ключей той
 * карты.
 */
const REASON_IDS = Object.keys(FLAG_REASON_LABELS) as FlagReason[]

export type ExistingFlag = { id: string; reason: FlagReason | null; comment: string }

/**
 * Кнопка «отметить» проявляется по наведению на устройствах с мышью — в
 * покое она скрыта, иначе кнопки рябят на каждой из сотен строк. Наведения
 * не существует на touch-устройстве, поэтому видимость по `:hover`
 * ограничена в CSS медиа-запросом `(hover: hover) and (pointer: fine)`
 * (см. `globals.css`, `.frow-act`): на touch и при клавиатурной фокусировке
 * кнопка всегда видима — иначе на планшете у ревьюера не было бы способа
 * узнать, что кнопка существует, кроме случайного тапа мимо неё.
 */
export function FieldRow(props: {
  label: string
  value: string
  /**
   * Только для фото-слотов (см. `ReviewScreen.tsx`, блок `kind: 'photos'`).
   * `undefined` — обычное поле/позиция услуг, показывается `value` как текст,
   * как и раньше. Объект — фото-слот: показывается галерея миниатюр или
   * отметка о пустом слоте, а `value` игнорируется.
   *
   * `required` приходит из схемы через `ReviewScreen` (`PHOTO_SLOTS`) и решает
   * только одно: писать ли «нет фото» на пустом слоте. Сторона заполнения
   * спрашивает снимок исключительно у обязательных слотов
   * (`PhotoSlots.tsx`'s `slot.required &&`), а сторона проверки писала «нет
   * фото» у любого пустого — включая `additional` (`required: false`). Слово
   * «нет фото» на необязательном слоте читается как недоделка, и ревьюер мог
   * отметить `empty` оператору, который всё сделал правильно; хуже того, две
   * стороны одной анкеты расходились в том, что вообще считается пропуском.
   *
   * Раньше `renderValues` схлопывал URL до счётчика ("3"), и это была
   * единственная информация, которую получал ревьюер об одном из 27
   * подтверждаемых блоков — притом блоке, для которого дизайн явно разрешает
   * отмечать отдельный слот замечанием. Отметить снимок, не видя его,
   * невозможно: ревьюер должен убедиться, что вход на фото — действительно
   * вход, что стойка регистрации видна, что ориентиры совпадают с
   * письменными инструкциями (`III.5.1`/`III.5.5`) — a bare count answers
   * none of that.
   */
  photos?: { urls: string[]; required: boolean }
  flag: ExistingFlag | null
  /**
   * Предлагать ли отметить этот ответ. Готовый ответ от `ReviewScreen`
   * (`state.flagging` из `@/app/admin/s/[submissionId]/gates`), а не статус
   * анкеты: строка о правилах перехода анкеты знать не должна — тот же приём,
   * что и `photos.required` выше.
   *
   * `false` — кнопки нет совсем, а не выключена: причина одна на весь экран и
   * стоит в подписи состояния наверху, а до 58 выключенных кнопок с одинаковым
   * `title` в одном блоке — это шум. Уже стоящее замечание при этом
   * по-прежнему видно, и снять его по-прежнему можно: снятие только убавляет
   * состояние и ввести в заблуждение оператора не может.
   */
  canFlag: boolean
  onRaise: (reason: FlagReason | null, comment: string) => void
  onResolve: (flagId: string) => void
}): React.JSX.Element {
  const { locale, t, pick } = useLocale()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<FlagReason | null>(null)
  const [comment, setComment] = useState('')

  /**
   * URL-ы, картинка по которым не загрузилась. Без этого состояния мёртвая
   * ссылка рисуется как рамка 120×120 с браузерным значком битой картинки, а
   * `alt` внутри `line-height: 0` (см. `globals.css`, `.frow-photo`) не
   * читается как текст — то есть ревьюер не может отличить «файла больше нет»
   * от «оператор снял белую стену» и отметит оператора за второе, когда правда
   * первое. Когда это писалось, в dev в таком состоянии была КАЖДАЯ миниатюра:
   * `scripts/seed-dev.ts` сеял `https://example.com/seed/<slot>.jpg`, что
   * картинкой не отдаётся. Сид с тех пор кладёт настоящий файл в `public/seed/`
   * (см. `seedPhotoUrl`), так что на засеянной анкете эта ветка появляться не
   * должна — а если появилась, дело в самих данных.
   *
   * Плитка заменяется явной надписью, но остаётся ссылкой: открыть URL —
   * первое, чем проверяют, дело в файле или в сети. Ссылка ведёт туда же, куда
   * и `src` картинки, поэтому URL со схемой, навигацию на которую браузер
   * запрещает (`data:` — именно такой: Chrome и Firefox блокируют переход
   * верхнего уровня на него), делает клик ТИХО неработающим: `onError` не
   * срабатывает, до этой надписи дело не доходит, и плитка выглядит
   * совершенно нормальной. Поэтому сид и кладёт файл, а не `data:`-URL.
   */
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const markFailed = (url: string): void =>
    setFailed((prev) => new Set(prev).add(url))

  // Миниатюра, а не голая ссылка на каждое из пяти фото (утомительно
  // открывать по одной) и не голая ссылка без превью (недостаточно, чтобы
  // узнать вход по картинке размером 40 пикселей). Плитка 160×120 даёт узнать
  // сцену на глаз; клик открывает оригинал в новой вкладке для полной
  // проверки — тот же компромисс, что и в галереях фотоприложений.
  const valueArea =
    props.photos === undefined ? (
      props.value
    ) : props.photos.urls.length === 0 ? (
      // На необязательном слоте пусто — это не пропуск, и «нет фото» там
      // означало бы претензию. Прочерк — тот же знак «ответа нет», каким
      // размечены все незаполненные поля экрана (см. `renderValues`).
      <p className="field-hint">{props.photos.required ? t('photos.missing') : '—'}</p>
    ) : (
      <div className="frow-photos">
        {props.photos.urls.map((url, index) =>
          failed.has(url) ? (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="frow-photo frow-photo-dead"
            >
              {t('photos.loadFailed')}
            </a>
          ) : (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="frow-photo">
              {/* Номер в `alt`: у `additional` в слоте несколько снимков, и
                  без номера пользователь скринридера слышит три ссылки с
                  одинаковым именем «Additional Photos» без способа их
                  различить. */}
              <img
                src={url}
                alt={`${props.label} ${index + 1}`}
                loading="lazy"
                onError={() => markFailed(url)}
              />
            </a>
          ),
        )}
      </div>
    )

  if (props.flag) {
    return (
      <div className="frow frow-flagged">
        <div className="frow-key">{props.label}</div>
        <div className="frow-value">
          {valueArea}
          <div className="frow-comment">
            <b>
              {/* Общая подпись остаётся ровно для одного случая — замечания
                  БЕЗ кода: `raiseFlag` принимает `reason: null` (проверяющий
                  может ничего не выбрать), и это не пропущенный код, а
                  отсутствие кода. Неизвестного кода здесь быть не может:
                  `toFlagReason` (`@/review/flags`) сужает всё, чего нет в
                  `FLAG_REASONS`, к `null` ещё при чтении из базы. */}
              {props.flag.reason
                ? pick(FLAG_REASON_LABELS[props.flag.reason])
                : locale === 'ru' ? 'Замечание' : 'Flag'}
            </b>
            {props.flag.comment}
            <button
              type="button"
              className="frow-undo"
              onClick={() => props.onResolve(props.flag!.id)}
            >
              {locale === 'ru' ? 'снять замечание' : 'resolve'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="frow">
      <div className="frow-key">{props.label}</div>
      <div className="frow-value">
        {valueArea}
        {open && (
          <div className="frow-editor">
            <div className="frow-chips">
              {REASON_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`chip ${reason === id ? 'chip-on' : ''}`}
                  onClick={() => setReason(reason === id ? null : id)}
                >
                  {pick(FLAG_REASON_LABELS[id])}
                </button>
              ))}
            </div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={locale === 'ru' ? 'Что не так?' : 'What is wrong?'}
            />
            <div className="frow-actions">
              <button
                type="button"
                className="bt-flag"
                disabled={comment.trim() === ''}
                onClick={() => {
                  props.onRaise(reason, comment)
                  setOpen(false)
                  setComment('')
                  setReason(null)
                }}
              >
                {locale === 'ru' ? 'Отметить' : 'Flag'}
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                {locale === 'ru' ? 'Отмена' : 'Cancel'}
              </button>
            </div>
          </div>
        )}
      </div>
      {props.canFlag && (
        <button type="button" className="frow-act" onClick={() => setOpen(true)}>
          {locale === 'ru' ? 'отметить' : 'flag'}
        </button>
      )}
    </div>
  )
}
