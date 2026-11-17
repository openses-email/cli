#!/usr/bin/env node
/**
 * openses: the OpenSES command line. Sends email, shows what happened to it, and manages
 * contacts, templates, sequences, suppressions, the inbox and webhooks through the public API.
 *
 * The API key comes from --api-key, then OPENSES_API_KEY, then the file `openses login` wrote.
 * The API address comes from --api-url, then OPENSES_API_URL, then that file, then OpenSES Cloud.
 */
import { parseArgs } from "node:util";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_API = "https://api.openses.email";
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version;

const HELP = `openses ${VERSION}: OpenSES from the command line

Usage: openses <command> [arguments] [options]

Setup
  login                         Save an API key (and your API address when you self-host)
  logout                        Forget the saved key
  whoami                        Show which API and key are in use, and the domains the key reaches

Email
  send                          Send an email
      --from <address>  --to <address>…  --subject <text>
      --html <html> | --html-file <path>   --text <text> | --text-file <path>
      --template <id or name>  --var key=value…
      --cc, --bcc, --reply-to <address>…   --tag key=value…   --attach <path>…
      --at <ISO time>           Schedule it        --idempotency-key <key>
  emails list                   --status, --tag, --q, --days, --domain, --limit, --page
  emails get <id>               One email with its events
  emails cancel <id>            Cancel a scheduled email

Audience
  contacts list                 --q, --topic, --subscribed, --unsubscribed, --domain, --limit, --page
  contacts add <email>          --name, --company, --topic <name>…, --prop key=value…, --domain
  contacts get|unsubscribe|rm <id>
  sequences list                --domain
  sequences enroll|stop <id> <email or contact id>
  suppressions list             --q, --reason bounce|complaint|manual, --limit, --page
  suppressions add <email>      --note <text>
  suppressions rm <email>
  topics                        List topics

Content
  templates list                --domain
  templates get <id>
  templates push <name>         --subject <text>  --html-file <path>  [--text-file <path>] [--domain]

Inbox
  inboxes                       List inboxes with unread counts
  threads list                  --unread, --archived, --inbox <address or id>, --q, --limit, --offset
  threads get <id>
  threads reply <id>            --text <text>, or pipe the reply on stdin
  threads archive|unarchive|read|unread <id>

Account
  domains                       List domains
  webhooks list
  webhooks add <url>            --event <name>…  [--description <text>]
  webhooks rm <id>

Options everywhere
  --json                        Print the API's answer as JSON
  --api-key <key>               Default: OPENSES_API_KEY, then the saved key
  --api-url <url>               Your self-hosted API. Default: OPENSES_API_URL, then the saved address, then OpenSES Cloud
  -h, --help    -v, --version
`;

class Fail extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
const usage = (message) => new Fail(`${message}\nRun \`openses --help\` for the commands.`, 2);

// ----- configuration -----
const configPath = () => join(process.env.OPENSES_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "openses"), "config.json");
function readConfig() {
  try { return JSON.parse(readFileSync(configPath(), "utf8")); } catch { return {}; }
}
function settings(flags) {
  const saved = readConfig();
  const apiUrl = (flags["api-url"] || process.env.OPENSES_API_URL || saved.apiUrl || DEFAULT_API).replace(/\/+$/, "");
  try { new URL(apiUrl); } catch { throw usage(`"${apiUrl}" is not a URL.`); }
  const apiKey = flags["api-key"] || process.env.OPENSES_API_KEY || saved.apiKey || "";
  return { apiUrl, apiKey, source: flags["api-key"] ? "--api-key" : process.env.OPENSES_API_KEY ? "OPENSES_API_KEY" : saved.apiKey ? configPath() : null };
}

// ----- the API -----
async function call(cfg, method, path, { query, body, headers } = {}) {
  if (!cfg.apiKey) throw new Fail("No API key. Run `openses login`, or set OPENSES_API_KEY.");
  const url = new URL(`${cfg.apiUrl}/v1${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${cfg.apiKey}`, accept: "application/json", "user-agent": `openses-cli/${VERSION}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Fail(`Could not reach ${url.host}: ${err?.cause?.message ?? err?.message ?? err}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const e = data?.error;
    throw new Fail(`${e?.message ?? (text.slice(0, 200) || res.statusText)}${e?.code ? ` (${e.code})` : ` (HTTP ${res.status})`}`);
  }
  return data;
}

