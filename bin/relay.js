#!/usr/bin/env node

'use strict';

const [,, command, ...args] = process.argv;

const help = `
  relay <command>

  Commands:
    init              Analyze your Claude usage — prints cost report,
                      detects waste, saves profile, gives you a share code
    ask <RELAY-code>  Compare your spend with a friend's relay code

  Options:
    --help            Show this message
    --version         Show version

  Examples:
    npx relayai init
    relay init
    relay ask RELAY-686abc123def
`;

if (!command || command === '--help' || command === '-h') {
  console.log(help);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log(require('../package.json').version);
  process.exit(0);
}

if (command === 'init') {
  require('../lib/init')();
  return;
}

if (command === 'ask') {
  const code = args[0];
  if (!code) {
    console.error('\n  Usage: relay ask RELAY-<binId>\n');
    process.exit(1);
  }
  require('../lib/ask')(code);
  return;
}

console.error(`\n  Unknown command: ${command}\n  Run \`relay --help\` for usage.\n`);
process.exit(1);
