'use client'

import { useState } from 'react'
import type { Field, Localized, ServiceItem, ServiceValueInput } from '@/form-schema'
import type { AirportSearchResult } from '@/registry/directory'
import { useLocale } from '@/i18n/context'
import { FLAG_REASON_LABELS } from '@/i18n/dictionaries'
import type { FlagReason } from '@/review/flags'
import { FieldInput } from './FieldInput'
import { IataCorrection } from './IataCorrection'
import { ServiceItemCard } from './ServiceItemCard'

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
 * Чем строка правится, если её вообще можно править, — ГОТОВЫЙ ответ от
 * `ReviewScreen` (тот же приём, что `photos.required` и `canFlag` ниже:
 * компонент получает решение, а не правила его принятия). Виды повторяют
 * серверные ворота `editAnswerDuringReview` (`src/review/edit.ts`) —
 * клиентский показ обязан не предлагать того, в чём сервер откажет:
 *
 *  - `field` — обычный редактор поля (`FieldInput`, тот же контрол, что у
 *    заполняющего, не вторая копия);
 *  - `iata` — код правится ТОЛЬКО выбором из справочника (`IataCorrection`,
 *    поиск — действие кабинета `searchAirportsAction`); сервер перепишет и
 *    производную тройку;
 *  - `derived` — производные I.7–I.9 не правятся напрямую нигде: карандаш
 *    открывает записку «выводится из кода» (`form.derivedFromCode`);
 *  - `service` — карточка позиции целиком (`ServiceItemCard`,
 *    `withAvailability` — как на экране правок: замечание адресует позицию
 *    целиком, и правка команды тоже);
 *  - `photo` — записка `review.photoNotEditable`: серверного пути правки
 *    фото у команды не существует.
 */
export type EditTarget =
  | { kind: 'field'; field: Field; value: unknown }
  | {
      kind: 'iata'
      field: Field
      value: unknown
      search: (query: string) => Promise<AirportSearchResult>
    }
  | { kind: 'derived' }
  | { kind: 'service'; item: ServiceItem; value: ServiceValueInput | undefined }
  | { kind: 'photo' }

/**
 * Итог правки, который строка ждёт от `onEdit`, — ровно форма `ActionResult`
 * (`src/app/admin/s/[submissionId]/actions.ts`; тип повторён здесь, а не
 * импортирован: клиентскому компоненту незачем тянуть модуль серверных
 * действий ради двух строк типа). Редактор закрывается ТОЛЬКО на `ok: true`:
 * отказ сервера оставляет черновик на месте и показывает причину внутри
 * самого редактора — теми же `error`-пропсами `FieldInput`/`ServiceItemCard`/
 * `IataCorrection`, какими та же причина стоит у оператора. Прежде редактор
 * закрывался синхронно, до ответа: отказ уносил черновик (повторное открытие
 * пересеивало сохранённое значение), а причина падала в подвал блока без
 * ключа — целиком перезаполненная карточка услуги пропадала из-за «Price is
 * required».
 */
