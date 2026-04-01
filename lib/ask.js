'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const https    = require('https');
const readline = require('readline');

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';
const RED = '\x1b[31m', YELLOW = '\x1b[33m', GREEN = '\x1b[32m';
const CYAN = '\x1b[36m', WHITE = '\x1b[97m';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function getApiKey() {
  const configPath = path.join(os.homedir(), '.relay', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg.jsonbinApiKey) return cfg.jsonbinApiKey;
  } catch { /* not saved yet */ }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log();
  console.log(`  ${B}A JSONBin API key is required to fetch profiles.${R}`);
  console.log(`  ${D}Get a free key at https://jsonbin.io → sign up → "API Keys".${R}`);
  console.log();
  const key = (await ask(rl, `  Paste your JSONBin Master Key: `)).trim();
  rl.close();

  const relayDir = path.join(os.homedir(), '.relay');
  fs.mkdirSync(relayDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ jsonbinApiKey: key }, null, 2));
  console.log(`  ${GREEN}Key saved to ~/.relay/config.json${R}`);
  console.log();

  return key;
}

function fetchBin(binId, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.jsonbin.io',
      path:     `/v3/b/${binId}/latest`,
      method:   'GET',
      headers:  { 'X-Master-Key': apiKey },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).record); }
        catch { reject(new Error('Could not parse JSONBin response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = async function ask(code) {
  const binId  = code.replace(/^RELAY-/i, '').trim();
  const apiKey = await getApiKey();

  // Load local profile
  const localPath = path.join(os.homedir(), '.relay', 'profile.json');
  let local = null;
  if (fs.existsSync(localPath)) {
    try { local = JSON.parse(fs.readFileSync(localPath, 'utf8')); }
    catch { /* ignore */ }
  }

  // Fetch friend's profile
  let friend;
  try {
    friend = await fetchBin(binId, apiKey);
  } catch (err) {
    console.error(`\n  Could not fetch profile: ${err.message}\n`);
    process.exit(1);
  }

  console.log();
  console.log(`${B}${WHITE}╔════════════════════════════════════════════════════╗${R}`);
  console.log(`${B}${WHITE}║         RelayAI — Friend Comparison                ║${R}`);
  console.log(`${B}${WHITE}╚════════════════════════════════════════════════════╝${R}`);
  console.log();

  // ── Friend summary ──────────────────────────────────────────────────────────

  console.log(`  ${B}@${friend.handle}${R}  ${D}(updated ${friend.updated})${R}`);
  console.log(`  Tools:    ${friend.tools?.join(', ') || 'unknown'}`);
  console.log(`  Use case: ${friend.use_case || 'unknown'}`);
  console.log(`  Spend:    ${B}${CYAN}$${friend.spend_30d?.toFixed(2)}${R}  ${D}/ last 30 days${R}`);
  console.log();

  if (!local) {
    console.log(`  ${D}Run \`relay init\` first to compare your own spend.${R}`);
    console.log();
    return;
  }

  // ── Spend delta ─────────────────────────────────────────────────────────────

  const diff    = local.spend_30d - friend.spend_30d;
  const absDiff = Math.abs(diff).toFixed(2);
  const you     = `$${local.spend_30d.toFixed(2)}`;
  const them    = `$${friend.spend_30d.toFixed(2)}`;

  if (Math.abs(diff) < 0.50) {
    console.log(`  ${D}Spend:${R} You (${you}) and @${friend.handle} (${them}) are about even.`);
  } else if (diff > 0) {
    console.log(`  ${D}Spend:${R} You're spending ${RED}$${absDiff} more${R} than @${friend.handle}  (${you} vs ${them})`);
  } else {
    console.log(`  ${D}Spend:${R} You're spending ${GREEN}$${absDiff} less${R} than @${friend.handle}  (${you} vs ${them})`);
  }
  console.log();

  // ── Waste pattern diff ──────────────────────────────────────────────────────

  const patterns = [
    { key: 'no_caching',     label: 'No prompt caching',  tip: 'Cache system prompts — biggest quick win'       },
    { key: 'model_mismatch', label: 'Opus on short tasks', tip: 'Route simple tasks to Sonnet to cut model cost' },
    { key: 'context_bloat',  label: 'Context bloat',       tip: 'Use subagents or trim context before long runs' },
  ];

  const onlyYou  = patterns.filter(p =>  local.waste_patterns?.[p.key] && !friend.waste_patterns?.[p.key]);
  const onlyThem = patterns.filter(p => !local.waste_patterns?.[p.key] &&  friend.waste_patterns?.[p.key]);
  const both     = patterns.filter(p =>  local.waste_patterns?.[p.key] &&  friend.waste_patterns?.[p.key]);

  if (onlyYou.length > 0) {
    console.log(`  ${YELLOW}Waste patterns you have that @${friend.handle} doesn't:${R}`);
    for (const p of onlyYou) console.log(`    • ${p.label}`);
    console.log();
  }

  if (onlyThem.length > 0) {
    console.log(`  ${D}Waste patterns @${friend.handle} has that you don't:${R}`);
    for (const p of onlyThem) console.log(`    • ${p.label}`);
    console.log();
  }

  if (both.length > 0) {
    console.log(`  ${D}You both have:${R} ${both.map(p => p.label).join(', ')}`);
    console.log();
  }

  // ── Single actionable line ──────────────────────────────────────────────────

  const topPattern = onlyYou[0] || both[0] || null;
  console.log(`  ${D}────────────────────────────────────────────────────${R}`);
  console.log();
  if (topPattern) {
    console.log(`  ${B}Look at first:${R} ${topPattern.tip}`);
  } else if (local.savings_available > 0) {
    console.log(`  ${B}Look at first:${R} You have $${local.savings_available.toFixed(2)} in recoverable waste — run \`relay init\` for the breakdown`);
  } else {
    console.log(`  ${B}${GREEN}You're running clean — no major waste patterns detected.${R}`);
  }

  console.log();
};
