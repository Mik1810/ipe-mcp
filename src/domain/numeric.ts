export const MAX_DOMAIN_MAGNITUDE = 1_000_000_000;
export const MATRIX_SINGULAR_RELATIVE_TOLERANCE = 1e-12;
export const NUMERIC_ABSOLUTE_TOLERANCE = 1e-9;
export const NUMERIC_RELATIVE_TOLERANCE = 1e-12;

export function assertDomainNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  if (Math.abs(value) > MAX_DOMAIN_MAGNITUDE) {
    throw new Error(`${label} must be within ±${MAX_DOMAIN_MAGNITUDE}`);
  }
}

export function numericallyEqual(a: number, b: number): boolean {
  assertDomainNumber(a, "a");
  assertDomainNumber(b, "b");
  return Math.abs(a - b) <= numericTolerance(a, b);
}

export function numericTolerance(...values: readonly number[]): number {
  for (const [index, value] of values.entries()) assertDomainNumber(value, `tolerance value[${index}]`);
  return NUMERIC_ABSOLUTE_TOLERANCE
    + NUMERIC_RELATIVE_TOLERANCE * Math.max(0, ...values.map(Math.abs));
}
