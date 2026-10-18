import { BlockList, isIP } from "node:net";

const blocked = new BlockList();

blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4");
blocked.addSubnet("240.0.0.0", 4, "ipv4");

blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return true;
  if (version === 4) return blocked.check(address, "ipv4");

  const embedded = embeddedIpv4(address);
  if (embedded) return isBlockedAddress(embedded);
  return blocked.check(address, "ipv6");
}

export function isLoopbackAddress(address: string): boolean {
  const hextets = ipv6Hextets(address);
  if (hextets) {
    if (hextets.every((group, index) => (index < 7 ? group === 0 : group === 1))) return true;
    const mapped = mappedIpv4(hextets);
    if (mapped) return mapped.split(".")[0] === "127";
    return false;
  }
  if (isIP(address) !== 4) return false;
  return address.split(".")[0] === "127";
}

function embeddedIpv4(address: string): string | undefined {
  const hextets = ipv6Hextets(address);
  if (!hextets) return undefined;
  const mapped = mappedIpv4(hextets);
  if (mapped) return mapped;

  const [a, b, c, , , , g, h] = hextets;
  if (a === 0x64 && b === 0xff9b && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0) {
    return dotted(g, h);
  }
  if (a === 0x2002) return dotted(b, c);
  // Teredo stores the client IPv4 inverted (RFC 4380).
  if (a === 0x2001 && b === 0) return dotted(g ^ 0xffff, h ^ 0xffff);
  return undefined;
}

function mappedIpv4(hextets: number[]): string | undefined {
  const [a, b, c, d, e, f, g, h] = hextets;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return dotted(g, h);
  return undefined;
}

function dotted(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function ipv6Hextets(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (normalized.includes(".")) {
    const splitAt = normalized.lastIndexOf(":");
    const tail = normalized.slice(splitAt + 1);
    if (isIP(tail) !== 4) return undefined;
    const octets = tail.split(".").map((part) => Number(part));
    const head = expand(normalized.slice(0, splitAt), 6);
    if (!head || octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return undefined;
    const [o0, o1, o2, o3] = octets;
    if (o0 === undefined || o1 === undefined || o2 === undefined || o3 === undefined) return undefined;
    return [...head, (o0 << 8) | o1, (o2 << 8) | o3];
  }
  return expand(normalized, 8);
}

function expand(input: string, expected: number): number[] | undefined {
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const parse = (value: string): number[] | undefined => {
    if (value === "") return [];
    const groups: number[] = [];
    for (const group of value.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const left = parse(halves[0] ?? "");
  if (!left) return undefined;
  if (halves.length === 1) return left.length === expected ? left : undefined;
  const right = parse(halves[1] ?? "");
  if (!right) return undefined;
  const missing = expected - left.length - right.length;
  if (missing < 0) return undefined;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}
