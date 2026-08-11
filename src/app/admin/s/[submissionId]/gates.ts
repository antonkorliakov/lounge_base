import type { Localized } from '@/form-schema'
import type { SubmissionStatus } from '@/db/schema'
import { EDITABLE_STATUSES } from '@/submissions/editable'
import { REVIEW_STATUSES } from '@/review/blocks'

/**
 * Что проверяющий может сделать на этой анкете — и если не может, что ему
 * сказать. Один модуль на все ответы такого вида, потому что каждый из них
 * нужен в ДВУХ местах, и они обязаны совпадать:
 *  - серверное действие (`./actions.ts`) или транзакция решения
 *    (`src/review/decide.ts`, `src/review/blocks.ts`) — настоящий отказ. Он
 *    обязателен: `ReviewScreen` это клиентский компонент, его нельзя считать
 *    защитой (серверное действие вызывается по сети напрямую), и выключенная
 *    кнопка — не гейт, а подсказка.
 *  - `./page.tsx` -> `ReviewScreen` — выключенная кнопка с этой же причиной в
 *    `title` (и та же причина строкой в подвале, где недоступны все решения
 *    сразу). Отказ по факту нажатия честен, но хуже: проверяющий уже решил,
 *    что делает шаг, и узнаёт о невозможности после — а перед этим успел
 *    сделать работу, которая никуда не денется (отметить три ответа на уже
 *    принятой анкете, например).
 * Если бы правило (или текст) жили в каждом месте по разу, они разошлись бы
 * молча: экран показывал бы кнопку, действие отказывало, и наоборот. Эта
 * ветка чинила такое уже трижды (`EDITABLE_STATUSES`, `SaveResult`,
 * `FLAG_REASONS`) — см. `src/review/__tests__/lock-order-guard.ts`'s заголовок.
 *
 * Ни одно множество статусов здесь не перечисляется заново: `EDITABLE_STATUSES`
 * (`src/submissions/editable.ts`) — окно правки для оператора, `REVIEW_STATUSES`
 * (`src/review/blocks.ts`) — окно решения для проверяющего, и оба уже
 * существуют по одному разу. Свой список здесь был бы вторым правилом об одном
 * и том же и разошёлся бы с первым при добавлении статуса.
 *
 * Клиент получает ГОТОВЫЙ ответ (`Gate`/`ReviewState`), а не статус и не эти
 * правила: тот же приём, что у `FieldRow`'s `photos.required` в `ReviewScreen` —
 * компонент получает ответ на вопрос, а не данные, чтобы решить его самому.
 * Заодно оба множества (а с ними `drizzle-orm`/`@/db/schema` как значения) не
 * попадают в браузерный бандл — ровно та причина, по которой `FillForm` держит
 * свою копию `EDITABLE_STATUSES` вместо импорта серверного модуля.
 */
export type Gate = { allowed: true } | { allowed: false; reason: Localized }

/**
 * Тексты отказов пересылки — свой на каждый статус, потому что следующий шаг
 * проверяющего у них разный: анкету на проверке можно вернуть на правку и
 * переслать ссылку уже после этого, а принятую — нельзя (`requestChanges`
 * работает только из `submitted`, см. `REVIEW_STATUSES`), и предлагать это
 * было бы советом в тупик.
 *
 * Карта частичная, с обобщённым `FORM_CLOSED` на остальные случаи: если в
 * `submissionStatus` появится ещё один статус вне `EDITABLE_STATUSES`, отказ
 * останется правдивым (он говорит только то, что верно для любого такого
 * статуса), просто менее подробным. Полная `Record<...>` заставила бы дописать
 * текст и для `draft`/`changes_requested`, где отказа не бывает, — то есть
 * хранить сообщения, которых никто никогда не увидит.
 */
const FORM_CLOSED: Localized = {
  en: 'The operator cannot edit this form right now, so a new link would only open a closed form.',
  ru: 'Оператор сейчас не может править эту анкету — новая ссылка откроет только закрытую форму.',
}

const CLOSED_TO_FILLER: Partial<Record<SubmissionStatus, Localized>> = {
  submitted: {
    en: 'This form is under review, so a new link would only open a closed form. Use "Request changes" to send it back to the operator first.',
    ru: 'Анкета на проверке — новая ссылка откроет только закрытую форму. Сначала верните её оператору кнопкой «Вернуть на правку».',
  },
  approved: {
    en: 'This form is approved and closed to the operator, so a new link would only open a closed form.',
    ru: 'Анкета принята и закрыта для оператора — новая ссылка откроет только закрытую форму.',
  },
}

export function resendGateFor(status: SubmissionStatus): Gate {
  if (EDITABLE_STATUSES.has(status)) return { allowed: true }
  return { allowed: false, reason: CLOSED_TO_FILLER[status] ?? FORM_CLOSED }
}

/**
 * Название состояния и что оно значит для работы проверяющего ПРЯМО СЕЙЧАС.
 *
 * `Record` полная, а не частичная (в отличие от `CLOSED_TO_FILLER` выше), и
 * это разница по существу: подпись состояния показывается ВСЕГДА, на любой
 * анкете, до которой проверяющий дошёл. Новый статус в `submissionStatus`,
 * которому здесь не дописали строку, не скомпилируется — то есть решение «что
 * сказать проверяющему в этом состоянии» нельзя пропустить молча, а именно
 * молчание и было дефектом: экран не говорил о статусе ничего и предлагал все
 * решения на любой анкете.
 *
 * `note` — одно предложение на состояние, и оно же служит причиной отказа в
 * `decisions`/`flagging` ниже. Отдельный текст «почему кнопка выключена»
 * рядом с текстом «в каком состоянии анкета» был бы двумя формулировками
 * одного факта, которые расходятся при первой же правке одной из них.
 */
