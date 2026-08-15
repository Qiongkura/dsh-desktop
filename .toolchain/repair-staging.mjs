// Repair a pnpm-deployed runtime closure by iteratively booting `dsh web` and
// copying whatever workspace packages the deploy dropped (pnpm deploy misses
// transitive workspace deps in this repo layout).
// Usage: node repair-staging.mjs <stagingDir> <sourceRepoRoot> [port]
// Exits 0 when the staged runtime boots and serves HTTP.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const [stage, sourceRoot, portArg] = process.argv.slice(2)
const port = Number(portArg || 3099)
if (!stage || !sourceRoot) {
  console.error('usage: node repair-staging.mjs <stagingDir> <sourceRepoRoot> [port]')
  process.exit(2)
}

// name -> directory containing package.json with that name
function buildIndex(baseDirs) {
  const index = new Map()
  const visit = (pkgDir) => {
    const manifestPath = join(pkgDir, 'package.json')
    if (!existsSync(manifestPath)) return
    try {
      const name = JSON.parse(readFileSync(manifestPath, 'utf8')).name
      if (name) index.set(name, pkgDir)
    } catch { /* ignore */ }
  }
  for (const base of baseDirs) {
    if (!existsSync(base)) continue
    for (const level1 of readdirSync(base, { withFileTypes: true })) {
      if (!level1.isDirectory()) continue
      const p1 = join(base, level1.name)
      visit(p1) // vendor/<name> or packages/<group>
      for (const level2 of readdirSync(p1, { withFileTypes: true })) {
        if (!level2.isDirectory()) continue
        visit(join(p1, level2.name)) // packages/<group>/<name>
      }
    }
  }
  return index
}

const workspaceIndex = buildIndex([
  join(sourceRoot, 'packages'),
  join(sourceRoot, 'vendor'),
])

function copyPackage(name, fromDir) {
  const dest = join(stage, 'node_modules', name)
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    if (entry.name === 'tests' || entry.name === 'test') continue
    if (entry.name.endsWith('.tsbuildinfo')) continue
    cpSync(join(fromDir, entry.name), join(dest, entry.name), { recursive: true, force: true })
  }
  console.log(`[repair] copied ${name}`)
}

function parseMissing(output) {
  const names = new Set()
  const re = /Cannot find package '([^']+)' imported from/g
  let m
  while ((m = re.exec(output)) !== null) names.add(m[1])
  return [...names]
}

function bootOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['lib/bin.js', 'web', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: stage,
      env: { ...process.env, DSH_HOME: join(stage, '..', 'test-home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    const timer = setTimeout(async () => {
      // still alive: check the port
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        if (res.ok) {
          child.kill()
          resolve({ ok: true, out })
          return
        }
      } catch { /* not up yet */ }
      setTimeout(() => { child.kill(); resolve({ ok: false, out }) }, 30_000)
    }, 15_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve({ ok: false, out })
    })
  })
}

for (let round = 1; round <= 40; round++) {
  console.log(`[repair] round ${round}: booting staged runtime ...`)
  const { ok, out } = await bootOnce()
  if (ok) {
    console.log('[repair] SUCCESS: staged runtime boots and serves HTTP')
    process.exit(0)
  }
  const missing = parseMissing(out)
  if (missing.length === 0) {
    console.error('[repair] boot failed but no missing packages found; last output:\n' + out.slice(-2000))
    process.exit(1)
  }
  console.log(`[repair] missing ${missing.length}: ${missing.join(', ')}`)
  let copiedAny = false
  for (const name of missing) {
    const fromDir = workspaceIndex.get(name)
    if (fromDir) {
      copyPackage(name, fromDir)
      copiedAny = true
    } else {
      console.error(`[repair] ${name} is not a workspace package; cannot auto-repair`)
    }
  }
  if (!copiedAny) {
    console.error('[repair] nothing to copy; giving up')
    process.exit(1)
  }
}
console.error('[repair] too many rounds; giving up')
process.exit(1)
