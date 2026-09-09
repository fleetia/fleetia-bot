export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Expected a non-empty string');
  }
  return value;
}

export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Expected a positive integer');
  }
  return value;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected an array');
  }
  return value;
}

export function requiredEnvironment(name: string): string {
  return string(process.env[name]);
}
