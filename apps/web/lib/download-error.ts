import { NextResponse } from 'next/server';

// A download link NAVIGATES the browser, so returning JSON from these routes
// makes the browser save the error payload under the file's name. The operator
// then opens a "spreadsheet" that is really `{"message":"..."}`, and Excel
// reports a corrupt file — which is what a permission refusal looked like.
// Return a readable page instead, saying plainly what happened.
export function downloadError(status: number, what: string, detail?: string) {
  const title =
    status === 401
      ? 'Your session has expired'
      : status === 403
        ? 'You do not have permission'
        : status === 404
          ? 'Not found'
          : `Could not produce the ${what}`;

  const help =
    status === 401
      ? 'Sign in again, then retry the export.'
      : status === 403
        ? `Your account is not allowed to export this ${what}. Ask an administrator if you need access.`
        : status === 404
          ? `That ${what} no longer exists — it may have been deleted.`
          : detail || 'Please try again. If it keeps happening, contact an administrator.';

  const html = `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>
 body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#0a0a0a;
      background:#fff;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px}
 .c{max-width:520px;border:1px solid #e5e5e5;border-radius:14px;padding:28px;
    box-shadow:0 10px 30px rgba(15,23,42,.04)}
 h1{margin:0 0 8px;font-size:20px;font-weight:600}
 p{margin:0 0 18px;color:#737373}
 a{display:inline-block;background:#2b7fff;color:#fff;text-decoration:none;
   padding:10px 16px;border-radius:10px;font-weight:500}
</style>
<div class="c"><h1>${title}</h1><p>${help}</p><a href="javascript:history.back()">Go back</a></div>`;

  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
