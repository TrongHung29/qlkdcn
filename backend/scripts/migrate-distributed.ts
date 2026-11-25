import fs from 'fs';
import path from 'path';
import { closeAllPools, query } from '../src/distributed/db';
import { SHARD_NAMES } from '../src/distributed/config';

async function main(): Promise<void> {
  const dir = path.join(__dirname, '..', 'src', 'distributed', 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const shard of SHARD_NAMES) {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await query(shard, sql);
      console.log(`[Migration] ✅ ${file} -> shard ${shard}`);
    }
  }
  await closeAllPools();
}

main().catch(async (error) => {
  console.error('[Migration] ❌', error);
  await closeAllPools();
  process.exit(1);
});
