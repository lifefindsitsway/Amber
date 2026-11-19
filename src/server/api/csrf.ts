import type { FastifyRequest } from "fastify";

/** The only routes whose body may be multipart; every other unsafe request with a simple form content type is refused. */
const MULTIPART_ROUTES = new Set(["POST /api/contents/upload", "POST /api/contents/:id/figures/upload"]);

/** Content types a cross-site HTML form can send without a preflight. */
const SIMPLE_FORM_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);

/**
 * The six CSRF rules for an unsafe method in server mode; all must hold. Returns
 * the name of the first rule broken, for logs, or `undefined` when the request passes.
 * Rule 1 (the `__Host-` cookie with `SameSite=Lax`) is enforced where the cookie is set.
 */
export function checkCsrf(request: FastifyRequest, publicOrigin: string): string | undefined {
  // 2. A custom header: cross-site forms cannot set one, and cross-site fetch needs a preflight.
  if (request.headers["x-amber-request"] !== "1") {
    return "custom_header";
  }
  // 3. An Origin, when present, is exactly the Amber origin.
  const origin = single(request.headers["origin"]);
  if (origin !== undefined && origin !== publicOrigin) {
    return "origin";
  }
  // 4. Fetch Metadata: cross-site is refused; same-site is not same-origin and must prove itself.
  const site = single(request.headers["sec-fetch-site"]);
  if (site === "cross-site") {
    return "fetch_site";
  }
  if (site !== "same-origin") {
    // 5. Without a same-origin verdict the Origin, else the Referer, must name the Amber origin.
    if (origin === undefined && refererOrigin(single(request.headers["referer"])) !== publicOrigin) {
      return "origin_missing";
    }
  }
  // 6. No simple form content type on JSON endpoints; only the upload routes take multipart.
  const contentType = single(request.headers["content-type"])?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== undefined && SIMPLE_FORM_TYPES.has(contentType)) {
    const route = `${request.method} ${request.routeOptions.url ?? ""}`;
    if (!(contentType === "multipart/form-data" && MULTIPART_ROUTES.has(route))) {
      return "content_type";
    }
  }
  return undefined;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function refererOrigin(referer: string | undefined): string | undefined {
  if (referer === undefined) {
    return undefined;
  }
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
