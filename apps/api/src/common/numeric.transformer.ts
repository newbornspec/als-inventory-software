// Postgres `numeric` columns come back from the driver as strings (to avoid
// float precision loss). This transformer converts them to JS numbers on read
// and passes numbers straight through on write, so money fields are plain
// numbers everywhere in the app.
export const numericTransformer = {
  to: (value?: number | null): number | null | undefined => value,
  from: (value?: string | null): number | null =>
    value === null || value === undefined ? null : parseFloat(value),
};
