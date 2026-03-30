'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const https    = require('https');
const readline = require('readline');

// ─── Config ───────────────────────────────────────────────────────────────────

const RATES = {
  sonnet: { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75  },
  opus:   { input: 15.00, output: 75.00, cacheRead: 0.30, cacheWrite: 18.75 },
  haiku:  { input: 0.80,  output: 4.00,  cacheRead: 0.08, cacheWrite: 1.00  },
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const JSONBIN_KEY    = '$2a$10$DRWI6fRIMkaWvh5nPSodzuajOQO5CZzRtztnAvzpl7ug.7w6NP2mC';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRates(model = '') {
  const m = model.toLowerCase();
  if (m.includes('opus'))  return { tier: 'opus',   ...RATES.opus   };
  if (m.includes('haiku')) return { tier: 'haiku',  ...RATES.haiku  };
  return                          { tier: 'sonnet', ...RATES.sonnet };
}

function calcCost(usage, model) {
  const r = getRates(model);
  const M = 1_000_000;
  return (
    ((usage.input_tokens                || 0) * r.input      / M) +
    ((usage.output_tokens               || 0) * r.output     / M) +
    ((usage.cache_read_input_tokens     || 0) * r.cacheRead  / M) +
    ((usage.cache_creation_input_tokens || 0) * r.cacheWrite / M)
  );
}

function findJsonlFiles(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory())               findJsonlFiles(full, results);
    else if (e.name.endsWith('.jsonl')) results.push(full);
  }
  return results;
}

function parseTimestamp(record) {
  if (record.timestamp)           return new Date(record.timestamp);
  if (record.message?.created_at) return new Date(record.message.created_at * 1000);
  if (record.created_at)          return new Date(record.created_at * 1000);
  return null;
}