const STATE: Record<SubmissionStatus, { label: Localized; note: Localized }> = {
  draft: {
    label: { en: 'Draft', ru: 'Черновик' },
    note: {
      en: 'The operator has not submitted this questionnaire yet, so there is nothing to decide on. A flag you leave now reaches them only after they submit it and you send it back.',
      ru: 'Оператор ещё не отправил анкету на проверку, так что решать пока нечего. Замечание, поставленное сейчас, дойдёт до него только после отправки и возврата на правку.',
    },
  },
  submitted: {
    label: { en: 'Under review', ru: 'На проверке' },
    note: {
      en: 'Open for review: confirm the blocks you have checked, flag the answers that need work, then approve it or send it back.',
      ru: 'Анкета на проверке: подтверждайте проверенные блоки, отмечайте спорные ответы, затем принимайте анкету или возвращайте её на правку.',
    },
  },
  changes_requested: {
    label: { en: 'Returned to the operator', ru: 'Возвращена оператору' },
    note: {
      en: 'The operator is correcting it, so review decisions are unavailable until they submit it again. A flag you raise now appears on their corrections screen, but no email is sent about it.',
      ru: 'Оператор её правит, поэтому решения по проверке недоступны до повторной отправки. Замечание, поставленное сейчас, появится у него на экране правок, но письма о нём не будет.',
    },
  },
  approved: {
    label: { en: 'Approved', ru: 'Принята' },
    note: {
      en: 'The decision is final: this questionnaire is out of review, and a flag raised now could never reach the operator.',
      ru: 'Решение принято окончательно: анкета вышла из проверки, а замечание, поставленное сейчас, до оператора уже никак не дойдёт.',
    },
  },
}

/**
 * Всё, что экрану проверки нужно знать о состоянии анкеты: как оно называется,
 * что оно значит, и какие шаги в нём вообще применимы.
 *
 * `status` тоже отдаётся — не для решений (они уже посчитаны), а чтобы у
 * подписи состояния был класс (`review-status-<status>`) и чтобы e2e мог
 * утверждать про состояние, а не про формулировку.
 */
export type ReviewState = {
  status: SubmissionStatus
  label: Localized
  note: Localized
  /**
   * Подтвердить блок / снять подтверждение / вернуть на правку / принять —
   * все четыре стоят на одном и том же окне (`REVIEW_STATUSES`), поэтому это
   * один гейт, а не четыре: `confirmBlock` (`src/review/blocks.ts`),
   * `requestChanges` и `approveSubmission` (`src/review/decide.ts`) проверяют
   * ровно его каждый в своей транзакции, а `unconfirmBlockAction`
   * (`./actions.ts`) — до вызова `unconfirmBlock`.
   *
   * У «вернуть на правку» и «принять» есть СВЕРХ этого свои условия (хотя бы
   * одно открытое замечание; все блоки подтверждены и ни одного замечания) —
   * они не здесь, потому что зависят не от статуса, а от данных, которые
   * экран и так показывает; см. `ReviewScreen`'s подвал.
   */
  decisions: Gate
  /**
   * Можно ли отмечать ответы замечаниями.
   *
   * Правило выведено, а не перечислено: замечание доходит до оператора ровно
   * двумя путями — через возврат на правку (нужен `REVIEW_STATUSES`) и через
   * экран, который откроет его ссылка заполнения (нужен `EDITABLE_STATUSES`,
   * там `FixesOnly` рисует открытые замечания). Статус вне обоих множеств —
   * тупик: замечание сохранится (`raiseFlag` статус не проверяет, и это
   * осознанное решение задачи 2, а не упущение), но ни письмом, ни экраном
   * оператору его уже не передать. Сегодня такой статус ровно один
   * (`approved`); написанное так правило останется верным и для следующего
   * терминального статуса, а `status === 'approved'` — нет.
   *
   * Здесь ЕДИНСТВЕННЫЙ гейт этого модуля, у которого нет серверной половины,
   * и это не недосмотр: `raiseFlag` намеренно слеп к статусу, менять его
   * поведение задача запрещает, и менять его не нужно — замечание на
   * принятой анкете не нарушает никакого инварианта (в отличие от
   * подтверждения блока или принятия), оно просто ничего не значит. Поэтому
   * убранная кнопка здесь — выбор о том, что предлагать человеку, а не
   * защита: если замечание всё же дойдёт до сервера (открытая вкладка,
   * прямой вызов), хуже не станет ничем.
   */
  flagging: Gate
  /** Тот же ответ, что получает `resendFillLinkAction` (`resendGateFor` выше). */
  resend: Gate
}

export function reviewStateFor(status: SubmissionStatus): ReviewState {
  const state = STATE[status]
  const deliverable = REVIEW_STATUSES.has(status) || EDITABLE_STATUSES.has(status)

  return {
    status,
    label: state.label,
    note: state.note,
    decisions: REVIEW_STATUSES.has(status)
      ? { allowed: true }
      : { allowed: false, reason: state.note },
    flagging: deliverable ? { allowed: true } : { allowed: false, reason: state.note },
    resend: resendGateFor(status),
  }
}