// ----- output -----
const cut = (value, max) => { const s = String(value ?? ""); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const when = (iso) => (iso ? String(iso).replace("T", " ").slice(0, 16) : "");
function table(rows, columns) {
  if (!rows.length) return "Nothing to show.";
  const cells = rows.map((r) => columns.map(([, get, max = 48]) => cut(get(r), max)));
  const widths = columns.map(([title], i) => Math.max(title.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [line(columns.map(([title]) => title.toUpperCase())), ...cells.map(line)].join("\n");
}
const fields = (pairs) => { const w = Math.max(...pairs.map(([k]) => k.length)); return pairs.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k.padEnd(w)}  ${v}`).join("\n"); };
const footer = (r) => (r.total > r.data.length ? `\n${r.data.length} of ${r.total} (page ${r.page}). Use --page and --limit for more.` : "");

// ----- small helpers -----
const many = (value) => (value ?? []).flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
function pairs(values, flag) {
  const out = {};
  for (const item of values ?? []) {
    const i = item.indexOf("=");
    if (i < 1) throw usage(`--${flag} takes key=value, got "${item}".`);
    out[item.slice(0, i)] = item.slice(i + 1);
  }
  return Object.keys(out).length ? out : undefined;
}
function file(path, flag) {
  try { return readFileSync(path, "utf8"); } catch { throw new Fail(`Cannot read ${path} (--${flag}).`); }
}
const need = (value, what) => { if (!value) throw usage(`Missing ${what}.`); return value; };
const who = (ref) => (ref.includes("@") ? { email: ref } : { contact_id: ref });
async function stdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(question); };
    rl.question(question, (answer) => { rl.close(); if (hidden && process.stdin.isTTY) process.stdout.write("\n"); resolve(answer.trim()); });
  });
}

// ----- commands -----
const OPTIONS = {
  json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  "api-key": { type: "string" }, "api-url": { type: "string" },
  from: { type: "string" }, to: { type: "string", multiple: true }, cc: { type: "string", multiple: true }, bcc: { type: "string", multiple: true }, "reply-to": { type: "string", multiple: true },
  subject: { type: "string" }, html: { type: "string" }, text: { type: "string" }, "html-file": { type: "string" }, "text-file": { type: "string" },
  template: { type: "string" }, var: { type: "string", multiple: true }, tag: { type: "string", multiple: true }, attach: { type: "string", multiple: true },
  at: { type: "string" }, "idempotency-key": { type: "string" },
  status: { type: "string" }, q: { type: "string" }, days: { type: "string" }, domain: { type: "string" }, limit: { type: "string" }, page: { type: "string" }, offset: { type: "string" },
  topic: { type: "string", multiple: true }, subscribed: { type: "boolean" }, unsubscribed: { type: "boolean" }, name: { type: "string" }, company: { type: "string" }, prop: { type: "string", multiple: true },
  reason: { type: "string" }, note: { type: "string" }, unread: { type: "boolean" }, archived: { type: "boolean" }, inbox: { type: "string" },
  event: { type: "string", multiple: true }, description: { type: "string" },
};

async function run(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }); } catch (err) { throw usage(err.message); }
  const { values: f, positionals: [command, ...rest] } = parsed;
  if (f.version) return VERSION;
  if (f.help || !command || command === "help") return HELP;
  const cfg = settings(f);
  const show = (data, text) => (f.json ? JSON.stringify(data, null, 2) : text);
  const sub = rest[0];
  const paging = { limit: f.limit, page: f.page };

  switch (command) {
    case "login": {
      const apiUrl = f["api-url"] || (await ask(`API address [${cfg.apiUrl}]: `)) || cfg.apiUrl;
      const apiKey = f["api-key"] || (await ask("API key (from the dashboard, API & MCP): ", true));
      if (!apiKey) throw usage("No API key given.");
      const next = { apiUrl: apiUrl.replace(/\/+$/, ""), apiKey };
      const { data } = await call({ ...next }, "GET", "/domains");
      mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
      writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      chmodSync(configPath(), 0o600);
      return `Saved to ${configPath()}. This key reaches ${data.length} domain${data.length === 1 ? "" : "s"}${data.length ? `: ${data.map((d) => d.name).join(", ")}` : ""}.`;
    }
    case "logout":
      if (existsSync(configPath())) rmSync(configPath());
      return "Saved key removed.";
    case "whoami": {
      const { data } = await call(cfg, "GET", "/domains");
      return show({ api: cfg.apiUrl, key: `${cfg.apiKey.slice(0, 12)}…`, key_from: cfg.source, domains: data.map((d) => d.name) },
        fields([["API", cfg.apiUrl], ["Key", `${cfg.apiKey.slice(0, 12)}… (from ${cfg.source})`], ["Domains", data.map((d) => `${d.name} (${d.status})`).join(", ") || "none"]]));
    }

    case "send": {
      const html = f["html-file"] ? file(f["html-file"], "html-file") : f.html;
      const text = f["text-file"] ? file(f["text-file"], "text-file") : f.text ?? (!html && !f.template ? await stdin() : undefined);
      const to = many(f.to);
      if (!to.length) throw usage("Missing --to.");
      if (!html && !text && !f.template) throw usage("Nothing to send: pass --html, --text, a file, a --template, or pipe text on stdin.");
      const attachments = (f.attach ?? []).map((path) => {
        try { return { filename: basename(path), content: readFileSync(path).toString("base64") }; } catch { throw new Fail(`Cannot read ${path} (--attach).`); }
      });
      const email = await call(cfg, "POST", "/emails", {
        headers: f["idempotency-key"] ? { "idempotency-key": f["idempotency-key"] } : undefined,
        body: {
          from: need(f.from, "--from"), to, cc: many(f.cc).length ? many(f.cc) : undefined, bcc: many(f.bcc).length ? many(f.bcc) : undefined,
          reply_to: many(f["reply-to"]).length ? many(f["reply-to"]) : undefined, subject: f.subject, html, text: text || undefined,
          template: f.template, variables: pairs(f.var, "var"), tags: pairs(f.tag, "tag"), scheduled_at: f.at, attachments: attachments.length ? attachments : undefined,
        },
      });
      return show(email, `${email.status === "scheduled" ? `Scheduled for ${when(email.scheduled_at)}` : "Sent"}: ${email.id}`);
    }

    case "emails": {
      if (sub === "get" || sub === "cancel") {
        const id = encodeURIComponent(need(rest[1], "the email id"));
        const e = sub === "get" ? await call(cfg, "GET", `/emails/${id}`) : await call(cfg, "POST", `/emails/${id}/cancel`);
        return show(e, `${fields([["Id", e.id], ["Status", e.status], ["From", e.from], ["To", e.to.join(", ")], ["Subject", e.subject], ["Created", when(e.created_at)], ["Scheduled", when(e.scheduled_at)], ["Tags", Object.entries(e.tags ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")]])}${e.events?.length ? `\n\n${table(e.events, [["event", (x) => x.type], ["at", (x) => when(x.at)], ["detail", (x) => (x.detail ? (typeof x.detail === "string" ? x.detail : JSON.stringify(x.detail)) : ""), 70]])}` : ""}`);
      }
      if (sub && sub !== "list") throw usage(`Unknown: emails ${sub}.`);
      const r = await call(cfg, "GET", "/emails", { query: { status: f.status, tag: f.tag?.[0], q: f.q, days: f.days, domain: f.domain, ...paging } });
      return show(r, table(r.data, [["id", (e) => e.id, 30], ["status", (e) => e.status], ["to", (e) => e.to.join(", "), 34], ["subject", (e) => e.subject, 44], ["created", (e) => when(e.created_at)]]) + footer(r));
    }

    case "contacts": {
      const one = (c) => fields([["Id", c.id], ["Email", c.email], ["Name", c.name], ["Company", c.company], ["Domain", c.domain], ["Subscribed", c.subscribed ? "yes" : `no (since ${when(c.unsubscribed_at)})`], ["Topics", c.topics.join(", ")], ["Properties", Object.entries(c.properties ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")], ["Created", when(c.created_at)], ["Last email", when(c.last_email_at)]]);
      if (sub === "add") {
        const r = await call(cfg, "POST", "/contacts", { body: { email: need(rest[1], "the email address"), name: f.name, company: f.company, domain: f.domain, topics: f.topic?.length ? many(f.topic) : undefined, properties: pairs(f.prop, "prop") } });
        return show(r, `${r.created ? "Added" : "Updated"}:\n${one(r.contact)}`);
      }
      if (sub === "get" || sub === "unsubscribe") {
        const id = encodeURIComponent(need(rest[1], "the contact id"));
        const c = sub === "get" ? await call(cfg, "GET", `/contacts/${id}`) : await call(cfg, "POST", `/contacts/${id}/unsubscribe`);
        return show(c, one(c));
      }
      if (sub === "rm") { await call(cfg, "DELETE", `/contacts/${encodeURIComponent(need(rest[1], "the contact id"))}`); return show({ deleted: true }, "Deleted."); }
      if (sub && sub !== "list") throw usage(`Unknown: contacts ${sub}.`);
      const r = await call(cfg, "GET", "/contacts", { query: { q: f.q, topic: f.topic?.[0], subscribed: f.subscribed ? "true" : f.unsubscribed ? "false" : undefined, domain: f.domain, ...paging } });
      return show(r, table(r.data, [["id", (c) => c.id, 30], ["email", (c) => c.email, 36], ["name", (c) => c.name, 24], ["subscribed", (c) => (c.subscribed ? "yes" : "no")], ["topics", (c) => c.topics.join(", "), 30]]) + footer(r));
    }

    case "sequences": {
      if (sub === "enroll" || sub === "stop") {
        const r = await call(cfg, "POST", `/sequences/${encodeURIComponent(need(rest[1], "the sequence id"))}/${sub}`, { body: who(need(rest[2], "an email address or contact id")) });
        return show(r, sub === "enroll" ? (r.enrolled ? `Enrolled ${r.contact_id}.` : "Already enrolled.") : r.stopped ? `Stopped for ${r.contact_id}.` : "Was not enrolled.");
      }
      if (sub && sub !== "list") throw usage(`Unknown: sequences ${sub}.`);
      const r = await call(cfg, "GET", "/sequences", { query: { domain: f.domain } });
      return show(r, table(r.data, [["id", (s) => s.id, 30], ["name", (s) => s.name, 34], ["status", (s) => s.status], ["steps", (s) => s.steps], ["active", (s) => s.active], ["completed", (s) => s.completed], ["replied", (s) => s.replied], ["domain", (s) => s.domain]]));
    }

    case "suppressions": {
      if (sub === "add") { const s = await call(cfg, "POST", "/suppressions", { body: { email: need(rest[1], "the email address"), note: f.note } }); return show(s, `Suppressed ${s.email}.`); }
      if (sub === "rm") { await call(cfg, "DELETE", `/suppressions/${encodeURIComponent(need(rest[1], "the email address"))}`); return show({ removed: true }, "Removed."); }
      if (sub && sub !== "list") throw usage(`Unknown: suppressions ${sub}.`);
      const r = await call(cfg, "GET", "/suppressions", { query: { q: f.q, reason: f.reason, ...paging } });
      return show(r, table(r.data, [["email", (s) => s.email, 40], ["reason", (s) => s.reason], ["detail", (s) => s.detail, 44], ["added", (s) => when(s.created_at)]]) + footer(r));
    }

    case "topics": {
      const r = await call(cfg, "GET", "/topics", { query: { domain: f.domain } });
      return show(r, table(r.data, [["name", (t) => t.name, 30], ["subscribers", (t) => t.subscribers], ["default", (t) => (t.default ? "yes" : "no")], ["domain", (t) => t.domain], ["description", (t) => t.description, 40]]));
    }

    case "templates": {
      if (sub === "get") {
        const t = await call(cfg, "GET", `/templates/${encodeURIComponent(need(rest[1], "the template id"))}`);
        return show(t, `${fields([["Id", t.id], ["Name", t.name], ["Subject", t.subject], ["Variables", t.variables.join(", ")], ["Domain", t.domain], ["Updated", when(t.updated_at)]])}\n\n${t.html || t.text}`);
      }
      if (sub === "push") {
        const html = f["html-file"] ? file(f["html-file"], "html-file") : f.html;
        const text = f["text-file"] ? file(f["text-file"], "text-file") : f.text;
        if (!html && !text) throw usage("Missing --html-file or --text-file.");
        const r = await call(cfg, "PUT", "/templates", { body: { name: need(rest[1], "the template name"), subject: need(f.subject, "--subject"), html, text, domain: f.domain } });
        return show(r, `${r.created ? "Created" : "Updated"} ${r.template.name} (${r.template.id})${r.template.variables.length ? `, variables: ${r.template.variables.join(", ")}` : ""}.`);
      }
      if (sub && sub !== "list") throw usage(`Unknown: templates ${sub}.`);
      const r = await call(cfg, "GET", "/templates", { query: { domain: f.domain } });
      return show(r, table(r.data, [["id", (t) => t.id, 30], ["name", (t) => t.name, 30], ["subject", (t) => t.subject, 40], ["variables", (t) => t.variables.join(", "), 30], ["domain", (t) => t.domain]]));
    }

    case "inboxes": {
      const r = await call(cfg, "GET", "/inboxes", { query: { domain: f.domain } });
      return show(r, table(r.data, [["address", (i) => i.address, 40], ["name", (i) => i.name, 24], ["unread", (i) => i.unread], ["id", (i) => i.id, 30]]));
    }

    case "threads": {
      const id = () => encodeURIComponent(need(rest[1], "the thread id"));
      const detail = (t) => `${fields([["Id", t.id], ["Subject", t.subject], ["With", t.with_name ? `${t.with_name} <${t.with}>` : t.with], ["Inbox", t.inbox], ["State", [t.unread ? "unread" : "read", t.archived && "archived", t.label].filter(Boolean).join(", ")]])}\n${t.messages.map((m) => `\n--- ${m.direction === "in" ? "from" : "to"} ${m.direction === "in" ? m.from : m.to} · ${when(m.at)}${m.delivery ? ` · ${m.delivery.status}` : ""}\n${m.text}${m.attachments.length ? `\n[${m.attachments.map((a) => a.filename).join(", ")}]` : ""}`).join("\n")}`;
      if (sub === "get") { const t = await call(cfg, "GET", `/threads/${id()}`); return show(t, detail(t)); }
      if (sub === "reply") {
        const text = f.text || (await stdin());
        if (!text) throw usage("Missing --text, or pipe the reply on stdin.");
        const t = await call(cfg, "POST", `/threads/${id()}/reply`, { body: { text, html: f.html } });
        return show(t, `Replied to ${t.with}.`);
      }
      const patch = { archive: { archived: true }, unarchive: { archived: false }, read: { unread: false }, unread: { unread: true } }[sub];
      if (patch) { const t = await call(cfg, "PATCH", `/threads/${id()}`, { body: patch }); return show(t, `${t.subject}: ${[t.unread ? "unread" : "read", t.archived && "archived"].filter(Boolean).join(", ")}.`); }
      if (sub && sub !== "list") throw usage(`Unknown: threads ${sub}.`);
      const r = await call(cfg, "GET", "/threads", { query: { unread: f.unread ? "true" : undefined, archived: f.archived ? "true" : undefined, inbox: f.inbox, q: f.q, domain: f.domain, limit: f.limit, offset: f.offset } });
      return show(r, table(r.data, [["id", (t) => t.id, 30], ["", (t) => (t.unread ? "●" : "")], ["with", (t) => t.with, 30], ["subject", (t) => t.subject, 40], ["updated", (t) => when(t.updated_at)]]) + (r.next_offset !== null ? `\nMore: --offset ${r.next_offset}` : ""));
    }

    case "domains": {
      const r = await call(cfg, "GET", "/domains");
      return show(r, table(r.data, [["name", (d) => d.name, 40], ["status", (d) => d.status], ["region", (d) => d.region], ["receiving", (d) => (d.receiving ? "yes" : "no")], ["alias of", (d) => d.alias_of]]));
    }

    case "webhooks": {
      if (sub === "add") {
        const events = many(f.event);
        if (!events.length) throw usage("Missing --event (for example --event email.delivered --event email.bounced).");
        const w = await call(cfg, "POST", "/webhooks", { body: { url: need(rest[1], "the endpoint URL"), events, description: f.description } });
        return show(w, `Created ${w.id}.\nSigning secret (shown only now): ${w.secret}`);
      }
      if (sub === "rm") { await call(cfg, "DELETE", `/webhooks/${encodeURIComponent(need(rest[1], "the webhook id"))}`); return show({ deleted: true }, "Deleted."); }
      if (sub && sub !== "list") throw usage(`Unknown: webhooks ${sub}.`);
      const r = await call(cfg, "GET", "/webhooks");
      return show(r, table(r.data, [["id", (w) => w.id, 30], ["url", (w) => w.url, 50], ["events", (w) => w.events.join(", "), 50], ["active", (w) => (w.active ? "yes" : "no")]]));
    }

    default:
      throw usage(`Unknown command: ${command}.`);
  }
}

run(process.argv.slice(2)).then(
  (out) => { if (out) console.log(out); },
  (err) => {
    console.error(`error: ${err instanceof Fail ? err.message : err?.stack ?? err}`);
    process.exitCode = err instanceof Fail ? err.exitCode : 1;
  },
);