function postToJsonbin(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req  = https.request({
      hostname: 'api.jsonbin.io',
      path:     '/v3/b',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'X-Master-Key':   JSONBIN_KEY,
        'X-Bin-Name':     'relay-profile',
        'X-Bin-Private':  'false',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Bad JSON from JSONBin')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';
const RED = '\x1b[31m', YELLOW = '\x1b[33m', GREEN = '\x1b[32m';
const CYAN = '\x1b[36m', WHITE = '\x1b[97m';
const $f  = (n) => `$${n.toFixed(2)}`;

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = function init() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(projectsDir)) {
    console.error('\n  No Claude projects directory found at ' + projectsDir);
    console.error('  Make sure Claude Code has been run at least once.\n');
    process.exit(1);
  }

  // ── Analysis ────────────────────────────────────────────────────────────────

  const files    = findJsonlFiles(projectsDir);
  const cutoff   = Date.now() - THIRTY_DAYS_MS;
  const sessions = {};
  const fileStats = {};
  let totalCost = 0, totalRecords = 0;
  let wasteNoCaching = 0, wasteOpusShort = 0, wasteContextBloat = 0;

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { continue; }

    const lines = raw.split('\n').filter(Boolean);
    fileStats[file] = { totalCacheRead: 0, records: [] };

    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); }
      catch { continue; }

      const usage = record.message?.usage;
      if (!usage) continue;
      if (record.message?.role !== 'assistant' && record.type !== 'assistant') continue;

      const ts = parseTimestamp(record);
      if (!ts || ts.getTime() < cutoff) continue;

      totalRecords++;

      const model   = record.message?.model || record.model || '';
      const cost    = calcCost(usage, model);
      const inputTk = usage.input_tokens || 0;
      const outTk   = usage.output_tokens || 0;
      const cacheRd = usage.cache_read_input_tokens || 0;

      const sessionId = record.parentUuid || file;
      if (!sessions[sessionId]) sessions[sessionId] = { turns: 0, maxInput: 0, cost: 0 };
      sessions[sessionId].turns++;
      sessions[sessionId].maxInput = Math.max(sessions[sessionId].maxInput, inputTk);
      sessions[sessionId].cost += cost;

      totalCost += cost;
      fileStats[file].totalCacheRead += cacheRd;
      fileStats[file].records.push({ cost, sessionId, inputTk, outTk, model, usage });

      if (getRates(model).tier === 'opus' && outTk < 500) {
        wasteOpusShort += cost - calcCost(usage, 'claude-sonnet');
      }
    }
  }

  for (const stat of Object.values(fileStats)) {
    if (stat.totalCacheRead === 0 && stat.records.length > 1) {
      for (const rec of stat.records) {
        const r = getRates(rec.model);
        const inputCost = (rec.usage.input_tokens || 0) * r.input / 1_000_000;
        wasteNoCaching += inputCost * 0.80 * (1 - r.cacheRead / r.input);
      }
    }
  }

  for (const s of Object.values(sessions)) {
    if (s.maxInput > 50_000 && s.turns < 10) {
      wasteContextBloat += s.cost * 0.40;
    }
  }

  const totalWaste = wasteNoCaching + wasteOpusShort + wasteContextBloat;

  // ── Report ──────────────────────────────────────────────────────────────────

  const bar = (value, maxWidth = 30) => {
    const filled = Math.round((value / (totalWaste || 1)) * maxWidth);
    return `${'█'.repeat(filled)}${'░'.repeat(maxWidth - filled)}`;
  };

  console.log();
  console.log(`${B}${WHITE}╔════════════════════════════════════════════════════╗${R}`);
  console.log(`${B}${WHITE}║         RelayAI — Claude Usage Report              ║${R}`);
  console.log(`${B}${WHITE}╚════════════════════════════════════════════════════╝${R}`);
  console.log();
  console.log(`  ${D}Period:${R}   Last 30 days`);
  console.log(`  ${D}Records:${R}  ${totalRecords.toLocaleString()} assistant turns across ${files.length} session files`);
  console.log();
  console.log(`${B}  Total spend this month${R}`);
  console.log(`  ${B}${CYAN}${$f(totalCost)}${R}  ${D}estimated (pre-tax)${R}`);
  console.log();

  if (totalWaste > 0) {
    const wastePct = ((totalWaste / totalCost) * 100).toFixed(0);
    console.log(`${B}  Avoidable waste${R}`);
    console.log(`  ${B}${RED}${$f(totalWaste)}${R}  ${D}(~${wastePct}% of spend)${R}`);
    console.log();
    console.log(`  ${D}────────────────────────────────────────────────────${R}`);
    console.log();

    const buckets = [
      { icon: '⚡', label: 'No prompt caching',  detail: 'Input tokens re-sent every turn instead of cached', fix: 'Cache system prompts & shared context',          amount: wasteNoCaching    },
      { icon: '🔬', label: 'Opus on short tasks', detail: 'Opus used for tasks with <500 output tokens',       fix: 'Route short tasks to Sonnet instead',            amount: wasteOpusShort    },
      { icon: '📦', label: 'Context bloat',        detail: '>50k input tokens in sessions under 10 turns',     fix: 'Trim context or use subagents for focused tasks', amount: wasteContextBloat },
    ].sort((a, b) => b.amount - a.amount);

    for (const b of buckets) {
      const pct = ((b.amount / totalWaste) * 100).toFixed(0);
      console.log(`  ${b.icon}  ${B}${b.label}${R}`);
      console.log(`     ${D}${b.detail}${R}`);
      console.log(`     ${bar(b.amount)} ${YELLOW}${$f(b.amount)}${R}  ${D}(${pct}% of waste)${R}`);
      console.log(`     ${GREEN}Fix:${R} ${b.fix}`);
      console.log();
    }
  } else {
    console.log(`  ${GREEN}${B}No significant waste patterns detected.${R}`);
    console.log();
  }

  console.log(`  ${D}────────────────────────────────────────────────────${R}`);
  console.log();
  console.log(`  ${B}Know someone burning through Claude credits?${R}`);
  console.log(`  ${CYAN}Share RelayAI and save them from being Jake. →${R} relayai.app`);
  console.log();

  // ── Profile prompt ──────────────────────────────────────────────────────────

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  (async () => {
    const toolsRaw  = await ask(rl, `  ${B}What tools are you currently using?${R}\n  ${D}(e.g. claude-code, cursor, copilot, chatgpt, other)${R}\n\n  > `);
    console.log();
    const useCase   = await ask(rl, `  ${B}What's your main use case?${R}\n  ${D}(building product / exploring / automating / research)${R}\n\n  > `);
    rl.close();
    console.log();

    const tools  = toolsRaw.trim().split(/[,\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
    const handle = os.userInfo().username.split('.')[0].toLowerCase();

    const profile = {
      handle,
      updated:           new Date().toISOString().slice(0, 10),
      spend_30d:         parseFloat(totalCost.toFixed(4)),
      tools,
      use_case:          useCase.trim().toLowerCase(),
      waste_patterns: {
        no_caching:     wasteNoCaching    > 0,
        model_mismatch: wasteOpusShort    > 0,
        context_bloat:  wasteContextBloat > 0,
      },
      savings_available: parseFloat(totalWaste.toFixed(4)),
    };

    // Save locally
    const profileDir = path.join(os.homedir(), '.relay');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify(profile, null, 2));

    // Upload to JSONBin
    try {
      const result = await postToJsonbin(profile);
      const binId  = result.metadata?.id;

      if (binId) {
        fs.writeFileSync(path.join(profileDir, 'bin_id'), binId);
        console.log(`  ${GREEN}Saved to ~/.relay/profile.json${R}`);
        console.log();
        console.log(`  ${B}${WHITE}your relay code: RELAY-${binId}${R}`);
        console.log();
        console.log(`  Send this to a friend and tell them to run:`);
        console.log(`  ${CYAN}relay ask RELAY-${binId}${R}`);
      } else {
        console.log(`  ${GREEN}Saved to ~/.relay/profile.json${R}`);
        console.log(`  ${YELLOW}Upload succeeded but no bin ID returned.${R}`);
      }
    } catch (err) {
      console.log(`  ${GREEN}Saved locally to ~/.relay/profile.json${R}`);
      console.log(`  ${YELLOW}Upload failed: ${err.message}${R}`);
    }

    console.log();
  })();
};
