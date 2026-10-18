// Run with: npm run test:server   (uses Node's built-in test runner, no extra packages)
const test = require("node:test");
const assert = require("node:assert");
const { sign, verify } = require("../lib/token");
const { toCsv } = require("../lib/csv");
const { createLimiter } = require("../lib/ratelimit");

test("token round trip", () => {
  const t = sign({ address: "0xabc" }, "secret", 60);
  assert.strictEqual(verify(t, "secret").address, "0xabc");
});

test("token rejects wrong secret, tampering, expiry and junk", () => {
  const t = sign({ address: "0xabc" }, "secret", 60);
  assert.strictEqual(verify(t, "other"), null);
  const [h, , s] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ address: "0xevil", exp: 9999999999 })).toString("base64url");
  assert.strictEqual(verify(`${h}.${forged}.${s}`, "secret"), null);
  assert.strictEqual(verify(sign({ a: 1 }, "secret", -10), "secret"), null);
  for (const junk of ["", "a.b", "a.b.c", null, undefined, 42]) assert.strictEqual(verify(junk, "secret"), null);
});

test("csv quoting and formula-injection guard", () => {
  const csv = toCsv(["Name", "Note"], [["=cmd()", 'say "hi", ok'], ["Bob", null]]);
  assert.strictEqual(csv, "Name,Note\r\n'=cmd(),\"say \"\"hi\"\", ok\"\r\nBob,\r\n");
});

test("rate limiter blocks after max", () => {
  const allow = createLimiter({ windowMs: 1000, max: 2 });
  assert.ok(allow("ip").ok);
  assert.ok(allow("ip").ok);
  assert.ok(!allow("ip").ok);
  assert.ok(allow("other").ok);
});
