import {
  boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable,
  text, timestamp, unique, uuid,
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
  (table) => [index('field_flags_submission_idx').on(table.submissionId)],
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

export type SubmissionStatus = (typeof submissionStatus.enumValues)[number]
export type OperationalStatus = (typeof operationalStatus.enumValues)[number]
