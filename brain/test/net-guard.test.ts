/**
 * Which addresses a model-chosen URL may reach.
 *
 * Every entry in the private list is a place this assistant can reach from the
 * inside and a stranger cannot, which is the whole reason the check exists.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPublicUrl, isPrivateHost } from "../dist/net-guard.js";

test("private and local hosts are recognised", () => {
  for (const host of [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.100",
    "0.0.0.0",
    "[::1]",
    "::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:192.168.1.5",
    "nas.local",
    "router.lan",
    "printer",
    "",
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
});

test("public hosts are not", () => {
  for (const host of ["example.com", "www.rijksoverheid.nl", "8.8.8.8", "172.32.0.1", "100.63.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test("only public http(s) addresses without a login pass", () => {
  assert.equal(checkPublicUrl("https://example.com/a?b=1").ok, true);
  assert.equal(checkPublicUrl("http://192.168.1.1/admin").ok, false);
  assert.equal(checkPublicUrl("file:///etc/passwd").ok, false);
  assert.equal(checkPublicUrl("https://user:pass@example.com/").ok, false);
  assert.equal(checkPublicUrl("not a url").ok, false);
  // The address parser turns other spellings of the same address into the dotted form.
  assert.equal(checkPublicUrl("http://2130706433/").ok, false);
  assert.equal(checkPublicUrl("http://0x7f.1/").ok, false);
});
