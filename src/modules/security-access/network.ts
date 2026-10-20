import { BlockList, isIP } from "node:net";

export type IpRuleKind = "ALLOW" | "DENY";
export type IpRuleLike = { kind: IpRuleKind; cidr: string };

/** `::ffff:1.2.3.4` is the IPv4 address 1.2.3.4. */
export function normalizeAddress(address: string) {
  const value = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return mapped ? mapped[1]! : value;
}

/** Accepts an IPv4/IPv6 address or `address/prefix`; returns the normalized `address/prefix` or null. */
export function parseCidr(input: string): { address: string; prefix: number; family: "ipv4" | "ipv6"; text: string } | null {
  const [rawAddress, rawPrefix, ...rest] = input.trim().split("/");
  if (!rawAddress || rest.length) return null;
  const address = normalizeAddress(rawAddress);
  const version = isIP(address);
  if (!version) return null;
  const max = version === 4 ? 32 : 128;
  let prefix = max;
  if (rawPrefix !== undefined) {
    if (!/^\d{1,3}$/.test(rawPrefix)) return null;
    prefix = Number(rawPrefix);
    if (prefix > max) return null;
  }
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6", text: `${address}/${prefix}` };
}

export function matchesCidr(ip: string, cidr: string) {
  const rule = parseCidr(cidr);
  const address = normalizeAddress(ip);
  const version = isIP(address);
  if (!rule || !version || rule.family !== (version === 4 ? "ipv4" : "ipv6")) return false;
  const list = new BlockList();
  list.addSubnet(rule.address, rule.prefix, rule.family);
  return list.check(address, rule.family);
}

/**
 * Deny wins over allow. With no ALLOW rules everything not denied passes; with at least one ALLOW rule the address must match one.
 * An unknown address (null) never passes a list that has ALLOW rules.
 */
export function evaluateIp(ip: string | null | undefined, rules: readonly IpRuleLike[]): { allowed: boolean; reason?: "denied" | "not_allowed" } {
  if (!rules.length) return { allowed: true };
  if (ip && rules.some((rule) => rule.kind === "DENY" && matchesCidr(ip, rule.cidr))) return { allowed: false, reason: "denied" };
  const allow = rules.filter((rule) => rule.kind === "ALLOW");
  if (allow.length && !(ip && allow.some((rule) => matchesCidr(ip, rule.cidr)))) return { allowed: false, reason: "not_allowed" };
  return { allowed: true };
}

/**
 * TRUST_PROXY: `loopback`, one address, or a comma list of addresses/CIDRs of proxies allowed to set X-Forwarded-For.
 * Anything else is dropped (fail closed: nothing is trusted).
 */
export function parseTrustedProxies(value: string | undefined): false | string | string[] {
  if (!value) return false;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const valid = entries.filter((entry) => entry === "loopback" || parseCidr(entry));
  if (!valid.length) return false;
  return valid.length === 1 ? valid[0]! : valid;
}
