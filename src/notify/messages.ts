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
 * `loginMail`, below, is a different situation: see its own comment.
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
 * Language: Russian, unlike the two operator mails above — and for the
 * mirror-image reason. This mail never goes to an operator of unknown
 * language; it goes to a member of `teamMembers`, and the brief for this
 * task states as fact that this team is Russian-speaking. That's a known
 * audience, not a guess, so there's nothing to hedge against by defaulting
 * to English here. If the team ever stops being uniformly Russian-speaking
 * (e.g. a non-Russian-speaking reviewer joins), this is the function to
 * revisit — at that point `teamMembers` would need its own recorded
 * language preference, the same gap noted above for operators.
 */
export function loginMail(input: { to: string; loginUrl: string }): OutgoingMail {
  return {
    to: input.to,
    subject: 'Вход в Lounge Onboarding',
    text: [
      'Перейдите по ссылке, чтобы войти. Она одноразовая и действует 20 минут.',
      input.loginUrl,
    ].join('\n'),
  }
}
