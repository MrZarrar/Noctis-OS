export interface CookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
  path: string;
  maxAgeSeconds: number;
}

/**
 * A `Cookie` header is a semicolon-separated list the client controls entirely.
 * A name that appears twice is dropped entirely rather than resolved.
 *
 * Neither reading of a duplicate is safe. RFC 6265 has the browser send the
 * longer path first, so a cookie planted at `Path=/commands` arrives *ahead* of
 * the real one and first-wins hands over the forged value; last-wins loses to a
 * shorter path just the same. `HttpOnly` does not help: it stops a script
 * overwriting this cookie, not a sibling origin creating a different
 * (name, path) tuple. So the rule is the one `headerValue` applies to duplicated
 * request headers — a credential presented twice is not a credential.
 */
export function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const pairs = new Map<string, string>();

  if (header === undefined || header === "") {
    return pairs;
  }

  const duplicated = new Set<string>();

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name === "") {
      continue;
    }

    if (pairs.has(name) || duplicated.has(name)) {
      pairs.delete(name);
      duplicated.add(name);
      continue;
    }

    pairs.set(name, value);
  }

  return pairs;
}

export function serializeCookie(name: string, value: string, attributes: CookieAttributes): string {
  const parts = [
    `${name}=${value}`,
    `Path=${attributes.path}`,
    `Max-Age=${String(attributes.maxAgeSeconds)}`,
  ];

  if (attributes.httpOnly) {
    parts.push("HttpOnly");
  }

  if (attributes.secure) {
    parts.push("Secure");
  }

  parts.push(`SameSite=${attributes.sameSite}`);

  return parts.join("; ");
}
