import Link from 'next/link'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { submissions, lounges } from '@/db/schema'

export default async function AdminHome(): Promise<React.JSX.Element> {
  await requireSession()

  const rows = await db()
    .select({
      id: submissions.id,
      name: lounges.name,
      iata: lounges.iataCode,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .innerJoin(lounges, eq(submissions.loungeId, lounges.id))
    .where(eq(submissions.status, 'submitted'))
    .orderBy(desc(submissions.submittedAt))

  return (
    <main className="admin-home">
      <h1>Awaiting review</h1>
      {rows.length === 0 && <p>Nothing to review right now.</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/admin/s/${row.id}`}>
              {row.name} — {row.iata}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
