import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/openses.js", import.meta.url));

/** A stand-in API that records requests and answers from a script. */
async function api(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      const { status = 200, json } = answer(req) ?? {};
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Runs the CLI with its own empty config directory. */
function cli(args, { env = {}, input } = {}) {
  const dir = env.OPENSES_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), "openses-cli-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, OPENSES_CONFIG_DIR: dir, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), dir }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

test("help and version need no key", async () => {
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: openses <command>/);
  assert.match((await cli(["--version"])).stdout, /^\d+\.\d+\.\d+$/);
});

test("send builds the request from flags, files and repeated values", async () => {
  const a = await api(() => ({ status: 201, json: { id: "em_1", status: "sent" } }));
  try {
    const dir = mkdtempSync(join(tmpdir(), "openses-cli-"));
    writeFileSync(join(dir, "body.html"), "<p>Hi {{first_name}}</p>");
    writeFileSync(join(dir, "note.txt"), "attached");
    const r = await cli(["send", "--from", "Acme <hi@acme.com>", "--to", "a@example.com,b@example.com", "--to", "c@example.com", "--subject", "Hello", "--html-file", join(dir, "body.html"),
      "--var", "first_name=Jane", "--tag", "kind=welcome", "--attach", join(dir, "note.txt"), "--idempotency-key", "k1", "--api-url", a.url, "--api-key", "os_test_abc"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "Sent: em_1");
    const [req] = a.seen;
    assert.equal(`${req.method} ${req.url}`, "POST /v1/emails");
    assert.equal(req.headers.authorization, "Bearer os_test_abc");
    assert.equal(req.headers["idempotency-key"], "k1");
    assert.deepEqual(req.body, { from: "Acme <hi@acme.com>", to: ["a@example.com", "b@example.com", "c@example.com"], subject: "Hello", html: "<p>Hi {{first_name}}</p>",
      variables: { first_name: "Jane" }, tags: { kind: "welcome" }, attachments: [{ filename: "note.txt", content: Buffer.from("attached").toString("base64") }] });
  } finally { a.close(); }
});

test("send reads the text from stdin, and refuses an empty email before calling the API", async () => {
  const a = await api(() => ({ status: 202, json: { id: "em_2", status: "scheduled", scheduled_at: "2027-01-05T09:00:00.000Z" } }));
  try {
    const env = { OPENSES_API_URL: a.url, OPENSES_API_KEY: "k" };
    const piped = await cli(["send", "--from", "hi@acme.com", "--to", "a@example.com", "--subject", "S", "--at", "2027-01-05T09:00:00Z"], { env, input: "From a pipe\n" });
    assert.equal(piped.stdout, "Scheduled for 2027-01-05 09:00: em_2");
    assert.equal(a.seen[0].body.text, "From a pipe");
    const empty = await cli(["send", "--from", "hi@acme.com", "--to", "a@example.com"], { env });
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /Nothing to send/);
    assert.equal(a.seen.length, 1);
  } finally { a.close(); }
});

test("lists print a table, --json prints the API's answer", async () => {
  const page = { data: [{ id: "em_1", status: "delivered", to: ["jane@example.com"], subject: "Your invoice", created_at: "2026-11-01T10:20:30.000Z" }], total: 40, page: 1, limit: 1 };
  const a = await api(() => ({ json: page }));
  try {
    const env = { OPENSES_API_URL: a.url, OPENSES_API_KEY: "k" };
    const out = await cli(["emails", "list", "--status", "delivered", "--limit", "1"], { env });
    assert.equal(a.seen[0].url, "/v1/emails?status=delivered&limit=1");
    assert.match(out.stdout, /^ID\s+STATUS\s+TO\s+SUBJECT\s+CREATED\n/);
    assert.match(out.stdout, /em_1\s+delivered\s+jane@example\.com\s+Your invoice\s+2026-11-01 10:20/);
    assert.match(out.stdout, /1 of 40 \(page 1\)/);
    assert.deepEqual(JSON.parse((await cli(["emails", "--json"], { env })).stdout), page);
  } finally { a.close(); }
});

