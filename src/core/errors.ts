import type { BackendId } from "./adapter.js";

/**
 * The kind of failure an adapter hit while trying to list slots.
 * - 'blocked'  : anti-bot / 403 / captcha — we backed off (see THE BRIGHT LINE).
 * - 'parse'    : upstream shape changed / could not be normalized to Slot[].
 * - 'network'  : transport-level failure (DNS, timeout, 5xx).
 * - 'auth'     : the backend demanded a login we do not (and will not) perform.
 */
export type AdapterErrorKind = "blocked" | "parse" | "network" | "auth";

/**
 * The single error type every AvailabilityAdapter throws when it cannot produce
 * a normalized Slot[]. Never return [] to signal breakage — throw this instead
 * (invariant I1). Carries enough context to route/retry without unwrapping the
 * original cause.
 */
export class AdapterError extends Error {
  readonly backendId: BackendId;
  readonly courseId: string;
  readonly kind: AdapterErrorKind;
  readonly retryable: boolean;

  constructor(params: {
    backendId: BackendId;
    courseId: string;
    kind: AdapterErrorKind;
    retryable: boolean;
    message?: string;
    cause?: unknown;
  }) {
    const { backendId, courseId, kind, retryable, message, cause } = params;
    super(message ?? `[${backendId}] ${kind} error for course ${courseId}`, {
      cause,
    });
    this.name = "AdapterError";
    this.backendId = backendId;
    this.courseId = courseId;
    this.kind = kind;
    this.retryable = retryable;

    // Preserve prototype chain for `instanceof` under transpilation.
    Object.setPrototypeOf(this, AdapterError.prototype);
  }
}
