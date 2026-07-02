"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { isBlockedHost, assertPublicHttpUrl, safeFetch } = require("../lib/safeUrl");
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
test("blocks IPv4-mapped IPv6 and trailing-dot hosts", () => {
  for (const h of ["::ffff:127.0.0.1","::ffff:169.254.169.254","localhost.","foo.internal.","streambert-extractor."])
    assert.equal(isBlockedHost(h), true, h);
});
test("blocks IPv4-mapped IPv6 in its URL-canonicalized hex form", () => {
  // new URL("http://[::ffff:127.0.0.1]/").hostname normalizes to "[::ffff:7f00:1]"
  // rather than preserving the dotted-quad form — must be caught too.
  assert.equal(new URL("http://[::ffff:127.0.0.1]/").hostname, "[::ffff:7f00:1]");
  for (const h of ["[::ffff:7f00:1]","::ffff:a9fe:a9fe"])
    assert.equal(isBlockedHost(h), true, h);
});
test("safeFetch blocks disallowed hosts before making a request", async () => {
  // A local http.createServer for a genuine redirect-chain test would itself
  // bind to a blocked address (127.0.0.1/localhost), so the initial request
  // would be rejected before ever reaching the redirect-following code —
  // these cases exercise the same assertResolvedPublic() gate safeFetch runs
  // on every hop (including redirect targets), just against the entry URL.
  await assert.rejects(() => safeFetch("http://169.254.169.254/"), (e) => e.code === "BLOCKED_URL");
  await assert.rejects(() => safeFetch("http://127.0.0.1/x"), (e) => e.code === "BLOCKED_URL");
  await assert.rejects(() => safeFetch("http://[::ffff:127.0.0.1]/"), (e) => e.code === "BLOCKED_URL");
});
