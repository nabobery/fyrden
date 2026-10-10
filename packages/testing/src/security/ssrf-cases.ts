/**
 * Shared SSRF cases. Every outbound path that fetches a user-supplied URL
 * runs these against the guard it uses.
 */
export const DENIED_IP_URLS: readonly string[] = [
  // IPv4: unspecified, private, loopback, link-local (cloud metadata), CGNAT, benchmark, multicast, reserved, broadcast
  "http://0.0.0.0/",
  "http://10.0.0.1/",
  "http://100.64.0.1/",
  "http://127.0.0.1/",
  "http://127.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://017700000001/",
  "http://169.254.169.254/latest/meta-data/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.0.0.8/",
  "http://192.0.2.1/",
  "http://192.168.1.1/",
  "http://198.18.0.1/",
  "http://198.51.100.7/",
  "http://203.0.113.9/",
  "http://224.0.0.1/",
  "http://240.0.0.1/",
  "http://255.255.255.255/",
  // IPv6: unspecified, loopback, mapped and translated IPv4, unique-local, link-local, site-local, multicast, documentation, 6to4, Teredo
  "http://[::]/",
  "http://[::1]/",
  "http://[0:0:0:0:0:0:0:1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:7f00:1]/",
  "http://[::ffff:169.254.169.254]/",
  "http://[64:ff9b::a00:1]/",
  "http://[fc00::1]/",
  "http://[fd12:3456:789a::1]/",
  "http://[fe80::1]/",
  "http://[fec0::1]/",
  "http://[ff02::1]/",
  "http://[2001:db8::1]/",
  "http://[2002:7f00:1::]/",
  "http://[2001:0:4136:e378::1]/",
  // Special-purpose ranges outside 2000::/3: discard, dummy prefix (RFC 9780),
  // SRv6 SIDs (RFC 9602), local-use NAT64, IPv4-translated, and the edges of 2000::/3.
  "http://[100::1]/",
  "http://[100:0:0:1::1]/",
  "http://[5f00::1]/",
  "http://[64:ff9b:1::a00:1]/",
  "http://[::ffff:0:a00:1]/",
  "http://[1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/",
  "http://[4000::1]/",
  "http://[3fff::1]/",
];

export const DENIED_NAME_URLS: readonly string[] = [
  "http://localhost/",
  "http://LOCALHOST./",
  "http://api.localhost/",
  "http://intranet/",
];

export const DENIED_SCHEME_URLS: readonly string[] = [
  "file:///etc/passwd",
  "ftp://example.com/",
  "gopher://example.com/",
  "data:text/plain,hi",
  "javascript:alert(1)",
];

export const DENIED_CREDENTIAL_URLS: readonly string[] = ["https://user:pass@example.com/"];

export const ALLOWED_IP_URLS: readonly string[] = [
  "https://1.1.1.1/",
  "https://8.8.8.8:8443/hook",
  "https://[2606:4700:4700::1111]/",
  "https://[2000::1]/",
  "https://[3fff:ffff::1]/",
  "https://[64:ff9b::808:808]/",
];
