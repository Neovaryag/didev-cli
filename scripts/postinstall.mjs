#!/usr/bin/env node
// Runs after `npm install -g didev`. Shows PATH setup instructions for Git Bash.
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Skip for local (non-global) installs
if (!process.env.npm_config_global) process.exit(0);

let prefix = '';
try {
  prefix = execSync('npm config get prefix', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {
  process.exit(0);
}

// Convert Windows path (C:\...) to Git Bash path (/c/...)
function toBashPath(winPath) {
  const match = winPath.match(/^([A-Za-z]):[\\\/](.*)/);
  if (match) {
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, '/');
    return `/${drive}/${rest}`;
  }
  return winPath.replace(/\\/g, '/');
}

const bashPrefix = toBashPath(prefix);
const exportLine = `export PATH="${bashPrefix}:$PATH"`;
const bashrc = join(homedir(), '.bashrc');

let alreadyConfigured = false;
if (existsSync(bashrc)) {
  const content = readFileSync(bashrc, 'utf-8');
  alreadyConfigured = content.includes(bashPrefix) || content.includes('didev PATH');
}

console.log('\n✅ didev installed globally!');

if (!alreadyConfigured) {
  console.log('\n⚠️  To use didev in Git Bash, add npm global bin to your PATH.');
  console.log('\n   Run these commands in Git Bash:');
  console.log(`\n   echo '# didev PATH' >> ~/.bashrc`);
  console.log(`   echo '${exportLine}' >> ~/.bashrc`);
  console.log(`   source ~/.bashrc`);
  console.log('\n   Or run the helper script:');
  console.log('   bash scripts/setup-path.sh');
} else {
  console.log('✅ PATH is already configured.');
  console.log('   Run: source ~/.bashrc (if in a new terminal)');
}

console.log('\n   Then verify: didev --version\n');
