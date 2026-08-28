import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Шов `putPhoto`/`deletePhoto` (`src/photos/blob.ts`) ветвится по ОДНОМУ
 * предикату `blobConfigured()` — эти тесты пиннят обе стороны ветвления и,
 * главное, само break-verify требование: С ТОКЕНОМ fallback не активируется
 * НИКОГДА (ни файла на диске, ни локального URL — только настоящий `put`),
 * БЕЗ токена настоящее хранилище не трогается вовсе. Второй пин той же
 * гарантии живёт в тесте маршрута (`upload-route.test.ts`): он ставит токен и
 * утверждает блобовские URL насквозь.
 *
 * `@vercel/blob` замокан по той же причине, что и там: настоящих реквизитов
 * нет ни локально, ни в CI, а предмет теста — ветвление шва, не сеть.
 */
const blob = vi.hoisted(() => ({
  put: vi.fn(async (key: string) => ({ url: `https://blob.test/${key}` })),
  del: vi.fn(async () => {}),
}))

vi.mock('@vercel/blob', () => ({ put: blob.put, del: blob.del }))

const { putPhoto, deletePhoto, blobConfigured } = await import('../blob')

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

function jpegFile(): File {
  return new File([JPEG_BYTES], 'shot.jpg', { type: 'image/jpeg' })
}

/**
 * Fallback пишет под `process.cwd()/public/dev-blob` — тесты уводят cwd во
 * временный каталог, чтобы не гадить в рабочее дерево репозитория и не
 * зависеть от того, что там уже лежит.
 */
let workDir: string
let cwdSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dev-blob-test-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workDir)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  cwdSpy.mockRestore()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  blob.put.mockClear()
  blob.del.mockClear()
  await rm(workDir, { recursive: true, force: true })
})

describe('с токеном — только настоящее хранилище, fallback не активируется', () => {
  beforeEach(() => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test_token')
  })

  it('blobConfigured() истинно, put уходит в @vercel/blob, диск не трогается', async () => {
    expect(blobConfigured()).toBe(true)

    const result = await putPhoto('sub-1/entrance-1.jpg', jpegFile(), 'image/jpeg')

    expect(result.url).toBe('https://blob.test/sub-1/entrance-1.jpg')
    expect(blob.put).toHaveBeenCalledWith('sub-1/entrance-1.jpg', expect.any(File), {
      access: 'public',
      contentType: 'image/jpeg',
    })
    // Главный пин: НИКАКОГО файла на диске и никакого локального URL.
    expect(existsSync(resolve(workDir, 'public', 'dev-blob'))).toBe(false)
    expect(result.url.startsWith('/dev-blob/')).toBe(false)
  })

  it('delete уходит в @vercel/blob и не занимается локальными файлами', async () => {
    await deletePhoto('https://blob.test/sub-1/entrance-1.jpg')
    expect(blob.del).toHaveBeenCalledWith('https://blob.test/sub-1/entrance-1.jpg')
  })
})

describe('без токена — dev-fallback, настоящее хранилище не трогается', () => {
  beforeEach(() => {
    // Ровно та форма, что в `.env.example`: переменная есть, но пустая.
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
  })

  it('пишет файл под public/dev-blob, возвращает локальный URL и предупреждает', async () => {
    expect(blobConfigured()).toBe(false)

    const result = await putPhoto('sub-1/extra-1.jpg', jpegFile(), 'image/jpeg')

    expect(result.url).toBe('/dev-blob/sub-1/extra-1.jpg')
    expect(blob.put).not.toHaveBeenCalled()
    const written = await readFile(resolve(workDir, 'public', 'dev-blob', 'sub-1', 'extra-1.jpg'))
    expect(new Uint8Array(written)).toEqual(JPEG_BYTES)
    // Громкое предупреждение — по образцу consoleMailer: dev-only и именно
    // об этом сказано словами.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('BLOB_READ_WRITE_TOKEN is not set'),
    )
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('local development only'),
    )
  })

  it('удаляет свой файл по локальному URL, чужие URL молча пропускает', async () => {
    await putPhoto('sub-1/extra-1.jpg', jpegFile(), 'image/jpeg')
    const target = resolve(workDir, 'public', 'dev-blob', 'sub-1', 'extra-1.jpg')
    expect(existsSync(target)).toBe(true)

    await deletePhoto('/dev-blob/sub-1/extra-1.jpg')
    expect(existsSync(target)).toBe(false)
    expect(blob.del).not.toHaveBeenCalled()

    // Настоящий блобовский URL из БД и засеянный /seed/… — не наши файлы:
    // no-op без исключения, а не попытка unlink по чужому пути.
    await expect(deletePhoto('https://blob.example/sub-1/x.jpg')).resolves.toBeUndefined()
    await expect(deletePhoto('/seed/entrance.svg')).resolves.toBeUndefined()

    // Повторное удаление уже удалённого — best-effort, без исключения.
    await expect(deletePhoto('/dev-blob/sub-1/extra-1.jpg')).resolves.toBeUndefined()
  })

  it('ключ с ../ не выходит за пределы public/dev-blob', async () => {
    await expect(putPhoto('../../evil.jpg', jpegFile(), 'image/jpeg')).rejects.toThrow(
      /escapes/,
    )
    expect(existsSync(resolve(workDir, 'evil.jpg'))).toBe(false)
  })
})
