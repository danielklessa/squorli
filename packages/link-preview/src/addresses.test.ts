import { describe, expect, it } from "vitest";
import { checkHost, isInternalAddress } from "./addresses";

describe("isInternalAddress", () => {
  it("refuses the private, loopback, link-local, shared, documentation and protocol ranges", () => {
    for (const a of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255"]) expect(isInternalAddress(a), a).toBe(true);
  });
  it("refuses the IPv6 forms that stand for an internal address", () => {
    for (const a of ["::", "::1", "::10.0.0.1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2001::1", "2001:db8::1", "2002:c0a8:101::1", "fc00::1", "fd12::1", "fe80::1", "fec0::1", "ff02::1"]) expect(isInternalAddress(a), a).toBe(true);
    // The IPv4-mapped spelling follows the IPv4 rules, in both directions.
    expect(isInternalAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isInternalAddress("::ffff:192.168.0.5")).toBe(true);
    expect(isInternalAddress("::ffff:93.184.216.34")).toBe(false);
  });
  it("lets public addresses through, and refuses what is no address", () => {
    for (const a of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "198.20.0.1", "192.0.3.1", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001::1"]) expect(isInternalAddress(a), a).toBe(false);
    expect(isInternalAddress("not-an-address")).toBe(true);
    expect(isInternalAddress("")).toBe(true);
  });
});

describe("checkHost", () => {
  it("judges an address typed as a number without any lookup", async () => {
    expect(await checkHost("127.0.0.1")).toBe("internal");
    expect(await checkHost("[::1]")).toBe("internal");
    expect(await checkHost("93.184.216.34")).toBe("public");
  });
});
