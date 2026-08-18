// Issuer details for anything the business puts its name on — erasure
// certificates, costing sheets, invoices. Overridable via env so the same
// codebase can be white-labelled without a code change.
//
// Lifted out of certificates.service.ts, which owned it privately while the
// name was separately hardcoded in four other places (both pallet reports and
// the batch report). Those literals stay for now — this is the one place new
// documents should read from.
export const COMPANY = {
  name: process.env.COMPANY_NAME || 'ALS Trade Wholesales',
  registration: process.env.COMPANY_REG || '11269566',
};
