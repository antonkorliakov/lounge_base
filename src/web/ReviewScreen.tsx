'use client'

import { useRef, useState } from 'react'
import { BLOCKS, PHOTO_SLOTS, type Localized } from '@/form-schema'
import type { RenderedCell } from './renderValues'
import type { BlockState } from '@/review/blocks'
import type { FlagRow, FlagReason } from '@/review/flags'
import { useLocale } from '@/i18n/context'
import { keysOfBlock } from '@/review/blocks'
import { BlockNav } from './BlockNav'
import { FieldRow } from './FieldRow'
import { FillLinkReveal } from './FillLinkReveal'
import {
  flagAction, unflagAction, confirmBlockAction, unconfirmBlockAction,
  requestChangesAction, approveAction, copyFillLinkAction,
  type FillLinkActionResult,
} from '@/app/admin/s/[submissionId]/actions'
// `import type` — стирается при компиляции, так что серверный модуль (а с ним
// `@/submissions/editable`, `@/review/blocks` и `drizzle-orm`) в браузерный
// бандл не попадает; то же соглашение, что у `SubmissionStatus` в
// `FillForm.tsx`.
import type { ReviewState } from '@/app/admin/s/[submissionId]/gates'

/**
 * Обязательность слота — из схемы (`PHOTO_SLOTS`), тем же источником, каким
 * пользуется сторона заполнения (`PhotoSlots.tsx` показывает «нет фото»
 * только при `slot.required`). `FieldRow` сам о слотах ничего не знает и не
 * должен: он получает уже готовый ответ на вопрос «обязателен ли этот слот» —
 * шов узкий, одно поле в уже существующем фото-пропе.
 */
const PHOTO_SLOT_REQUIRED = new Map(PHOTO_SLOTS.map((slot) => [slot.key, slot.required]))

/**
 * Подсказки для двух условий, которые не зависят от статуса анкеты, а значит не
 * приходят в `ReviewState` (см. его `decisions`): они считаются из тех же
 * данных, которые экран и так показывает, — из числа открытых замечаний.
 *
 * Тексты СЛОВО В СЛОВО те, которыми откажут сами транзакции решений
 * (`confirmBlock` в `@/review/blocks`, `requestChanges` в `@/review/decide`) —
 * подсказка обязана называть ту же причину, что и отказ, иначе проверяющий
 * читает два разных объяснения одного правила. Импортировать их оттуда нельзя:
 * там они стоят прямо в аргументах `fail(...)` и наружу не выведены. Это
 * остаточный риск расхождения, названный вслух, а не спрятанный: правило и
 * отказ по-прежнему живут на сервере в одном месте каждый, здесь только
 * подсказка о них.
 */
const BLOCK_HAS_OPEN_FLAGS: Localized = {
  en: 'Resolve the flags in this block first',
  ru: 'Сначала снимите замечания в этом блоке',
}

const NOTHING_FLAGGED: Localized = {
  en: 'Flag at least one answer before sending it back',
  ru: 'Отметьте хотя бы один ответ, прежде чем возвращать',
}

/**
 * Имя кнопки копирования — оно же и подпись для скринридера, и подсказка
 * `title` во включённом состоянии (у выключенной в `title` стоит причина
 * гейта, тем же соглашением, что у остальных кнопок шапки). «На анкету», а не
 * просто «ссылку»: рядом в шапке живёт «Скачать xlsx», и без уточнения два
 * соседних действия читались бы как копирование и скачивание одного и того же.
 */
const COPY_LINK: Localized = { en: 'Copy fill link', ru: 'Скопировать ссылку на анкету' }
const COPIED: Localized = { en: 'Copied', ru: 'Скопировано' }

/** Вступление к плану Б (см. `copyFillLink` ниже): буфер отказал, ссылка уже
 *  выписана — показывается тем же `FillLinkReveal`, что и после возврата на
 *  правку, а notice объясняет, почему она на экране, а не в буфере. */
const CLIPBOARD_FAILED_NOTICE: Localized = {
  en: 'Could not copy to the clipboard — copy the link below yourself:',
  ru: 'Скопировать в буфер обмена не вышло — скопируйте ссылку ниже сами:',
}

