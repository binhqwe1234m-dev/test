#!/usr/bin/env node
/**
 * postinstall cleanup — strips unused data from node_modules
 * Saves ~325 MB while keeping ALL Java (pc) version support.
 *
 * What gets removed:
 *   - minecraft-data: Bedrock version folders (keep common/ for require-time refs)
 *   - three.js: examples/ and src/ (already bundled in prismarine-viewer)
 *   - prismarine-viewer: examples/, test/
 *   - Everywhere: test/, tests/, docs/, .github/ folders
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nm = path.join(__dirname, '..', 'node_modules');

let totalFreed = 0;

function dirSize(p) {
  if (!fs.existsSync(p)) return 0;
  let size = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    if (entry.isDirectory()) size += dirSize(full);
    else size += fs.statSync(full).size;
  }
  return size;
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const bytes = dirSize(p);
  fs.rmSync(p, { recursive: true, force: true });
  totalFreed += bytes;
}

function fmt(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

console.log('\n🧹 postinstall: cleaning up unused data...\n');

// ── 1. minecraft-data: remove Bedrock version dirs (keep common/) ──
const bedrockDir = path.join(nm, 'minecraft-data', 'minecraft-data', 'data', 'bedrock');
if (fs.existsSync(bedrockDir)) {
  let count = 0;
  for (const entry of fs.readdirSync(bedrockDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'common') {
      rmrf(path.join(bedrockDir, entry.name));
      count++;
    }
  }
  console.log(`  ✓ minecraft-data: removed ${count} Bedrock version dirs`);
}

// ── 2. three.js: remove examples/ and src/ (bundled already) ──
const threePkg = path.join(nm, 'three');
if (fs.existsSync(threePkg)) {
  rmrf(path.join(threePkg, 'examples'));
  rmrf(path.join(threePkg, 'src'));
  console.log('  ✓ three: removed examples/ and src/');
}

// ── 3. prismarine-viewer: remove examples/ and test/ ──
const pvPkg = path.join(nm, 'prismarine-viewer');
if (fs.existsSync(pvPkg)) {
  rmrf(path.join(pvPkg, 'examples'));
  rmrf(path.join(pvPkg, 'test'));
  console.log('  ✓ prismarine-viewer: removed examples/ and test/');
}

// ── 4. Global: remove test/tests/docs/.github from all packages ──
const junkDirs = ['test', 'tests', 'docs', '.github'];
let junkCount = 0;
for (const pkg of fs.readdirSync(nm)) {
  const pkgPath = path.join(nm, pkg);
  if (!fs.statSync(pkgPath).isDirectory()) continue;
  // Handle scoped packages (@scope/pkg)
  if (pkg.startsWith('@')) {
    for (const sub of fs.readdirSync(pkgPath)) {
      const subPath = path.join(pkgPath, sub);
      if (!fs.statSync(subPath).isDirectory()) continue;
      for (const junk of junkDirs) {
        const jp = path.join(subPath, junk);
        if (fs.existsSync(jp) && fs.statSync(jp).isDirectory()) {
          rmrf(jp); junkCount++;
        }
      }
    }
  } else {
    for (const junk of junkDirs) {
      const jp = path.join(pkgPath, junk);
      if (fs.existsSync(jp) && fs.statSync(jp).isDirectory()) {
        rmrf(jp); junkCount++;
      }
    }
  }
}
console.log(`  ✓ Removed ${junkCount} test/docs/.github folders across packages`);

console.log(`\n✅ Freed ${fmt(totalFreed)} total.\n`);