test("commands reach the routes the API serves", async () => {
  const a = await api((req) => ({ status: req.method === "DELETE" ? 204 : 200, json: req.method === "DELETE" ? undefined : { data: [], contact: { topics: [], properties: {} }, template: { variables: [] }, to: [], topics: [], variables: [], messages: [], events: [] } }));
  try {
    const env = { OPENSES_API_URL: a.url, OPENSES_API_KEY: "k" };
    const runs = [
      ["emails", "get", "em_1"], ["emails", "cancel", "em_1"],
      ["contacts", "list", "--unsubscribed", "--topic", "News"], ["contacts", "add", "a@example.com", "--name", "A", "--topic", "News", "--prop", "plan=pro"], ["contacts", "unsubscribe", "c1"], ["contacts", "rm", "c1"],
      ["sequences", "enroll", "s1", "a@example.com"], ["sequences", "stop", "s1", "c1"],
      ["suppressions", "add", "a@example.com", "--note", "asked"], ["suppressions", "rm", "a+b@example.com"],
      ["templates", "push", "Welcome", "--subject", "Hi", "--html", "<p>x</p>"], ["threads", "reply", "t1", "--text", "Thanks"], ["threads", "archive", "t1"],
      ["webhooks", "add", "https://example.com/hook", "--event", "email.delivered,email.bounced"], ["webhooks", "rm", "wh1"], ["domains"], ["topics"], ["inboxes"],
    ];
    for (const args of runs) { const r = await cli(args, { env }); assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`); }
    assert.deepEqual(a.seen.map((r) => `${r.method} ${r.url}`), [
      "GET /v1/emails/em_1", "POST /v1/emails/em_1/cancel",
      "GET /v1/contacts?topic=News&subscribed=false", "POST /v1/contacts", "POST /v1/contacts/c1/unsubscribe", "DELETE /v1/contacts/c1",
      "POST /v1/sequences/s1/enroll", "POST /v1/sequences/s1/stop",
      "POST /v1/suppressions", "DELETE /v1/suppressions/a%2Bb%40example.com",
      "PUT /v1/templates", "POST /v1/threads/t1/reply", "PATCH /v1/threads/t1",
      "POST /v1/webhooks", "DELETE /v1/webhooks/wh1", "GET /v1/domains", "GET /v1/topics", "GET /v1/inboxes",
    ]);
    assert.deepEqual(a.seen[3].body, { email: "a@example.com", name: "A", topics: ["News"], properties: { plan: "pro" } });
    assert.deepEqual(a.seen[6].body, { email: "a@example.com" });
    assert.deepEqual(a.seen[7].body, { contact_id: "c1" });
    assert.deepEqual(a.seen[12].body, { archived: true });
    assert.deepEqual(a.seen[13].body, { url: "https://example.com/hook", events: ["email.delivered", "email.bounced"] });
  } finally { a.close(); }
});

test("an API error is printed with its code and exits 1; a missing key says how to get one", async () => {
  const a = await api(() => ({ status: 400, json: { error: { code: "domain_not_verified", message: "acme.com is not verified yet" } } }));
  try {
    const r = await cli(["send", "--from", "hi@acme.com", "--to", "a@example.com", "--text", "x", "--api-url", a.url, "--api-key", "k"]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "error: acme.com is not verified yet (domain_not_verified)");
    const none = await cli(["domains", "--api-url", a.url]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /No API key\. Run `openses login`/);
    const typo = await cli(["emials"], { env: { OPENSES_API_KEY: "k" } });
    assert.equal(typo.code, 2);
  } finally { a.close(); }
});

test("login checks the key, saves it readable only by the user, and later commands use it", async () => {
  const a = await api((req) => (req.headers.authorization === "Bearer os_test_good" ? { json: { data: [{ name: "acme.com", status: "verified" }] } } : { status: 401, json: { error: { code: "unauthorized", message: "invalid API key" } } }));
  try {
    const bad = await cli(["login", "--api-url", a.url, "--api-key", "os_test_bad"]);
    assert.equal(bad.code, 1);
    const ok = await cli(["login", "--api-url", a.url + "/", "--api-key", "os_test_good"], { env: { OPENSES_CONFIG_DIR: bad.dir } });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /This key reaches 1 domain: acme\.com\./);
    const path = join(bad.dir, "config.json");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { apiUrl: a.url, apiKey: "os_test_good" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const who = await cli(["whoami"], { env: { OPENSES_CONFIG_DIR: bad.dir } });
    assert.match(who.stdout, /Key\s+os_test_good… \(from .*config\.json\)/);
    assert.match(who.stdout, /acme\.com \(verified\)/);
    assert.equal((await cli(["logout"], { env: { OPENSES_CONFIG_DIR: bad.dir } })).code, 0);
    assert.equal((await cli(["whoami"], { env: { OPENSES_CONFIG_DIR: bad.dir } })).code, 1);
  } finally { a.close(); }
});
