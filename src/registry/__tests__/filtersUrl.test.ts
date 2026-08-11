import { describe, it, expect } from 'vitest'
import { filtersFromSearchParams, searchParamsFromFilters } from '../filters-url'
import type { RegistryFilters } from '../query'

describe('фильтры в адресной строке', () => {
  it('пустые параметры дают пустые фильтры', () => {
    expect(filtersFromSearchParams({})).toEqual({})
  })

  it('простые параметры читаются', () => {
    expect(filtersFromSearchParams({ airport: 'Istanbul Airport', zone: 'departure' })).toEqual({
      airport: 'Istanbul Airport',
      zone: 'departure',
    })
  })

  it('статусы читаются списком', () => {
    const filters = filtersFromSearchParams({
      operationalStatus: 'active,under_renovation',
    })
    expect(filters.operationalStatus).toEqual(['active', 'under_renovation'])
  })

  it('неизвестный статус лаунжа отбрасывается', () => {
    const filters = filtersFromSearchParams({ operationalStatus: 'active,нет-такого' })
    expect(filters.operationalStatus).toEqual(['active'])
  })

  it('статусный параметр из одних неизвестных значений не превращается в фильтр', () => {
    // Не пустой список: `inArray(..., [])` — это `WHERE false`, то есть URL
    // с опечаткой в статусе показал бы пустой реестр вместо полного.
    expect(filtersFromSearchParams({ operationalStatus: 'нет-такого' })).toEqual({})
  })

  it('неизвестный статус анкеты отбрасывается', () => {
    const filters = filtersFromSearchParams({ submissionStatus: 'submitted,выдумка' })
    expect(filters.submissionStatus).toEqual(['submitted'])
  })

  it('пустая строка не превращается в фильтр', () => {
    expect(filtersFromSearchParams({ search: '   ' })).toEqual({})
  })

  it('обратное преобразование восстанавливает фильтры', () => {
    const filters = {
      airport: 'Istanbul Airport',
      zone: 'departure',
      operationalStatus: ['active' as const],
      search: 'prime',
    }
    const restored = filtersFromSearchParams(
      Object.fromEntries(searchParamsFromFilters(filters).entries()),
    )
    expect(restored).toEqual(filters)
  })

  it('обратное преобразование восстанавливает КАЖДЫЙ ключ фильтра', () => {
    // Полный объект, а не выборочный: фильтр, который сериализатор пишет, а
    // разборщик не читает (или наоборот), терялся бы молча — и предыдущий
    // тест с четырьмя ключами этого не увидел бы.
    const filters: Required<RegistryFilters> = {
      country: 'Turkey',
      city: 'Istanbul',
      airport: 'Istanbul Airport',
      terminal: 't2',
      zone: 'arrival',
      operationalStatus: ['active', 'closed'],
      submissionStatus: ['submitted', 'approved'],
      search: 'prime',
    }
    const restored = filtersFromSearchParams(
      Object.fromEntries(searchParamsFromFilters(filters).entries()),
    )
    expect(restored).toEqual(filters)
  })

  it('массив значений берёт первое', () => {
    expect(filtersFromSearchParams({ airport: ['IST', 'DXB'] })).toEqual({ airport: 'IST' })
  })
})
