/**
 * The HTTP status a remote host answered with, carried as the `cause` of the AmberError a
 * download raises for a status it does not accept. Server-side only: it never becomes part of
 * an AppError or a DTO, so callers that need to tell a gone resource (403 / 404 / 410) from a
 * failing host can do so without parsing log text.
 */
export interface UpstreamHttpStatus {
  readonly upstreamHttpStatus: number;
}

/** The cause to attach: `new AmberError(appError(...), message, { cause: upstreamHttpStatus(status) })`. */
export function upstreamHttpStatus(status: number): UpstreamHttpStatus {
  return { upstreamHttpStatus: status };
}

/** The status an error's `cause` carries, if it carries one. */
export function upstreamHttpStatusOf(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const status: unknown = (cause as Partial<UpstreamHttpStatus>).upstreamHttpStatus;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}
