/**
 * Discord Application ID (snowflake) validation.
 *
 * Fail-fast on obvious junk so connect does not hang on a handshake Discord
 * will never READY. The shipped public snowflake is always accepted.
 * This is not a Discord API lookup — unregistered-but-well-formed ids still
 * reach IPC (a 404 / "not found" reply is then fatal, not retried).
 *
 * @module discord/app-id
 * @author Jonathan Marien
 * @date 2026-09-05
 */

/**
 * Discord snowflakes are 17–20 digits today; accept that range and nothing else.
 *
 * @author Jonathan Marien
 */
export const APPLICATION_ID_RE = /^\d{17,20}$/

/**
 * Result of coercing a persisted or constructed Application ID.
 *
 * @author Jonathan Marien
 */
export type ApplicationIdInspection = {
  /** Id to send in the handshake (`client_id`). */
  applicationId: string
  /**
   * True when a supplied value was rejected and {@link applicationId} is
   * the shipped fallback. Missing/undefined is not a rejection.
   */
  usedFallback: boolean
  /** Trimmed rejected value, when {@link usedFallback} is true. */
  rejectedRaw: string | null
  /** Operator-facing reason, when {@link usedFallback} is true. */
  reason: string | null
}

/**
 * True when `value` looks like a Discord Application ID snowflake.
 *
 * @author Jonathan Marien
 */
export function isPlausibleApplicationId(value: string): boolean {
  return APPLICATION_ID_RE.test(value.trim())
}

/**
 * Inspect a raw persisted Application ID.
 *
 * - Missing / non-string → shipped id, not a rejection.
 * - Valid 17–20 digit snowflake (including the shipped id) → accepted.
 * - Anything else → shipped fallback + reason (log / optional toast).
 *
 * @param raw - Value from settings or constructor.
 * @param shippedId - Plugin default (public snowflake, not a secret).
 * @returns Normalized id plus whether we rejected the input.
 * @author Jonathan Marien
 */
export function inspectApplicationId(raw: unknown, shippedId: string): ApplicationIdInspection {
  if (typeof raw !== 'string') {
    return {
      applicationId: shippedId,
      usedFallback: false,
      rejectedRaw: null,
      reason: null
    }
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return {
      applicationId: shippedId,
      usedFallback: true,
      rejectedRaw: '',
      reason: 'Application ID is empty (expected a 17–20 digit snowflake)'
    }
  }
  if (isPlausibleApplicationId(trimmed) || trimmed === shippedId) {
    return {
      applicationId: trimmed,
      usedFallback: false,
      rejectedRaw: null,
      reason: null
    }
  }
  return {
    applicationId: shippedId,
    usedFallback: true,
    rejectedRaw: trimmed,
    reason: 'Application ID is not a 17–20 digit snowflake'
  }
}

/**
 * Throw if `clientId` is obviously not a Discord snowflake.
 *
 * @author Jonathan Marien
 */
export function assertPlausibleApplicationId(clientId: string): void {
  if (!isPlausibleApplicationId(clientId)) {
    throw new Error(
      'Discord Application ID is invalid (expected a 17–20 digit snowflake). Check the id in settings or use the shipped default.'
    )
  }
}
