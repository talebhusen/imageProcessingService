import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBlockedAddress, isLoopbackAddress } from "../src/http/blockedAddress.js";

describe("blocked addresses", () => {
  it("blocks private, loopback, link-local, cgnat, and metadata ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.20",
      "100.64.0.1",
      "224.0.0.1",
      "::1",
      "::",
      "fc00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::a00:1",
      "2002:7f00:1::",
      "2001:0:0:0:0:0:80ff:fffe",
    ]) {
      assert.equal(isBlockedAddress(address), true, address);
    }
  });

  it("allows public addresses", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "172.15.0.1",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "2002:808:808::",
    ]) {
      assert.equal(isBlockedAddress(address), false, address);
    }
  });

  it("recognizes loopback, including IPv4-mapped loopback", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::ffff:7f00:1"), true);
    assert.equal(isLoopbackAddress("0:0:0:0:0:0:0:1"), true);
    assert.equal(isLoopbackAddress("64:ff9b::7f00:1"), false);
    assert.equal(isLoopbackAddress("10.0.0.1"), false);
    assert.equal(isLoopbackAddress("8.8.8.8"), false);
  });
});
