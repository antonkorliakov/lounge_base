'use client'

import { useState } from 'react'
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
  requestChangesAction, approveAction, resendFillLinkAction,
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
   * `approveSubmission`, `resendFillLinkAction`, `unconfirmBlockAction`),
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
  // Тип — `FillLinkActionResult`, потому что два из семи действий («Переслать
  // ссылку», «Вернуть на правку») могут вернуть успех со ссылкой заполнения
  // (`fillUrl` — только когда почта не доставляет, см. его комментарий в
  // `actions.ts`); остальные возвращают `ActionResult`, который к нему
  // присваиваем. Ссылка, как и `notice`, — свойство ПОСЛЕДНЕГО действия:
  // любой следующий результат её снимает (одноразовость сказана словами в
  // `FillLinkReveal`, а не охраняется удержанием на экране; повторное нажатие
  // просто выписывает новую — токены не отзываются, см. `issueFillToken`).
  async function run(action: () => Promise<FillLinkActionResult>): Promise<void> {
    const result = await action()
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
              onRaise={(reason: FlagReason | null, comment: string) =>
                void run(() => flagAction(props.submissionId, key, reason, comment))
              }
              onResolve={(flagId) =>
                void run(() => unflagAction(props.submissionId, flagId))
              }
            />
          )
        })}

        {error && <p className="review-error">{pick(error)}</p>}
        {notice && <p className="review-notice">{pick(notice)}</p>}
        {/* Ссылка заполнения, которую письмо не унесло (почта не настроена —
            `fillUrl` приходит только в этом случае). Вступление к ней — сам
            `notice` выше («письма не было, передайте сами»), поэтому у
            компонента своего вступления нет. `key` обязателен: повторная
            пересылка выписывает НОВУЮ ссылку, и «Скопировано» прежней не
            должно её пережить (см. `FillLinkReveal`). */}
        {fillUrl && <FillLinkReveal key={fillUrl} url={fillUrl} />}

        <div className="review-foot">
          <button
            type="button"
            disabled={!decisions.allowed || props.flags.length === 0}
            title={decisionHint ?? (props.flags.length === 0 ? pick(NOTHING_FLAGGED) : undefined)}
            onClick={() => void run(() => requestChangesAction(props.submissionId))}
          >
            {locale === 'ru' ? 'Вернуть на правку' : 'Request changes'} · {props.flags.length}
          </button>
          <button
            type="button"
            disabled={!props.state.resend.allowed}
            title={props.state.resend.allowed ? undefined : pick(props.state.resend.reason)}
            onClick={() => void run(() => resendFillLinkAction(props.submissionId))}
          >
            {locale === 'ru' ? 'Переслать ссылку' : 'Resend link'}
          </button>
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
              onClick={() => void run(() => unconfirmBlockAction(props.submissionId, current))}
            >
              {locale === 'ru' ? 'Снять подтверждение' : 'Retract confirmation'}
            </button>
          ) : (
            <button
              type="button"
              disabled={!decisions.allowed || openInBlock > 0}
              title={decisionHint ?? (openInBlock > 0 ? pick(BLOCK_HAS_OPEN_FLAGS) : undefined)}
              onClick={() => void run(() => confirmBlockAction(props.submissionId, current))}
            >
              {locale === 'ru' ? 'Подтвердить блок' : 'Confirm block'}
            </button>
          )}
          {/* «Принять» выключается ТОЛЬКО по статусу, хотя у неё есть и другие
              условия (все блоки подтверждены, ни одного открытого замечания).
              Это не непоследовательность: те два условия — незаконченная
              работа проверяющего, и отказ действия называет, СКОЛЬКО именно
              блоков осталось и сколько замечаний открыто
              (`approveSubmission`), чего выключенная кнопка сказать не может.
              Статус же не про незаконченную работу: в нём шага не бывает
              вовсе, сколько бы ни подтвердили. */}
          <button
            type="button"
            disabled={!decisions.allowed}
            title={decisionHint}
            onClick={() => void run(() => approveAction(props.submissionId))}
          >
            {locale === 'ru' ? 'Принять анкету' : 'Approve'}
          </button>
        </div>
      </section>
    </div>
  )
}
