export function assertPositiveInt(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer, got ${String(value)}`);
  }
}
