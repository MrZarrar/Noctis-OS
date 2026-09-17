export interface CookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
  path: string;
  maxAgeSeconds: number;
}

/**
 * A `Cookie` header is a semicolon-separated list the client controls entirely.
 * The first occurrence of a name wins: a request that presents the name twice is
 * either confused or an attempt to shadow the real value with a forged one, and
 * taking the first is the only reading a forged suffix cannot change.
 */
export function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const pairs = new Map<string, string>();

  if (header === undefined || header === "") {
    return pairs;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name !== "" && !pairs.has(name)) {
      pairs.set(name, value);
    }
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
