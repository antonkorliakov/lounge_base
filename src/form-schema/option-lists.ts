import type { Localized } from './types'

export type Option = {
  id: string
  label: Localized
  /** Вариант обязывает заполнить текстовое уточнение. */
  requiresDetail: boolean
}

const plain = (id: string, en: string, ru: string): Option => ({
  id,
  label: { en, ru },
  requiresDetail: false,
})

const detail = (id: string, en: string, ru: string): Option => ({
  id,
  label: { en, ru },
  requiresDetail: true,
})

export const OPTION_LISTS = {
  yesNo: [plain('yes', 'Yes', 'Да'), plain('no', 'No', 'Нет')],

  yesSpecifyNo: [
    detail('yes', 'Yes (Specify→)', 'Да (уточните→)'),
    plain('no', 'No', 'Нет'),
  ],

  allowedNotAllowed: [
    plain('allowed', 'Allowed', 'Разрешено'),
    plain('not_allowed', 'Not allowed', 'Не разрешено'),
  ],

  allowedNotAllowedOther: [
    plain('allowed', 'Allowed', 'Разрешено'),
    plain('not_allowed', 'Not allowed', 'Не разрешено'),
    detail('other', 'Other (Specify→)', 'Другое (уточните→)'),
  ],

  allowedConditional: [
    plain('allowed', 'Allowed', 'Разрешено'),
    detail(
      'conditional',
      'Allowed under specific conditions',
      'Разрешено при определённых условиях',
    ),
    plain('not_allowed', 'Not allowed', 'Не разрешено'),
  ],

  floor: [
    plain('mezzanine', 'Mezzanine', 'Мезонин'),
    plain('ground', 'Ground', 'Первый (ground)'),
    plain('first', '1st', '2-й (1st)'),
    plain('second', '2nd', '3-й (2nd)'),
    plain('third', '3rd', '4-й (3rd)'),
  ],

  terminalType: [
    plain('domestic', 'Domestic', 'Внутренний'),
    plain('international', 'International', 'Международный'),
    plain('both', 'Domestic/International', 'Внутренний/Международный'),
  ],

  terminalName: [
    plain('t1', 'T1', 'T1'),
    plain('t2', 'T2', 'T2'),
    plain('t3', 'T3', 'T3'),
    plain('t4', 'T4', 'T4'),
    plain('t5', 'T5', 'T5'),
    plain('main', 'Main Terminal', 'Основной терминал'),
    plain('satellite', 'Satellite', 'Сателлит'),
    detail('other', 'Other (specify)', 'Другое (уточните)'),
  ],

  securityCheck: [
    plain('before', 'Before SHA', 'До досмотра'),
    plain('after', 'After SHA', 'После досмотра'),
  ],

  airsideLandside: [
    plain('airside', 'Airside', 'Стерильная зона'),
    plain('landside', 'Landside', 'Общая зона'),
  ],

  immigration: [
    plain('before', 'Before Immigration', 'До паспортного контроля'),
    plain('after', 'After Immigration', 'После паспортного контроля'),
  ],

  transferMethod: [
    plain('not_applicable', 'Not Applicable', 'Не применимо'),
    plain('walking', 'Walking', 'Пешком'),
    plain('shuttle', 'Shuttle Bus', 'Шаттл'),
    plain('train', 'Airport Train', 'Поезд аэропорта'),
    detail('other', 'Other (Please specify→)', 'Другое (уточните→)'),
  ],

  overcrowding: [
    plain('fcfs', 'First come-First served', 'В порядке очереди'),
    plain('waiting_list', 'Waiting List', 'Лист ожидания'),
    plain(
      'class_priority',
      'Business/First Class priority',
      'Приоритет Business/First',
    ),
    detail('other', 'Other (Specify→)', 'Другое (уточните→)'),
  ],

  airlineAccess: [
    plain(
      'specific',
      'Specific airlines passengers allowed',
      'Только пассажиры определённых авиакомпаний',
    ),
    plain(
      'all',
      'All passengers allowed',
      'Пассажиры всех авиакомпаний',
    ),
  ],

  chargeType: [
    plain('complimentary', 'Complimentary', 'Бесплатно'),
    plain('chargeable', 'Chargeable', 'Платно'),
    plain('both', 'Both', 'И то и другое'),
  ],

  // Зоны в исходнике дропдауном не заданы (III.6.6 — свободный текст с
  // подсказкой «укажите все применимые»). Список наш, но живёт здесь же:
  // по этим значениям фильтруются реестр и выгрузка.
  zone: [
    plain('arrival', 'Arrival', 'Прилёт'),
    plain('departure', 'Departure', 'Вылет'),
    plain('transit', 'Transit', 'Транзит'),
  ],

  vaping: [
    plain(
      'throughout',
      'Allowed throughout the lounge',
      'Разрешено во всём лаунже',
    ),
    plain(
      'smoking_room',
      'Allowed only in smoking room',
      'Только в комнате для курения',
    ),
    plain('not_allowed', 'Not allowed', 'Не разрешено'),
  ],
} as const satisfies Record<string, Option[]>

export type OptionListId = keyof typeof OPTION_LISTS

export function optionsOf(id: OptionListId): readonly Option[] {
  return OPTION_LISTS[id]
}
