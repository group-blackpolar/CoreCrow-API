import type { IncomingHttpHeaders } from "node:http";
export function webHeaders(source: IncomingHttpHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source))
    if (value)
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  return headers;
}
