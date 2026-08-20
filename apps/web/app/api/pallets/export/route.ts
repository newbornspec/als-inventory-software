import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { downloadError } from '@/lib/download-error';

// Streams the API's multi-pallet .xlsx for a selection, attaching the httpOnly
// auth cookie the client fetch can't read — the same shape as the per-pallet
// report route next door.
//
// POST, and reached from a real <form> rather than a link, because the
// selection can be every pallet on the page: a few hundred uuids is more URL
// than a proxy or an access log should be asked to carry. The auth cookie is
// sameSite: 'strict' (see api/auth/login), so a cross-site form can't borrow
// this route — it arrives without a token and gets the 401 page.
export async function POST(req: Request) {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return downloadError(401, 'pallet export');
  }

  const form = await req.formData();
  const ids = String(form.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return downloadError(400, 'pallet export', 'No pallets were selected.');
  }

  const res = await fetch(`${process.env.API_URL}/pallets/export.xlsx`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
    cache: 'no-store',
  });

  if (!res.ok) {
    // Forward the API's own message. Its 400 names the actual remedy ("export
    // up to 500 at a time"); the generic "please try again" sends the operator
    // round a loop that can never succeed. 401/403/404 have their own copy in
    // downloadError, so this only fills the branch that had nothing to say.
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      detail = Array.isArray(body.message) ? body.message.join(' ') : body.message;
    } catch {
      // Not JSON — fall back to the generic copy.
    }
    return downloadError(res.status, 'pallet export', detail);
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':
        res.headers.get('content-disposition') ?? 'attachment; filename="pallets.xlsx"',
      'Cache-Control': 'no-store',
    },
  });
}
