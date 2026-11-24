import { describe, expect, test } from "bun:test";
import { isPublicIpAddress } from "../../domain/ip-address";

// The fetch-time half of the SSRF gate: a public-looking name can resolve
// to a private address, so the resolved address itself must be classified.

describe("isPublicIpAddress — IPv4", () => {
  test("public unicast space is public", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("1.1.1.1")).toBe(true);
    // Just outside the private blocks.
    expect(isPublicIpAddress("11.0.0.1")).toBe(true);
    expect(isPublicIpAddress("100.128.0.1")).toBe(true);
    expect(isPublicIpAddress("172.32.0.1")).toBe(true);
    expect(isPublicIpAddress("192.167.255.255")).toBe(true);
    expect(isPublicIpAddress("198.17.255.255")).toBe(true);
    expect(isPublicIpAddress("223.255.255.255")).toBe(true);
  });

  test("loopback, private and link-local blocks are refused", () => {
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("127.255.255.254")).toBe(false);
    expect(isPublicIpAddress("10.0.0.5")).toBe(false);
    expect(isPublicIpAddress("10.255.255.255")).toBe(false);
    expect(isPublicIpAddress("172.16.0.1")).toBe(false);
    expect(isPublicIpAddress("172.31.255.255")).toBe(false);
    expect(isPublicIpAddress("192.168.1.1")).toBe(false);
    expect(isPublicIpAddress("169.254.169.254")).toBe(false);
    expect(isPublicIpAddress("0.0.0.0")).toBe(false);
    expect(isPublicIpAddress("0.1.2.3")).toBe(false);
  });

  test("the remaining special-use blocks are refused", () => {
    expect(isPublicIpAddress("100.64.0.1")).toBe(false); // carrier-grade NAT
    expect(isPublicIpAddress("100.127.255.255")).toBe(false);
    expect(isPublicIpAddress("192.0.0.1")).toBe(false); // IETF assignments
    expect(isPublicIpAddress("192.0.2.1")).toBe(false); // TEST-NET-1
    expect(isPublicIpAddress("192.88.99.1")).toBe(false); // 6to4 relay
    expect(isPublicIpAddress("198.18.0.1")).toBe(false); // benchmarking
    expect(isPublicIpAddress("198.19.255.255")).toBe(false);
    expect(isPublicIpAddress("198.51.100.1")).toBe(false); // TEST-NET-2
    expect(isPublicIpAddress("203.0.113.1")).toBe(false); // TEST-NET-3
    expect(isPublicIpAddress("224.0.0.1")).toBe(false); // multicast
    expect(isPublicIpAddress("239.255.255.255")).toBe(false);
    expect(isPublicIpAddress("240.0.0.1")).toBe(false); // reserved
    expect(isPublicIpAddress("255.255.255.255")).toBe(false); // broadcast
  });

  test("an unparseable address is refused, never trusted", () => {
    expect(isPublicIpAddress("")).toBe(false);
    expect(isPublicIpAddress("999.1.1.1")).toBe(false);
    expect(isPublicIpAddress("1.2.3")).toBe(false);
    expect(isPublicIpAddress("example.com")).toBe(false);
  });
});

describe("isPublicIpAddress — IPv6", () => {
  test("global unicast is public", () => {
    expect(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
    expect(isPublicIpAddress("2001:4860:4860::8888")).toBe(true);
    expect(isPublicIpAddress("3ffe::1")).toBe(true);
  });

  test("loopback, link-local, unique-local and multicast are refused", () => {
    expect(isPublicIpAddress("::1")).toBe(false);
    expect(isPublicIpAddress("::")).toBe(false);
    expect(isPublicIpAddress("fe80::1")).toBe(false);
    expect(isPublicIpAddress("febf::1")).toBe(false);
    expect(isPublicIpAddress("fc00::1")).toBe(false);
    expect(isPublicIpAddress("fd12:3456::1")).toBe(false);
    expect(isPublicIpAddress("ff02::1")).toBe(false);
    expect(isPublicIpAddress("100::1")).toBe(false); // discard-only
    expect(isPublicIpAddress("64:ff9b::1")).toBe(false); // NAT64
  });

  test("the documentation prefix inside global unicast is refused", () => {
    expect(isPublicIpAddress("2001:db8::1")).toBe(false);
    expect(isPublicIpAddress("2001:db8:1234::abcd")).toBe(false);
  });

  test("IPv4-mapped addresses are classified by the embedded IPv4", () => {
    expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicIpAddress("::ffff:192.168.1.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicIpAddress("::ffff:0808:0808")).toBe(true);
  });
});
