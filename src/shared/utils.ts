// ---------------------------------------------------------------------------
// OpsPilot — Shared Utilities
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

/** Generate a cryptographically random UUID v4. */
export function generateId(): string {
  return randomUUID();
}

/**
 * Pause execution for `ms` milliseconds.
 * Useful for graceful shutdown back-off.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deep-freeze an object so it cannot be mutated.
 * Useful for ensuring event payloads and configs stay immutable.
 */
export function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as object);
    }
  }
  return obj;
}
