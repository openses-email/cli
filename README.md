# openses-cli

The command line for [OpenSES](https://openses.email), the open-source email platform on your own Amazon SES. Send email, see what happened to it, manage contacts, sequences and suppressions, and answer the inbox from a terminal or a script.

No dependencies. Needs Node 20 or later.

## Install

```bash
npm install -g openses-cli
```

Or run it without installing: `npx openses-cli --help`.

## Sign in

Create an API key in the dashboard under **API & MCP**, then:

```bash
openses login
```

It asks for the key (and your API address when you self-host), checks it, and saves it in `~/.config/openses/config.json`, readable only by you. In scripts and CI, set `OPENSES_API_KEY` (and `OPENSES_API_URL` for a self-hosted API) instead.

```bash
openses whoami
```

## Send an email

```bash
openses send --from "Acme <billing@acme.com>" --to jane@example.com \
  --subject "Your invoice #1042" --html-file invoice.html --attach invoice.pdf
```

```bash
# A template with variables, scheduled, and safe to run twice
openses send --from hi@acme.com --to jane@example.com --template welcome \
  --var first_name=Jane --at 2027-01-05T09:00:00Z --idempotency-key welcome-jane

# The body from a pipe
uptime | openses send --from alerts@acme.com --to ops@acme.com --subject "Server status"
```

## See what happened

```bash
openses emails list --status bounced --days 7
openses emails get em_…          # the email with its delivery events
openses emails cancel em_…       # a scheduled one
```

## Everything else

```bash
openses contacts add jane@example.com --name Jane --topic "Product news" --prop plan=pro
openses contacts list --topic "Product news"
openses sequences enroll seq_… jane@example.com
openses suppressions add bounced@example.com --note "asked to be removed"
openses templates push welcome --subject "Welcome, {{first_name}}" --html-file welcome.html
openses threads list --unread
openses threads reply th_… --text "Thanks, we are on it."
openses webhooks add https://example.com/hooks/openses --event email.delivered --event email.bounced
openses domains
```

`openses --help` lists every command and option.

## Scripts

- `--json` prints the API's answer as JSON, for `jq` and friends.
- Exit code `0` is success, `1` an error from the API or the network, `2` a mistake in the command.
- Errors go to stderr as `error: <message> (<code>)`.

```bash
openses emails list --status bounced --json | jq -r '.data[].to[]'
```

## Where the key and the address come from

In this order: `--api-key` / `--api-url`, then `OPENSES_API_KEY` / `OPENSES_API_URL`, then the file `openses login` saved. Without an address the CLI talks to OpenSES Cloud.

## License

MIT
