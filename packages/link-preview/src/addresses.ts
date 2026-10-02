import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Which addresses a fetch on behalf of a user may reach. Whoever fetches an address somebody typed (a radio station, a link
 * in a message) must never be made to ask the machine itself or its private network.
 */
const internal = new BlockList();
// Since 2 October 2026 (security audit S14) also the IETF protocol range 192.0.0.0/24, the benchmark range 198.18.0.0/15 and the
// documentation ranges (never a real host, and some networks route them inward).
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) internal.addSubnet(net, bits, "ipv4");
// No rule for ::ffff:0:0/96: Node's BlockList compares IPv4 and IPv4-mapped IPv6 addresses with each other, so such a rule
// would block every IPv4 address, and the IPv4 rules above already cover the mapped spelling (pinned by the test).
// `::/96` covers the loopback, the unspecified address and the deprecated IPv4-compatible spelling (`::10.0.0.1`); 6to4 (2002::/16),
// Teredo (2001::/32) and the local-use NAT64 prefix carry an IPv4 address inside, which a gateway may turn into an internal one.
for (const [net, bits] of [["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) internal.addSubnet(net, bits, "ipv6");

export function isInternalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const a = mapped ? mapped[1]! : address;
  const family = isIP(a);
  if (family === 0) return true; // not an address at all
  return internal.check(a, family === 6 ? "ipv6" : "ipv4");
}

/** Every address of the host must be public; a name that does not resolve is simply unreachable. */
export async function checkHost(hostname: string): Promise<"public" | "internal" | "unknown"> {
  const host = hostname.replace(/^\[|\]$/g, "");
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addresses.length === 0) return "unknown";
    return addresses.every((a) => !isInternalAddress(a.address)) ? "public" : "internal";
  } catch { return "unknown"; }
}

/**
 * DNS for a connection made with node's http(s).request: the address actually connected to must be public, which closes the
 * gap between `checkHost` and the connect (a name that answers differently the second time). An address typed as a number
 * is never looked up, so `checkHost` stays necessary.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (err, address, family) => {
    const all = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (!err && all.some((a) => isInternalAddress(a))) return callback(Object.assign(new Error("internal address"), { code: "EACCES" }), address as never, family);
    callback(err, address as never, family);
  });
};