/**
 * Чьё действие дало последний отклик — ВСЕЙ АНКЕТЫ или открытого блока. Кнопки
 * разложены по этим же двум местам (решения по анкете — в шапке, пара по блоку
 * — в подвале), и отклик обязан появляться там, откуда действие вызвали, иначе
 * его не видно в момент нажатия: кнопки шапки можно нажать только когда шапка
 * на экране, а подвал прилеплен к низу окна и виден всегда — в том числе из
 * середины списка, где ставятся замечания (поэтому отклик flag/unflag идёт в
 * подвал, а не в шапку, до которой от 58-й строки — целый экран прокрутки).
 */
type FeedbackScope = 'questionnaire' | 'block'

export function ReviewScreen(props: {
  submissionId: string
  /**
   * Какой это лаунж — та же строка, по которой проверяющий пришёл сюда из
   * списка `/admin`, и то же название, которое уходит оператору в письмах
   * (см. `page.tsx`, где сказано, почему из `lounges`, а не из ответа `I.2`).
   * До этого экран не называл анкету никак: по закладке или из второй вкладки
   * нельзя было понять, чью анкету открыли, — при 27 блоках и 129 ответах, из
   * которых название лаунжа один из ответов и сам может быть спорным.
   */
  lounge: { name: string; iata: string }
  /**
   * Состояние анкеты и применимые в нём шаги — готовый ответ, посчитанный на
   * сервере (`reviewStateFor` в `@/app/admin/s/[submissionId]/gates`), а не
   * статус и не правила. Компонент получает решение, а не данные для его
   * принятия: тот же приём, что и у `photos.required` ниже, и здесь по той же
   * причине особенно — правила живут в `REVIEW_STATUSES` (`@/review/blocks`) и
   * `EDITABLE_STATUSES` (`@/submissions/editable`), а их импорт как значений
   * затащил бы `drizzle-orm` в браузерный бандл.
   *
   * Кнопки выключаются, а не исчезают: пропавшая кнопка не объясняет ничего, а
   * выключенная несёт в `title` ту же причину, которую вернуло бы серверное
   * действие, — и та же причина (буквально тот же `Localized`, а не второй
   * текст о том же) стоит видимой строкой в подписи состояния наверху, потому
   * что `title` не существует ни на touch-устройстве, ни для скринридера. Это
   * подсказка, НЕ защита: гейты стоят в самих серверных действиях и
   * транзакциях решений (`confirmBlock`, `requestChanges`,
   * `approveSubmission`, `copyFillLinkAction`, `unconfirmBlockAction`),
   * потому что серверное действие вызывается по сети напрямую и клиентский
   * компонент ему не преграда.
   */
  state: ReviewState
  progress: BlockState[]
  flags: FlagRow[]
  rendered: Record<string, RenderedCell>
  /**
   * URL-ы фото по слоту — отдельно от `rendered`, потому что `rendered`
   * плоский по конструкции (значение — строка, см. `RenderedCell` в
   * `./renderValues.ts`): показать снимок строкой значит показать его
   * счётчик, а не сам снимок (см. отчёт задачи, находка ревьюера "Photos are
   * unreviewable"). `FieldRow` получает эти URL-ы напрямую только для блока
   * `kind: 'photos'` — остальные 26 блоков продолжают идти через `rendered`,
   * как и раньше.
   */
  photos: Record<string, string[]>
}): React.JSX.Element {
  const { locale, pick } = useLocale()
  const [current, setCurrent] = useState(BLOCKS[0]!.key)
  const [error, setError] = useState<Localized | null>(null)
  const [notice, setNotice] = useState<Localized | null>(null)
  const [fillUrl, setFillUrl] = useState<string | null>(null)
  const [feedbackScope, setFeedbackScope] = useState<FeedbackScope>('questionnaire')
  // «Скопировано» у кнопки копирования — краткоживущий отклик УДАВШЕГОСЯ
  // копирования, и только его: отказ действия и отказ буфера идут обычной
  // дорожкой feedback (см. `copyFillLink`). Таймер в ref, а не в state:
  // его смена не повод перерисовываться, а повторное нажатие обязано
  // перезапустить отсчёт, значит прежний таймер нужно уметь снять.
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flagByKey = new Map(props.flags.map((flag) => [flag.fieldKey, flag]))
  const block = BLOCKS.find((b) => b.key === current)!
  const keys = keysOfBlock(current)
  const openInBlock = keys.filter((key) => flagByKey.has(key)).length

  /**
   * Подтверждён ли ОТКРЫТЫЙ СЕЙЧАС блок — читается из того же `progress`,
   * которым размечена навигация, а не из отдельного состояния: кнопка внизу и
   * точка в навигации не могут разойтись, потому что смотрят в одно и то же.
   * Заодно это единственная причина, по которой кнопка «снять подтверждение»
   * не нуждается ни в каком знании о том, КАК `confirmed` посчитан: изменится
   * правило (например, подтверждение перестанет считаться действительным
   * после правки данных) — кнопка сама начнёт снова предлагать подтвердить.
   */
  const decisions = props.state.decisions
  const decisionHint = decisions.allowed ? undefined : pick(decisions.reason)
  const blockConfirmed = props.progress.find((b) => b.blockKey === current)?.confirmed ?? false

  // Тот же приём, что и в `FillForm` (план 1): `error` несёт `Localized`
  // целиком, а не заранее выбранную строку — `pick()` внизу выбирает нужный
  // язык тем же способом, что и подписи блоков. Этот экран сейчас не имеет
  // своего переключателя языка (в отличие от `FillForm`), но тип держит то
  // же соглашение, что и весь остальной код, а не собственный.
  //
  // `notice` — отдельная от `error` дорожка: `ActionResult`'s `ok: true`
  // ветка может нести `notice` (решение состоялось, но письмо не ушло или
  // некому было его отправить — см. `actions.ts`'s собственный комментарий).
  // Смешивать это с `error` означало бы показать успешное действие как
  // отказ, хотя решение уже закоммичено и откатывать его нечем.
  //
  // Тип — `FillLinkActionResult`, потому что «Вернуть на правку» может
  // вернуть успех со ссылкой заполнения
  // (`fillUrl` — только когда почта не доставляет, см. его комментарий в
  // `actions.ts`); остальные возвращают `ActionResult`, который к нему
  // присваиваем. Ссылка, как и `notice`, — свойство ПОСЛЕДНЕГО действия:
  // любой следующий результат её снимает (одноразовость сказана словами в
  // `FillLinkReveal`, а не охраняется удержанием на экране; свежую всегда
  // выдаёт кнопка копирования — токены не отзываются, см. `issueFillToken`).
  // Кнопка копирования ходит НЕ через `run` — см. `copyFillLink` ниже.
  async function run(
    scope: FeedbackScope,
    action: () => Promise<FillLinkActionResult>,
  ): Promise<void> {
    const result = await action()
    setFeedbackScope(scope)
    // Свежий результат гасит и «Скопировано»: это отклик ПРЕДЫДУЩЕГО действия,
    // и пережить следующее он не должен (см. `copyFillLink`).
    setCopied(false)
    if (result.ok) {
      setError(null)
      setNotice(result.notice ?? null)
      setFillUrl(result.fillUrl ?? null)
    } else {
      setNotice(null)
      setFillUrl(null)
      setError(result.error)
    }
  }

  /**
   * Кнопка копирования у названия лаунжа: действие отдаёт свежую ссылку, клиент
   * кладёт её в буфер. НЕ через `run()`: у успеха здесь другой отклик —
   * краткоживущее «Скопировано» у самой кнопки, а не notice в feedback (текст
   * «действие удалось» рядом с местом действия, как у Jira-цепочки, — а не
   * строка ниже ряда решений, которую надо соотнести с нажатым).
   *
   * Отклик последнего действия — по-прежнему один на экран: удавшееся
   * копирование снимает прежние error/notice/ссылку (иначе рядом со свежим
   * «Скопировано» осталась бы, например, вчерашняя ссылка возврата на правку —
   * ДРУГАЯ, не та, что в буфере), а любой следующий результат гасит
   * «Скопировано» — этим же правилом, только в обратную сторону.
   *
   * План Б: `navigator.clipboard.writeText` требует secure context и может
   * отказать (то же знание, что у `FillLinkReveal`). Ссылка к этому моменту
   * уже выписана и существует только здесь — отказ буфера показывает её тем же
   * `FillLinkReveal`, что и возврат на правку: один вид одноразовой ссылки на
   * весь экран, с его собственной кнопкой копирования и планом Б внутри.
   */
  async function copyFillLink(): Promise<void> {
    const result = await copyFillLinkAction(props.submissionId)
    setFeedbackScope('questionnaire')
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    if (!result.ok) {
      setCopied(false)
      setNotice(null)
      setFillUrl(null)
      setError(result.error)
      return
    }
    setError(null)
    try {
      await navigator.clipboard.writeText(result.fillUrl)
      setNotice(null)
      setFillUrl(null)
      setCopied(true)
      copiedTimer.current = setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(false)
      setNotice(CLIPBOARD_FAILED_NOTICE)
      setFillUrl(result.fillUrl)
    }
  }

  // ОДНО представление отклика на оба места (см. `FeedbackScope`): состояние
  // общее — отклик по-прежнему принадлежит ПОСЛЕДНЕМУ действию, и очередной
  // результат снимает предыдущий, в каком бы месте тот ни стоял. Два отдельных
  // состояния (шапке своё, подвалу своё) оставляли бы на экране два отклика
  // разной давности — например, вчерашний отказ подтверждения рядом со
  // свежепринятой анкетой. `fillUrl` приходит только от действий шапки
  // («Вернуть на правку» — см. `FillLinkActionResult` — и план Б кнопки
  // копирования), так что ссылка заполнения в подвале не появится никогда.
  const feedback = (
    <>
      {error && <p className="review-error">{pick(error)}</p>}
      {notice && <p className="review-notice">{pick(notice)}</p>}
      {/* Ссылка заполнения, которой не досталось буфера: письмо её не унесло
          (почта не настроена / отправка упала — возврат на правку) либо буфер
          отказал (план Б кнопки копирования). Вступление к ней — сам `notice`
          выше, у каждого случая свой, поэтому у компонента своего вступления
          нет. `key` обязателен: каждое следующее действие выписывает НОВУЮ
          ссылку, и «Скопировано» прежней не должно её пережить
          (см. `FillLinkReveal`). */}
      {fillUrl && <FillLinkReveal key={fillUrl} url={fillUrl} />}
    </>
  )

  return (
    <div className="review-screen">
      <BlockNav progress={props.progress} current={current} onSelect={setCurrent} />

      <section className="review-pane">
        {/* Чья анкета и в каком она состоянии — до всего остального. Экран
            показывал 27 блоков решений, не называя ни того, ни другого:
            проверяющий B принимал анкету, пока у A открыта вкладка, и A
            продолжал работать, ничего не зная (см. `state` в пропсах). */}
        <header className="review-head">
          {/* Дорога назад. Единственный путь СЮДА — клик по строке реестра,
              но обратного пути экран не давал вовсе: ни ссылки, ни хлебных
              крошек — только кнопка «назад» браузера, о которой надо
              догадаться (найдено пользователем в первый же день на бою).
              Обычная ссылка, не router.back(): после «Вернуть на правку»
              history.back() вернул бы на устаревший список. */}
          <a className="review-back" href="/admin">
            {locale === 'ru' ? '← Все лаунжи' : '← All lounges'}
          </a>
          <h1>
            {props.lounge.name} <span className="review-iata">{props.lounge.iata}</span>
            {/* Ссылка заполнения — в буфер, одним нажатием. Иконка-цепочка у
                самого имени анкеты (жест Jira: цепочка у ключа задачи), а не
                кнопка в ряду решений: копирование ссылки — не решение по
                анкете, оно ничего в ней не меняет. Кнопка выключается по тому
                же гейту, которым отказывает действие (`state.copyLink` —
                ссылка обязана открывать форму), и выключенная несёт причину в
                `title` — соглашение остальных кнопок шапки. `aria-label`
                обязателен: имени-текста у кнопки нет, только глиф.
                SVG — инлайном (глиф «цепочка», две дуги): в проекте нет
                иконочной библиотеки, и один глиф — не повод её заводить. */}
            <button
              type="button"
              className="review-copylink"
              disabled={!props.state.copyLink.allowed}
              aria-label={pick(COPY_LINK)}
              title={
                props.state.copyLink.allowed ? pick(COPY_LINK) : pick(props.state.copyLink.reason)
              }
              onClick={() => void copyFillLink()}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </button>
            {/* role="status" — скринридер узнаёт об успехе так же, как зрячий:
                подпись появляется на 2.5 секунды и гаснет сама (или раньше —
                следующим действием, см. `run`). */}
            {copied && (
              <span className="review-copied" role="status">
                {pick(COPIED)}
              </span>
            )}
            {/* Выгрузка ЭТОЙ анкеты — xlsx в структуре исходного файла
                (`/admin/export/s/[submissionId]`). Обычный `<a>`, не действие:
                файл отдаёт route handler, клиентскому бандлу из серверного
                экспорта ничего не нужно (класс runtime-500 из
                `renderValues.ts` здесь невозможен по построению). Ссылка есть
                В ЛЮБОМ состоянии анкеты, включая черновик: xlsx полупустой
                анкеты — это честный снимок «что уже заполнено», и решать,
                нужен ли он, — человеку, а не экрану. */}
            <a className="review-export" href={`/admin/export/s/${props.submissionId}`}>
              {locale === 'ru' ? 'Скачать xlsx' : 'Download xlsx'}
            </a>
          </h1>
          <p className={`review-state review-state-${props.state.status}`}>
            <b>{pick(props.state.label)}</b> {pick(props.state.note)}
          </p>

          {/* Решения по ВСЕЙ анкете — в шапке, рядом с состоянием анкеты,
              которое они меняют. Раньше они стояли в подвале одним рядом с
              «Подтвердить блок» и выглядели повторяющимися на каждом из 27
              блоков — хотя блок здесь ни при чём (найдено пользователем).
              В подвале остаётся только пара по открытому блоку. */}
          <div className="review-actions">
            <button
              type="button"
              disabled={!decisions.allowed || props.flags.length === 0}
              title={decisionHint ?? (props.flags.length === 0 ? pick(NOTHING_FLAGGED) : undefined)}
              onClick={() => void run('questionnaire', () => requestChangesAction(props.submissionId))}
            >
              {locale === 'ru' ? 'Вернуть на правку' : 'Request changes'} · {props.flags.length}
            </button>
            {/* «Переслать ссылку» здесь БЫЛО и убрано вместе со всей почтовой
                пересылкой: без SMTP кнопка была ритуалом из двух шагов (нажать
                → прочитать «письма не было» → скопировать из показа), а её
                работу одним нажатием делает кнопка копирования у названия
                лаунжа. Временно убран только интерфейс — почтовый хвост
                решений жив, см. `sendFillLink` в actions.ts. */}
            {/* «Принять» выключается ТОЛЬКО по статусу, хотя у неё есть и
                другие условия (все блоки подтверждены, ни одного открытого
                замечания). Это не непоследовательность: те два условия —
                незаконченная работа проверяющего, и отказ действия называет,
                СКОЛЬКО именно блоков осталось и сколько замечаний открыто
                (`approveSubmission`), чего выключенная кнопка сказать не
                может. Статус же не про незаконченную работу: в нём шага не
                бывает вовсе, сколько бы ни подтвердили.

                `shell-primary` — главный утвердительный шаг анкеты несёт тот
                же единственный акцент, что и главная кнопка формы заполнения
                (то же правило, тот же цвет, та же прижимка к правому краю
                ряда через его margin-left: auto), а не второй акцент,
                заведённый для этого экрана. */}
            <button
              type="button"
              className="shell-primary"
              disabled={!decisions.allowed}
              title={decisionHint}
              onClick={() => void run('questionnaire', () => approveAction(props.submissionId))}
            >
              {locale === 'ru' ? 'Принять анкету' : 'Approve'}
            </button>
          </div>

          {/* Отклик действий шапки — прямо под кнопками, которые его вызвали:
              нажать их можно только когда шапка на экране, значит отклик здесь
              виден в момент нажатия без всякой прокрутки. Сюда же приходит
              ссылка заполнения (`FillLinkReveal` внутри `feedback`) — она
              рождается только кнопками этого ряда. */}
          {feedbackScope === 'questionnaire' && feedback}
        </header>

        <h2>{pick(block.label)}</h2>
        {keys.map((key) => {
          const cell = props.rendered[key]
          return (
            <FieldRow
              key={key}
              label={cell?.label ?? key}
              value={cell?.value ?? '—'}
              photos={
                block.kind === 'photos'
                  ? {
                      urls: props.photos[key] ?? [],
                      // `?? true` — только на случай ключа, которого нет в
                      // `PHOTO_SLOTS` (то есть рассогласования схемы:
                      // `blocks.ts` наполняет блок `photos` именно из
                      // `PHOTO_SLOTS`). Тогда слот считается обязательным —
                      // прежнее поведение, и лучше лишний раз спросить про
                      // снимок, чем промолчать о пропущенном.
                      required: PHOTO_SLOT_REQUIRED.get(key) ?? true,
                    }
                  : undefined
              }
              flag={flagByKey.get(key) ?? null}
              // Отмечать ответы предлагается только там, откуда замечание ещё
              // дойдёт до оператора (см. `flagging` в `gates.ts`: возврат на
              // правку или экран правок по его ссылке). На принятой анкете
              // кнопки нет вовсе, а не выключена: строк на экране до 58, и
              // 58 выключенных кнопок с одинаковым `title` — это шум вместо
              // объяснения. Объяснение стоит одной строкой в подписи
              // состояния наверху, тем же текстом (`state.note`).
              canFlag={props.state.flagging.allowed}
              // Отклик — в подвал ('block'): замечание ставится из середины
              // списка, и прилепленный подвал — единственное место, которое в
              // этот момент гарантированно на экране (см. `FeedbackScope`).
              onRaise={(reason: FlagReason | null, comment: string) =>
                void run('block', () => flagAction(props.submissionId, key, reason, comment))
              }
              onResolve={(flagId) =>
                void run('block', () => unflagAction(props.submissionId, flagId))
              }
            />
          )
        })}

        {/* Подвал — ТОЛЬКО решение по открытому блоку, и он прилеплен к низу
            окна (см. `.review-foot` в globals.css): блок бывает в 58 строк, а
            кнопка блока должна быть достижима из любой его строки — тот же
            довод, что у `.shell-foot` формы заполнения. Отклик блочных
            действий стоит внутри подвала по той же причине: он виден при
            любом положении прокрутки. */}
        <div className="review-foot">
          {feedbackScope === 'block' && feedback}
          <div className="review-foot-actions">
            {/* ОДНА кнопка на два направления, по текущему состоянию блока, а не
                вторая кнопка рядом. «Подтвердить блок» была единственной и не
                выключалась после нажатия: один промах мыши шёл в счёт 27/27
                навсегда, `unconfirmBlock` существовал в `@/review/blocks` без
                единого вызывающего, и обойти это можно было только отметив в
                блоке любое поле, чтобы принятие отказало по замечаниям.

                Подпись «Retract confirmation», а не «Unconfirm block»: `name` в
                `getByRole` сопоставляется по ПОДСТРОКЕ и без учёта регистра, так
                что «Unconfirm block» находился бы и по запросу «Confirm block» —
                та же ловушка, что у кнопок `flag`/`Flag` (см. `e2e/review.spec.ts`),
                из-за которой тест утверждал бы не про ту кнопку. */}
            {blockConfirmed ? (
              <button
                type="button"
                disabled={!decisions.allowed}
                title={decisionHint}
                onClick={() => void run('block', () => unconfirmBlockAction(props.submissionId, current))}
              >
                {locale === 'ru' ? 'Снять подтверждение' : 'Retract confirmation'}
              </button>
            ) : (
              <button
                type="button"
                disabled={!decisions.allowed || openInBlock > 0}
                title={decisionHint ?? (openInBlock > 0 ? pick(BLOCK_HAS_OPEN_FLAGS) : undefined)}
                onClick={() => void run('block', () => confirmBlockAction(props.submissionId, current))}
              >
                {locale === 'ru' ? 'Подтвердить блок' : 'Confirm block'}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
