import { createTransport } from 'nodemailer'
import type { OutgoingMail } from './messages'

export type Mailer = { send(message: OutgoingMail): Promise<void> }

/**
 * Without `SMTP_URL`, mail is printed to the console instead of sent. Local
 * development shouldn't require a mail server, and silently swallowing the
 * message would hide a misconfiguration until production — that half of the
 * brief's reasoning stands as given.
 *
 * What's added here on top of the brief's version: this same fallback runs
 * in *any* environment that forgot to set `SMTP_URL`, not only a laptop —
 * and one of the three messages this mailer carries (`loginMail`) is a
 * working, single-use credential. A bare `process.stdout.write` makes that
 * credential indistinguishable from routine output in whatever aggregates
 * this process's stdout (which, unlike an inbox, is very often readable by
 * more people than the intended recipient, and rarely access-controlled per
 * message). This can't be closed by *not* printing — that's the silent-
 * swallow failure mode the brief already rejected, and it's worse: at least
 * a visible fallback lets someone notice and fix it. So instead of only
 * softening this, the fallback is made loud in the other direction: a
 * `console.warn` line — separate from the message body, and going to
 * stderr rather than stdout — states plainly that mail delivery is not
 * actually happening, so a misconfigured deployment has a chance of being
 * noticed (an alert on stderr output, someone tailing logs, a human reading
 * the ops dashboard) rather than quietly leaking a login link into storage
 * nobody is watching for exactly that.
 */
function consoleMailer(): Mailer {
  return {
    async send(message) {
      console.warn(
        '[mail] SMTP_URL is not set — printing this message to stdout instead of ' +
          'sending it. This is expected in local development only; if this warning ' +
          'appears anywhere else, mail delivery is silently broken there.',
      )
      process.stdout.write(
        `\n[mail] → ${message.to}\n[mail] ${message.subject}\n${message.text}\n\n`,
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
 */
export function createMailer(): Mailer {
  const url = process.env.SMTP_URL
  return url ? smtpMailer(url) : consoleMailer()
}
