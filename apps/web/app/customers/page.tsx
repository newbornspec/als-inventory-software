import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import { deleteCustomer, type Customer } from '@/lib/actions/customers';
import { Nav } from '@/app/components/nav';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const { search } = await searchParams;
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  const [customers, user] = await Promise.all([
    apiFetch<Customer[]>(`/customers${qs}`),
    getSessionUser(),
  ]);
  const canCreate = user?.role === 'admin' || user?.role === 'manager';
  const canDelete = user?.role === 'admin';

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Customers</h1>
          {canCreate && (
            <Link
              href="/customers/new"
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
            >
              New Customer
            </Link>
          )}
        </div>

        <form action="/customers" className="mt-4 max-w-sm">
          <input
            name="search"
            defaultValue={search ?? ''}
            placeholder="Search name or email…"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </form>

        <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Phone</th>
                {canDelete && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-t border-neutral-800 hover:bg-neutral-900">
                  <td className="px-4 py-3 text-neutral-100">{c.name}</td>
                  <td className="px-4 py-3 text-neutral-400">{c.email ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-400">{c.phone ?? '—'}</td>
                  {canDelete && (
                    <td className="px-4 py-3 text-right">
                      <form action={deleteCustomer.bind(null, c.id)}>
                        <button type="submit" className="text-xs text-red-400 hover:underline">
                          Delete
                        </button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
              {customers.length === 0 && (
                <tr>
                  <td colSpan={canDelete ? 4 : 3} className="px-4 py-8 text-center text-neutral-500">
                    No customers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
