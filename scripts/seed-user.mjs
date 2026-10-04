// Creates or resets a panel account. The password never touches the repo:
//   node scripts/seed-user.mjs <username> "<Görünen Ad>" <admin|staff> <password> [--remote]
// Without --remote it writes to the local wrangler D1 (for `npm run dev`).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hashPassword, validatePassword } from '../worker/src/lib.mjs';

const [username, displayName, role, password, flag] = process.argv.slice(2);
if (!username || !displayName || !['admin', 'staff'].includes(role) || !password) {
  console.error('Kullanım: node scripts/seed-user.mjs <kullanıcı> "<Görünen Ad>" <admin|staff> <şifre> [--remote]');
  process.exit(1);
}
const err = validatePassword(password);
if (err) { console.error(err); process.exit(1); }

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const hash = await hashPassword(password);
const sql = `INSERT INTO users (username, display_name, role, pass_hash, created_at)
VALUES (${q(username)}, ${q(displayName)}, ${q(role)}, ${q(hash)}, ${q(new Date().toISOString())})
ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, role = excluded.role,
  pass_hash = excluded.pass_hash, failed = 0, locked_until = NULL;`;

const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker');
// Pass the SQL as a file: quoting it through cmd.exe is fragile.
const file = join(tmpdir(), `itumtal-seed-${process.pid}.sql`);
writeFileSync(file, sql);
try {
  const args = ['wrangler', 'd1', 'execute', 'itumtal-ziyaret', flag === '--remote' ? '--remote' : '--local', '--yes', '--file', file];
  execFileSync('npx', args, { cwd: workerDir, stdio: 'inherit', shell: process.platform === 'win32' });
} finally {
  unlinkSync(file);
}
console.log(`${username} hazır (${flag === '--remote' ? 'canlı' : 'yerel'} veritabanı).`);
