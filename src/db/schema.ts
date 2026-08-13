import { sql } from 'drizzle-orm'
import {
  boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable,
  text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'

export const submissionStatus = pgEnum('submission_status', [
  'draft',
  'submitted',
  'changes_requested',
  'approved',
])

export const operationalStatus = pgEnum('operational_status', [
  'active',
  'temporarily_closed',
  'under_renovation',
  'closed',
])

export const lounges = pgTable(
  'lounges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    provider: text('provider'),
    country: text('country').notNull(),
    city: text('city').notNull(),
    airport: text('airport').notNull(),
    iataCode: text('iata_code').notNull(),

    operationalStatus: operationalStatus('operational_status')
      .notNull()
      .default('active'),
    statusUntil: date('status_until'),
    statusComment: text('status_comment'),

    // Классифицирующие поля. Пишутся только при принятии анкеты.
    terminal: text('terminal'),
    terminalType: text('terminal_type'),
    zone: text('zone').array(),
    airsideLandside: text('airside_landside'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('lounges_iata_idx').on(table.iataCode),
    index('lounges_operational_status_idx').on(table.operationalStatus),
  ],
)

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loungeId: uuid('lounge_id').notNull().references(() => lounges.id, { onDelete: 'cascade' }),
    status: submissionStatus('status').notNull().default('draft'),
    reviewerId: text('reviewer_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [index('submissions_lounge_idx').on(table.loungeId, table.createdAt)],
)

export const fieldValues = pgTable(
  'field_values',
  {
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    value: jsonb('value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('field_values_unique').on(table.submissionId, table.fieldKey)],
)

export const serviceValues = pgTable(
  'service_values',
  {
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    itemKey: text('item_key').notNull(),
    available: text('available'),
    chargeType: text('charge_type'),
    price: numeric('price', { precision: 12, scale: 2 }),
    currency: text('currency'),
    slotMinutes: integer('slot_minutes'),
    bookingRequired: boolean('booking_required'),
    details: text('details'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('service_values_unique').on(table.submissionId, table.itemKey)],
)

export const photos = pgTable('photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  slot: text('slot').notNull(),
  blobKey: text('blob_key').notNull(),
  url: text('url').notNull(),
  caption: text('caption'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
})

export const blockReviews = pgTable(
  'block_reviews',
  {
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    blockKey: text('block_key').notNull(),
    confirmedBy: text('confirmed_by').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('block_reviews_unique').on(table.submissionId, table.blockKey)],
)

export const fieldFlags = pgTable(
  'field_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    reason: text('reason'),
    comment: text('comment').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('field_flags_submission_idx').on(table.submissionId),
    // Enforces "one open flag per (submission, field)" in the database
    // itself, not just in raiseFlag's application logic. Partial (only over
    // still-open rows) so resolved history for the same key doesn't
    // conflict. This turns raiseFlag's replace-if-open into a single
    // `INSERT ... ON CONFLICT ... DO UPDATE` targeting this index, the same
    // shape as the delete-then-write races already fixed elsewhere on this
    // branch (see `access/team.ts`'s `consumeLoginToken`) — one atomic
    // statement instead of a read followed by a write that a concurrent
    // caller can interleave with.
    uniqueIndex('field_flags_open_unique')
      .on(table.submissionId, table.fieldKey)
      .where(sql`${table.resolvedAt} is null`),
  ],
)

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  loungeId: uuid('lounge_id').references(() => lounges.id, { onDelete: 'cascade' }),
  submissionId: uuid('submission_id').references(() => submissions.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  payload: jsonb('payload'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

export const fillTokens = pgTable(
  'fill_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('fill_tokens_hash_unique').on(table.tokenHash)],
)

export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    // Пароль — второй путь входа РЯДОМ с magic-ссылкой, а не вместо неё
    // (почта не отправляется, SMTP не настроен — см. `ops.ts`). NULL — у
    // участника пароля нет, и парольный путь для него просто не работает;
    // формат строки самоописывающийся, см. `access/password.ts`.
    passwordHash: text('password_hash'),
    // Минимальная, но настоящая защита от перебора: счётчик подряд неверных
    // паролей и время, до которого парольный вход участника закрыт. На
    // участника, не на IP — распределённый перебор по многим адресам этим
    // не ловится (сказано в `loginWithPassword`, не спрятано).
    failedPasswordAttempts: integer('failed_password_attempts').notNull().default(0),
    passwordLockedUntil: timestamp('password_locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('team_members_email_unique').on(table.email)],
)

export const loginTokens = pgTable(
  'login_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id').notNull().references(() => teamMembers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [unique('login_tokens_hash_unique').on(table.tokenHash)],
)

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: uuid('member_id').notNull().references(() => teamMembers.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type SubmissionStatus = (typeof submissionStatus.enumValues)[number]
export type OperationalStatus = (typeof operationalStatus.enumValues)[number]
