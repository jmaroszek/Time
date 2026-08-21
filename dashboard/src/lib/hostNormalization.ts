// Host normalization is a storage boundary shared by Website rules and the
// user-added media-site list. Keep this deliberately dependency-free so the
// dashboard and tracker can implement the same contract from one fixture.

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_SHAPE = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PORT = /^[0-9]+$/;

function containsWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      /\s/u.test(character)
      || codePoint < 0x20
      || (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function isValidPort(port: string): boolean {
  if (!PORT.test(port)) return false;
  // Compare the zero-trimmed decimal form so leading zeroes do not make the
  // TypeScript and Python implementations disagree about an otherwise valid
  // port, and avoid converting an arbitrarily long string to a number.
  const significant = port.replace(/^0+/, "") || "0";
  return significant.length < 5
    || (significant.length === 5 && significant <= "65535");
}

function canonicalIpv6(host: string): string | null {
  try {
    // WHATWG URL parsing supplies the same lowercase, compressed IPv6 form as
    // Python's ipaddress.ip_address without adding a package to the desktop.
    const hostname = new URL(`http://[${host}]`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
    const canonical = hostname.slice(1, -1).toLowerCase();
    // Python's ipaddress preserves IPv4-mapped addresses in dotted form,
    // including when the input used their hexadecimal tail. Match that
    // representation rather than leaking WHATWG URL's hex-only spelling.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (!mapped) return canonical;
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return `::ffff:${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  } catch {
    return null;
  }
}

function cleanHost(host: string): string | null {
  if (containsWhitespaceOrControl(host)) return null;
  let candidate = host.toLowerCase();
  if (
    !candidate
    || candidate.includes("[")
    || candidate.includes("]")
    || candidate.includes("%")
  ) return null;
  if (candidate.endsWith(".")) {
    candidate = candidate.slice(0, -1);
    // One root-label dot is valid; another dot leaves an empty DNS label.
    if (candidate.endsWith(".")) return null;
  }
  if (candidate.startsWith("www.")) candidate = candidate.slice(4);
  if (!candidate || candidate.length > 253) return null;

  if (candidate.includes(":")) return canonicalIpv6(candidate);
  if (IPV4_SHAPE.test(candidate)) {
    return candidate.split(".").every((octet) => Number(octet) <= 255)
      ? candidate
      : null;
  }
  if (candidate === "localhost") return candidate;
  const labels = candidate.split(".");
  if (labels.length < 2 || labels.every((label) => /^\d+$/.test(label))) {
    return null;
  }
  if (!labels.every((label) => HOST_LABEL.test(label))) return null;
  return candidate;
}

/** Normalize a typed or pasted site into the lowercase host storage shape. */
export function normalizeHost(raw: string): string | null {
  let candidate = raw.trim();
  if (!candidate || containsWhitespaceOrControl(candidate)) return null;

  const scheme = SCHEME.exec(candidate);
  if (scheme) candidate = candidate.slice(scheme[0].length);
  for (const separator of ["/", "?", "#"]) {
    candidate = candidate.split(separator, 1)[0] ?? "";
  }
  // Userinfo before the port: "user:pass@host" holds a colon of its own.
  const at = candidate.lastIndexOf("@");
  if (at >= 0) candidate = candidate.slice(at + 1);

  if (candidate.startsWith("[")) {
    const closing = candidate.indexOf("]");
    if (closing < 0) return null;
    const host = candidate.slice(1, closing);
    const suffix = candidate.slice(closing + 1);
    if (!host.includes(":")) return null;
    if (suffix && (!suffix.startsWith(":") || !isValidPort(suffix.slice(1)))) {
      return null;
    }
    return cleanHost(host);
  }
  if (candidate.includes("[") || candidate.includes("]")) return null;

  // A single colon can delimit a port. Multiple colons are left intact for
  // bare IPv6, which is then validated and compressed by the URL parser.
  if (candidate.indexOf(":") === candidate.lastIndexOf(":")) {
    const colon = candidate.indexOf(":");
    if (colon >= 0) {
      const port = candidate.slice(colon + 1);
      if (!isValidPort(port)) return null;
      candidate = candidate.slice(0, colon);
    }
  }
  return cleanHost(candidate);
}
