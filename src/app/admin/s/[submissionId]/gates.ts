import type { Localized } from '@/form-schema'
import type { SubmissionStatus } from '@/db/schema'
import { EDITABLE_STATUSES } from '@/submissions/editable'

/**
 * Можно ли переслать оператору ссылку заполнения — и если нет, что сказать
 * проверяющему.
 *
 * Отдельный модуль, а не проверка внутри действия, потому что ответ нужен в
 * ДВУХ местах, и они обязаны совпадать:
 *  - `resendFillLinkAction` (`./actions.ts`) — настоящий отказ на сервере.
 *    Он обязателен: `ReviewScreen` это клиентский компонент, его нельзя
 *    считать защитой (серверное действие вызывается по сети напрямую), и
 *    выключенная кнопка — не гейт, а подсказка.
 *  - `./page.tsx` -> `ReviewScreen` — выключенная кнопка с этой же причиной в
 *    `title`. Отказ по факту нажатия честен, но хуже: проверяющий уже решил,
 *    что делает шаг, и узнаёт о невозможности после. Нужны оба, а не один из
 *    двух.
 * Если бы правило (или текст) жили в каждом месте по разу, они разошлись бы
 * молча: экран показывал бы кнопку, действие отказывало, и наоборот. Эта
 * ветка чинила такое уже трижды (`EDITABLE_STATUSES`, `SaveResult`,
 * `FLAG_REASONS`) — см. `src/review/__tests__/lock-order-guard.ts`'s заголовок.
 *
 * Множество берётся из `EDITABLE_STATUSES` (`src/submissions/editable.ts`), а
 * не перечисляется здесь: вопрос «пересылать ли ссылку» это в точности вопрос
 * «откроется ли по ней форма», а на второй уже отвечает единственное в системе
 * определение — то же, которым `assertEditable` разрешает запись, а `FillForm`
 * решает, показывать форму или экран «закрыто». Свой список статусов здесь был
 * бы вторым правилом об одном и том же, и разошёлся бы с первым при добавлении
 * статуса.
 *
 * Клиент получает ГОТОВЫЙ ответ (`ResendGate`), а не статус и не это правило:
 * тот же приём, что у `FieldRow`'s `photos.required` в `ReviewScreen` —
 * компонент получает ответ на вопрос, а не данные, чтобы решить его самому.
 * Заодно `EDITABLE_STATUSES` (а с ним `drizzle-orm`/`@/db/schema` как
 * значения) не попадает в браузерный бандл — ровно та причина, по которой
 * `FillForm` держит свою копию множества вместо импорта серверного модуля.
 */
export type ResendGate = { allowed: true } | { allowed: false; reason: Localized }

/**
 * Тексты отказов — свой на каждый статус, потому что следующий шаг
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

export function resendGateFor(status: SubmissionStatus): ResendGate {
  if (EDITABLE_STATUSES.has(status)) return { allowed: true }
  return { allowed: false, reason: CLOSED_TO_FILLER[status] ?? FORM_CLOSED }
}
