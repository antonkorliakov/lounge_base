export type OutgoingMail = { to: string; subject: string; text: string }

/**
 * Language: English only, deliberately — not the reflexive choice.
 *
 * Everywhere else in this system, operator-facing text is `Localized` and
 * rendered in whatever locale the reader currently has `FormShell`/`useLocale`
 * set to (see `src/i18n/context.tsx`, `src/web/FormShell.tsx`'s toggle). That
 * pattern doesn't transfer to email:
 *
 *  - The locale toggle is client-side UI state only. Nothing persists which
 *    locale a given operator was looking at when they filled the form, or
 *    even that they ever touched the toggle — `submissions`/`lounges` carry
 *    no locale column, and the fill flow's server actions are explicitly
 *    locale-blind (see `src/app/f/[token]/actions.ts`'s note on why a
 *    `locale` parameter there would be pointless). By the time a decision
 *    fires an email, there is no recorded signal of which language this
 *    operator reads.
 *  - A screen can offer both and let the reader pick; a sent email can't —
 *    whatever language goes out is final, so guessing wrong is worse here
 *    than on a page with a switcher one click away.
 *  - The questionnaire's own canonical content (field/block identifiers,
 *    the source spreadsheet, `FormShell`'s initial locale) is English; `ru`
 *    is a bilingual convenience layered on top, not the base language.
 *
 * Given an unrecorded, genuinely unknown reader and a fixed default already
 * established elsewhere in the system, English is the safer default — not
 * because it's simpler, but because guessing `ru` for an English-reading
 * operator is actively confusing, while English is at minimum the language
 * every field label started in. If the system ever captures an explicit
 * per-operator (or per-lounge) language preference — a real answer, not a
 * guess — these two builders are exactly where that preference should be
 * read and used to pick between `Localized` variants.
 *
 * This is now a recorded decision, not just this file's convention: all
 * notification mail sent by this system is English — see the design spec
 * (`docs/superpowers/specs/2026-08-06-lounge-data-collection-design.md`),
 * notifications section. `loginMail`, below, is English too, but for a
 * related-yet-distinct reason specific to its own recipients: see its own
 * comment.
 *
 * WHEN THIS MAIL MAY BE SENT AT ALL — separate from the language question,
 * and the reason `fillLinkMail` exists below. Every sentence here is a claim
 * about the review, and all of them hold in exactly one state: the
 * questionnaire is `changes_requested` AND at least one flag is still open.
 * That is also exactly the state in which the link it carries opens the fixes
 * screen (`FillForm`'s `status === 'changes_requested' && flags.length > 0`
 * branch, which renders `FixesOnly`). Sent from anywhere else it lies twice
 * over — about a return that did not happen, and about what the link opens.
 * `fillLinkMail` is the builder for every other state; `sendFillLink`
 * (`src/app/admin/s/[submissionId]/actions.ts`) is the one place that chooses
 * between them — both the return-for-fixes decision and the resend button go
 * through it — and says there why it chooses that way.
 */
export function changesRequestedMail(input: {
  to: string
  loungeName: string
  fillUrl: string
  flagCount: number
}): OutgoingMail {
  return {
    to: input.to,
    subject: `${input.loungeName} — changes requested`,
    text: [
      `We reviewed the onboarding form for ${input.loungeName}.`,
      `${input.flagCount} answer(s) need a correction.`,
      '',
      'Everything else is accepted — you only need to fix what is flagged:',
      input.fillUrl,
    ].join('\n'),
  }
}

/**
 * A fresh fill link and nothing else — the mail for handing an operator back
 * access to a form that is still theirs to fill in: a draft whose link expired
 * or was lost, or a returned questionnaire whose flags have all been answered
 * but not yet resubmitted. In both, the link opens the ordinary form, so this
 * says only that, and makes no claim about a review having happened.
 *
 * It exists because the alternative was `changesRequestedMail` with a
 * `flagCount` of zero, which produced "0 answer(s) need a correction" under a
 * subject line announcing changes nobody requested. A count-shaped sentence
 * cannot be made honest for a state where there is nothing to count, so this
 * is a separate builder rather than a conditional inside that one.
 *
 * What it deliberately does NOT say:
 *  - Nothing about earlier links being replaced or revoked. `issueFillToken`
 *    only inserts a row; every earlier token stays valid until it expires on
 *    its own (only the SHA-256 hash is stored, so a specific one can never be
 *    identified again to revoke it — see `src/access/tokens.ts`). "This
 *    replaces your old link" would be a plain falsehood.
 *  - Nothing about how long it lasts. The TTL is the caller's argument
 *    (`ttlDays`), not this module's knowledge; a stated window would be one
 *    more sentence that can silently drift out of true — the failure this
 *    whole builder exists to avoid. `loginMail` may state its window only
 *    because `LOGIN_TTL_MINUTES` is a real exported constant and a test pins
 *    the mail against it (see `__tests__/messages.test.ts`).
 *
 * English, same recorded decision as the mails above.
 */
export function fillLinkMail(input: {
  to: string
  loungeName: string
  fillUrl: string
}): OutgoingMail {
  return {
    to: input.to,
    subject: `${input.loungeName} — onboarding form link`,
    text: [
      `Here is a link to the onboarding form for ${input.loungeName}:`,
      '',
      input.fillUrl,
      '',
      'If an earlier link no longer works, use this one instead.',
    ].join('\n'),
  }
}

export function approvedMail(input: {
  to: string
  loungeName: string
}): OutgoingMail {
  return {
    to: input.to,
    subject: `${input.loungeName} — form approved`,
    text: [
      `The onboarding form for ${input.loungeName} has been approved.`,
      'Thank you — no further action is needed.',
    ].join('\n'),
  }
}

/**
 * Language: English, same decision as the two operator mails above (see
 * the design spec reference there), but for a distinct reason specific to
 * this mail's recipients. This one goes to a member of `teamMembers`, not
 * an operator — a population whose language could in principle be known
 * rather than guessed. It's still English, because "known" would require a
 * guarantee this system doesn't have: nothing about `teamMembers` enforces
 * that its membership is uniformly one language, today or after the next
 * person is added to it, and there is no `locale`/`language` column on
 * that table to check even if such a guarantee existed. English is the
 * choice that doesn't quietly break the day someone who doesn't read
 * Russian joins the team — unlike a language chosen because it happens to
 * describe the team *right now*, it doesn't need re-litigating every time
 * the team's composition changes.
 *
 * If `teamMembers` ever gains a real per-member language preference, this
 * is where it should be read and used — the same condition noted above for
 * the operator mails, just for a different table.
 */
export function loginMail(input: { to: string; loginUrl: string }): OutgoingMail {
  return {
    to: input.to,
    subject: 'Sign in to Lounge Onboarding',
    text: [
      'Use this link to sign in. It works once and expires in 20 minutes.',
      input.loginUrl,
    ].join('\n'),
  }
}
