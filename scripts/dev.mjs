// Quaestor dev ランチャー (Windows 向け)
//
// - 起動前に DEV_PORTS を掃除して EADDRINUSE を防ぐ
// - be / fe をサブプロセスとして起動し、[be]/[fe] プレフィクス付きで出力
// - 親プロセス終了時に taskkill /F /T でプロセスツリーごと kill する

import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const DEV_PORTS = [17400, 5177];

// quaestor.config.json の web.allowedHosts を VITE_ALLOWED_HOSTS に注入。
// vite.config.ts での import.meta.url / process.cwd() の解決に依存しない確実な方法。
try {
  const cfgPath = resolve(ROOT, 'quaestor.config.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const hosts = cfg?.web?.allowedHosts;
    if (Array.isArray(hosts) && hosts.length > 0) {
      const existing = process.env.VITE_ALLOWED_HOSTS ?? '';
      const all = [...new Set([...existing.split(',').filter(Boolean), ...hosts])];
      process.env.VITE_ALLOWED_HOSTS = all.join(',');
      console.log(`[dev] VITE_ALLOWED_HOSTS=${process.env.VITE_ALLOWED_HOSTS}`);
    }
  }
} catch { /* 読み取り失敗は無視 */ }

// ── ポート掃除 ────────────────────────────────────────
function killPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
      const procId = line.trim().split(/\s+/).at(-1);
      if (!procId || !/^\d+$/.test(procId) || procId === '0') continue;
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', procId], { stdio: 'ignore' });
        console.log(`[dev] killed stale PID ${procId} on port ${port}`);
      } catch { /* already gone */ }
    }
  } catch { /* netstat unavailable */ }
}

console.log('[dev] cleaning up stale port bindings...');
for (const p of DEV_PORTS) killPort(p);

// ── 子プロセス起動 ────────────────────────────────────
const ANSI = { blue: '\x1b[34m', magenta: '\x1b[35m', reset: '\x1b[0m' };

function spawnPrefixed(label, color, cmd, args) {
  const pre = `${ANSI[color]}[${label}]${ANSI.reset} `;
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,          // Windows: cmd.exe でラップしないとシェルスクリプトが動かない
    windowsHide: true,
  });
  child.stdout.on('data', (d) => process.stdout.write(d.toString().replace(/^(?=.)/gm, pre)));
  child.stderr.on('data', (d) => process.stderr.write(d.toString().replace(/^(?=.)/gm, pre)));
  child.on('exit', (code, sig) => {
    console.log(`${pre}exited (code=${code ?? sig})`);
  });
  return child;
}

const be = spawnPrefixed('be', 'blue',    'npx', ['tsx', 'watch', 'src/server.ts']);
const fe = spawnPrefixed('fe', 'magenta', 'npm', ['--prefix', 'web', 'run', 'dev']);

// ── 終了ハンドラ ─────────────────────────────────────
function killAll(label) {
  console.log(`\n[dev] ${label} — killing process trees...`);
  for (const c of [be, fe]) {
    if (c.pid == null) continue;
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(c.pid)], { stdio: 'ignore' });
    } catch { /* already dead */ }
  }
}

// Windows では SIGINT が子に自動伝播しないので明示的に処理する
process.on('SIGINT',  () => { killAll('SIGINT');  process.exit(0); });
process.on('SIGTERM', () => { killAll('SIGTERM'); process.exit(0); });
process.on('exit',    ()  => killAll('exit'));
