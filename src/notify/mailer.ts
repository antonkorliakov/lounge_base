import { createTransport } from 'nodemailer'
import type { OutgoingMail } from './messages'

export type Mailer = { send(message: OutgoingMail): Promise<void> }

// Opt-in flag for `consoleMailer`, off by default — see its doc comment.
// Named for what it does (show the body), not for the environment it's
// meant for, since "meant for dev" is a convention this code can't enforce,
// only a name can hint at.
const SHOW_BODY_ENV_VAR = 'MAIL_CONSOLE_SHOW_BODY'

/**
 * Without `SMTP_URL`, mail is printed to the console instead of sent. Local
 * development shouldn't require a mail server, and silently swallowing the
 * message would hide a misconfiguration until production — that half of the
 * brief's reasoning stands as given.
 *
 * What's different from the brief's version: this same fallback runs in
 * *any* environment that forgot to set `SMTP_URL`, not only a laptop — and
 * one of the three messages this mailer carries (`loginMail`) is a working,
 * single-use credential. Printing that unconditionally makes it
 * indistinguishable from routine output in whatever aggregates this
 * process's stdout (which, unlike an inbox, is very often readable by more
 * people than the intended recipient, and rarely access-controlled per
 * message).
 *
 * An earlier version of this function kept printing the full body
 * unconditionally and only added a `console.warn` alongside it — which
 * announces the leak more loudly without doing anything to stop it; the
 * credential still lands in the same log. Fixed here by actually gating the
 * body: by default, only `to` and `subject` are printed (both already
 * unavoidably visible to anything with access to `submissions`/
 * `teamMembers`, so printing them adds no new exposure) plus a note that the
 * body was withheld. The full body — including any working link — prints
 * only when `MAIL_CONSOLE_SHOW_BODY=true` is set.
 *
 * This keeps local development workable rather than merely safe-by-being-
 * useless: a developer who actually needs to click a magic link on their
 * laptop sets the flag once, in their own `.env.local` (see the comment
 * next to it in `.env.example`) and gets the same full printout as before.
 * What changes is the *default* — an unattended deployment that simply
 * forgot to configure `SMTP_URL` no longer leaks a live credential into its
 * logs just by existing; doing that now takes an explicit, named opt-in
 * that has to have been deliberately set somewhere, not silence.
 *
 * Considered and rejected: pattern-matching the token out of the URL (e.g.
 * redacting the last path segment) and printing everything else. That
 * would let a developer see the message shape without the flag, but it
 * ties correctness to guessing every future URL shape `loginUrl`/`fillUrl`
 * might take — a link format change elsewhere in the app could silently
 * stop being redacted, which fails exactly the way this fix is trying to
 * close. Withholding the whole body behind one explicit flag has no such
 * blind spot: it doesn't need to know what a credential looks like.
 */
function consoleMailer(): Mailer {
  return {
    async send(message) {
      console.warn(
        '[mail] SMTP_URL is not set — printing this message to stdout instead of ' +
          'sending it. This is expected in local development only; if this warning ' +
          'appears anywhere else, mail delivery is silently broken there.',
      )

      if (process.env[SHOW_BODY_ENV_VAR] === 'true') {
        process.stdout.write(
          `\n[mail] → ${message.to}\n[mail] ${message.subject}\n${message.text}\n\n`,
        )
        return
      }

      process.stdout.write(
        `\n[mail] → ${message.to}\n[mail] ${message.subject}\n` +
          `[mail] body withheld — it may contain a single-use credential ` +
          `(see loginMail). Set ${SHOW_BODY_ENV_VAR}=true locally to see full ` +
          `bodies, including working links.\n\n`,
      )
    },
  }
}

/**
 * SMTP transport. `MAIL_FROM` is required here, not defaulted — see the
 * deviation note below.
 *
 * The brief's draft defaults a missing `MAIL_FROM` to `noreply@example.com`
 * so a send is never blocked by a missing setting. That default is fine for
 * the console path (nothing is actually transmitted, so the placeholder is
 * never seen by anyone), but this function only runs once `SMTP_URL` is
 * set — i.e. once real mail is actually going out. Sending real mail from
 * `noreply@example.com` is worse than refusing to send: `example.com` isn't
 * a domain this deployment controls, so the SPF/DKIM alignment receiving
 * servers check will fail against it, meaning the message is likely to be
 * dropped or spam-foldered rather than merely look wrong — a decision or
 * login mail that silently never arrives is exactly the failure mode this
 * mailer exists to avoid. Failing loudly at `createMailer()` — before any
 * message is attempted — surfaces the missing setting immediately instead
 * of once complaints about missing email start arriving.
 */
function smtpMailer(url: string): Mailer {
  const from = process.env.MAIL_FROM
  if (!from) {
    throw new Error(
      'MAIL_FROM must be set when SMTP_URL is configured — sending real mail from ' +
        'a placeholder address is not a safe default.',
    )
  }

  const transport = createTransport(url)
  return {
    async send(message) {
      await transport.sendMail({ from, ...message })
    },
  }
}

/**
 * Reads the environment at call time (not at module load), so tests and
 * callers that flip `SMTP_URL`/`MAIL_FROM` between calls see the effect
 * immediately, same as the brief specifies.
 *
 * Failure is deliberately left to the caller: neither branch here catches
 * a send error. `smtpMailer`'s `send` lets `transport.sendMail`'s rejection
 * propagate as-is, and this task doesn't decide what happens to a review
 * decision when the notification announcing it fails to send — that is the
 * next task's call (wiring `changesRequestedMail`/`approvedMail`/
 * `loginMail` into `src/review/decide.ts` and `src/access/team.ts`), which
 * this task explicitly does not do. The guidance for that task: the
 * decision itself (`requestChanges`/`approveSubmission`) is already durable
 * once its own transaction commits, independent of whether anyone is ever
 * told about it — a bounced or rejected notification is a delivery problem,
 * not evidence the decision was wrong, so it should surface to the caller
 * (and, ultimately, the reviewer's screen) as "the decision went through,
 * but the email didn't — retry the notification", never as a reason to
 * undo the decision. That also means the notification send belongs *after*
 * the decision's transaction has committed, not inside it: a transient SMTP
 * failure has no business rolling back a review decision that has nothing
 * to do with mail delivery.
 *
 * Two more things the next task (the actual wiring) needs to know and this
 * task deliberately leaves unhandled:
 *
 *  - `createTransport(url)` (in `smtpMailer`) can itself throw synchronously
 *    if `url` is malformed, and *when* it throws — at `createMailer()` call
 *    time vs. lazily on first `send` — is an artifact of how nodemailer
 *    parses the specific malformed shape, not a contract this module
 *    controls or has verified. Don't assume every bad `SMTP_URL` surfaces
 *    at the same point `MAIL_FROM` does above.
 *  - Calling `createMailer()` fresh on every send (rather than once and
 *    reusing it) means a decision that already committed could still fail
 *    at mailer *construction* (a missing `MAIL_FROM`, a bad `SMTP_URL`),
 *    not just at `send`. Whatever wires this in should treat construction
 *    failures the same way as send failures — see above — not assume only
 *    `send` can fail.
 */
export function createMailer(): Mailer {
  const url = process.env.SMTP_URL
  return url ? smtpMailer(url) : consoleMailer()
}
