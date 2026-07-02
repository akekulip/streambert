"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { isBlockedHost, assertPublicHttpUrl } = require("../lib/safeUrl");
test("blocks loopback / private / link-local / internal literals + names", () => {
  for (const h of ["127.0.0.1","0.0.0.0","::1","169.254.169.254","10.0.0.5","192.168.1.1","172.16.0.9","localhost","streambert-extractor","foo.internal","bar.local"])
    assert.equal(isBlockedHost(h), true, h);
});
test("allows normal public hosts", () => {
  for (const h of ["dl.subdl.com","player.videasy.to","example.com","1.1.1.1"])
    assert.equal(isBlockedHost(h), false, h);
});
test("assertPublicHttpUrl throws BLOCKED_URL for non-http and private", () => {
  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), (e)=>e.code==="BLOCKED_URL");
  assert.throws(() => assertPublicHttpUrl("http://127.0.0.1/x"), (e)=>e.code==="BLOCKED_URL");
  assert.throws(() => assertPublicHttpUrl("https://dl.subdl.com@169.254.169.254/x"), (e)=>e.code==="BLOCKED_URL");
  assert.equal(assertPublicHttpUrl("https://dl.subdl.com/a").hostname, "dl.subdl.com");
});