export type EditOutcome = { ok: true } | { ok: false; error: Localized }

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
  /**
   * Последнюю правку этого ответа внесла команда (`edited_by`, см.
   * `RenderedCell.editedByTeam`) — строка несёт значок «исправлено
   * командой». Тем же текстом (`answer.teamEdited`) значок читает оператор
   * на своей стороне: один факт — одни слова.
   */
  editedByTeam?: boolean
  /**
   * Хранимое значение этого ответа — старая свободная строка прежней версии
   * анкеты (`RenderedCell.freeFormAnswer`, вычисляется в `renderValues.ts`),
   * ещё не введённая структурой. Строка печатается дословно
   * (`formatWeekHours`/`formatCleaning`'s `isLegacyText`) и на вид не
   * отличается от обычного ответа, хотя `fieldAnswered` уже считает поле
   * неотвеченным — без значка ревьюер не может понять почему (Important 3,
   * сквозное ревью).
   */
  freeFormAnswer?: boolean
  /**
   * Чем эта строка правится (см. `EditTarget` выше); `undefined` — карандаша
   * нет вовсе (решения по анкете сейчас недоступны — причина одна на весь
   * экран и стоит в подписи состояния, тот же выбор, что у `canFlag`).
   */
  edit?: EditTarget
  /** Отправить новое значение (для `field`/`service` — черновик редактора,
   *  для `iata` — код выбранного ряда) и вернуть итог действия (см.
   *  `EditOutcome` выше: закрытие редактора — только на успех). У
   *  `derived`/`photo` не вызывается: их «редактор» — записка. */
  onEdit?: (value: unknown) => Promise<EditOutcome>
}): React.JSX.Element {
  const { locale, t, pick } = useLocale()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<FlagReason | null>(null)
  const [comment, setComment] = useState('')

  // Редактор правки — состояние своё, независимое от композера замечания:
  // черновики инициализируются в момент открытия (см. `openEditor`), а не в
  // useState — карандаш можно открывать повторно, и каждый раз он обязан
  // стартовать от ТЕКУЩЕГО значения строки, не от прошлогоднего черновика.
  const [editOpen, setEditOpen] = useState(false)
  const [fieldDraft, setFieldDraft] = useState<unknown>(undefined)
  const [serviceDraft, setServiceDraft] = useState<ServiceValueInput | undefined>(undefined)
  /** Отказ ПОСЛЕДНЕЙ попытки сохранить эту правку — живёт внутри редактора,
   *  у самого значения (см. `EditOutcome`). Сбрасывается на открытии (новая
   *  сессия правки — чистый лист) и на успехе. */
  const [editError, setEditError] = useState<Localized | null>(null)

  function openEditor(): void {
    if (!props.edit) return
    if (props.edit.kind === 'field' || props.edit.kind === 'iata') {
      setFieldDraft(props.edit.value)
    }
    if (props.edit.kind === 'service') setServiceDraft(props.edit.value)
    setEditError(null)
    setEditOpen(true)
  }

  async function saveEdit(): Promise<void> {
    if (!props.edit || !props.onEdit) return
    const result = await props.onEdit(props.edit.kind === 'service' ? serviceDraft : fieldDraft)
    // Закрытие — ТОЛЬКО на успех. Прежде редактор закрывался синхронно, до
    // ответа, «как композер замечания» — но у замечания нет серверной
    // валидации, которой есть что отказать, а у правки есть: отказ уносил
    // черновик, и причина падала в подвал блока без ключа (см. `EditOutcome`).
    if (result.ok) {
      setEditError(null)
      setEditOpen(false)
      return
    }
    setEditError(result.error)
  }

  /**
   * Выбранная причина — САМА ПО СЕБЕ полное замечание (то же правило, что у
   * `raiseFlag`): экран правок показывает её код заметно (`FixesOnly`,
   * `FLAG_REASON_LABELS`), так что «не заполнено» без текста полностью
   * понятно оператору. Раньше кнопка «Отметить» требовала комментарий
   * всегда, но нигде об этом не говорила — клик по чипу «ничего не делал» с
   * точки зрения проверяющего, потому что выключенная кнопка своим розовым
   * выглядела нажимаемой (см. `.bt-flag:disabled` в globals.css). Пока не
   * выбрано и не написано ничего, под кнопками стоит подсказка — теми же
   * словами, какими отказал бы сервер.
   */
  const complete = reason !== null || comment.trim() !== ''

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

  // Значок провенанса — над значением, в колонке значения: он описывает
  // ЗНАЧЕНИЕ («последняя правка — команды»), а не строку целиком. Оба значка
  // могут стоять одновременно (команда могла в принципе записать строку
  // напрямую) — они про РАЗНЫЕ факты и не гасят друг друга.
  const badge = props.editedByTeam ? (
    <p className="team-badge">{t('answer.teamEdited')}</p>
  ) : null
  // I3: тот же приём для другого факта — «это старая свободная строка,
  // введите структурой» (см. `RenderedCell.freeFormAnswer`). Своя цветовая
  // пара, не синяя `.team-badge`: это не провенанс, а напоминание о
  // незавершённости ответа, тот же смысл, что у янтарного `.fix-open`.
  const freeFormBadge = props.freeFormAnswer ? (
    <p className="team-badge freeform-badge">{t('review.freeFormAnswer')}</p>
  ) : null

  // Карандаш — та же механика проявления, что у «отметить» (`.frow-act`:
  // hover на мыши, всегда видим на touch/фокусе — см. globals.css). Свой
  // класс `.frow-editbtn` — для адресации в e2e, тем же приёмом, что
  // `.frow-act` у кнопки замечания (имена «править»/«отметить» с ролью
  // кнопки различимы, но класс не зависит от локали).
  const pencil = props.edit && (
    <button type="button" className="frow-act frow-editbtn" onClick={openEditor}>
      {locale === 'ru' ? 'править' : 'edit'}
    </button>
  )

  const editor = editOpen && props.edit && (
    <div className="frow-editor">
      {props.edit.kind === 'derived' && (
        // Записка вместо редактора: тройка правится кодом — теми же словами,
        // какими это объясняется оператору (`form.derivedFromCode`).
        <p className="field-hint">{t('form.derivedFromCode')}</p>
      )}
      {props.edit.kind === 'photo' && (
        <p className="field-hint">{t('review.photoNotEditable')}</p>
      )}
      {props.edit.kind === 'field' && (
        <FieldInput
          field={props.edit.field}
          value={fieldDraft}
          onChange={setFieldDraft}
          error={editError ? pick(editError) : undefined}
          // Это ответ ЛАУНЖА, а не проверяющего — браузер не должен
          // предлагать свои сохранённые контакты поверх него (см.
          // `noAutofill`'s WHY comment in FieldInput.tsx).
          noAutofill
        />
      )}
      {props.edit.kind === 'iata' && (
        // Выбор из справочника ЕСТЬ сохранение (как на стороне заполнения):
        // отдельной кнопки «Сохранить» у этого вида нет. Закрытие — только
        // на успех (см. `EditOutcome`): до сервера здесь доезжает и гонка
        // (анкету решили в соседней вкладке), и её отказ обязан остаться
        // у контрола, а не пропасть вместе с редактором.
        <IataCorrection
          field={props.edit.field}
          value={props.edit.value}
          onPick={(row) => {
            void (async () => {
              const result = await props.onEdit?.(row.iata)
              if (!result || result.ok) {
                setEditError(null)
                setEditOpen(false)
                return
              }
              setEditError(result.error)
            })()
          }}
          search={props.edit.search}
          error={editError ? pick(editError) : undefined}
        />
      )}
      {props.edit.kind === 'service' && (
        <ServiceItemCard
          item={props.edit.item}
          value={serviceDraft}
          onChange={setServiceDraft}
          withAvailability
          error={editError ? pick(editError) : undefined}
        />
      )}
      <div className="frow-actions">
        {(props.edit.kind === 'field' || props.edit.kind === 'service') && (
          <button type="button" className="bt-save" onClick={() => void saveEdit()}>
            {locale === 'ru' ? 'Сохранить' : 'Save'}
          </button>
        )}
        <button type="button" onClick={() => setEditOpen(false)}>
          {locale === 'ru' ? 'Отмена' : 'Cancel'}
        </button>
      </div>
    </div>
  )

  if (props.flag) {
    return (
      <div className="frow frow-flagged">
        <div className="frow-key">{props.label}</div>
        <div className="frow-value">
          {badge}
          {freeFormBadge}
          {valueArea}
          {editor}
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
        {/* Карандаш есть и на отмеченной строке: обычный ход ревьюера —
            «отметил, подумал, исправил сам»; правка снимает замечание на
            сервере (`editAnswerDuringReview` → `clearFlagsFor`). */}
        {pencil}
      </div>
    )
  }

  return (
    <div className="frow">
      <div className="frow-key">{props.label}</div>
      <div className="frow-value">
        {badge}
        {freeFormBadge}
        {valueArea}
        {editor}
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
                disabled={!complete}
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
            {!complete && (
              <p className="field-hint">
                {locale === 'ru'
                  ? 'Выберите причину или напишите, что не так'
                  : 'Pick a reason or write what is wrong'}
              </p>
            )}
          </div>
        )}
      </div>
      {/* Обе кнопки действий — колонкой в третьей колонке строки
          (`.frow-acts`), чтобы вторая не разъезжалась по ширине ряда. */}
      {(props.canFlag || props.edit) && (
        <div className="frow-acts">
          {props.canFlag && (
            <button type="button" className="frow-act" onClick={() => setOpen(true)}>
              {locale === 'ru' ? 'отметить' : 'flag'}
            </button>
          )}
          {pencil}
        </div>
      )}
    </div>
  )
}
