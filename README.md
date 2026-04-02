# relayai

See your Claude Code spend, detect waste patterns, and compare with friends.

```
npx relayai init
```

---

## What it does

### `relay init`

Reads your local Claude Code session logs, calculates your spend for the last 30 days, and detects three waste patterns:

| Pattern | What it means |
|---|---|
| No prompt caching | Your input tokens are re-sent in full every turn instead of being cached across turns |
| Opus on short tasks | You're using Claude Opus for tasks that produced fewer than 500 output tokens — Sonnet costs 5× less |
| Context bloat | Sessions with over 50k input tokens that lasted fewer than 10 turns — large context loaded and then abandoned |

After the report, it asks two questions and saves a profile to `~/.relay/profile.json`. It also uploads the profile to JSONBin and gives you a **relay code** you can share with a friend.

### `relay ask RELAY-<code>`

Takes a friend's relay code, fetches their profile, and compares it with yours:

- Their handle, tools, spend, and use case
- Dollar difference between your spend and theirs
- Waste patterns you have that they don't (and vice versa)
- One actionable line: what to look at first

---

## What it reads

Only `~/.claude/projects/**/*.jsonl` — the local session logs written by Claude Code. These contain token usage metadata and model names per turn.

## What it calculates

Estimated cost based on Anthropic's public pricing:

| Model | Input | Output | Cache read |
|---|---|---|---|
| Sonnet | $3/M | $15/M | $0.30/M |
| Opus | $15/M | $75/M | $0.30/M |
| Haiku | $0.80/M | $4/M | $0.08/M |

## What it never touches

- Your prompt content or conversation text
- Your code or files
- Your Anthropic API keys or credentials
- Anything outside `~/.claude/projects/`

The only data that leaves your machine is the profile you explicitly choose to share: your username handle, tool list, use case, spend total, and waste pattern flags.

---

## Requirements

- Node.js 18+
- A free [JSONBin](https://jsonbin.io) account — on first run, you'll be prompted to paste your Master Key. It's saved to `~/.relay/config.json` and never asked for again. To reset it, delete that file.

## Install

```bash
npm install -g relayai
relay init
```

Or run without installing:

```bash
npx relayai init
```

## Commands

```
relay init              Run the cost + waste report
relay ask RELAY-<code>  Compare spend with a friend
relay --version
relay --help
```

## Profile format

Saved to `~/.relay/profile.json` after `relay init`:

```json
{
  "handle": "yourname",
  "updated": "2026-03-30",
  "spend_30d": 371.74,
  "tools": ["claude-code", "cursor"],
  "use_case": "building product",
  "waste_patterns": {
    "no_caching": false,
    "model_mismatch": false,
    "context_bloat": false
  },
  "savings_available": 0
}
```

---

MIT License
