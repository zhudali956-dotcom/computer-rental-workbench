import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const magic=Buffer.from('RENTAL01');
function derive(passphrase,salt) {
  if (typeof passphrase!=='string' || passphrase.length<16) throw new Error('备份口令至少需要 16 个字符');
  return scryptSync(passphrase,salt,32);
}

export async function protectBackup(store, target, passphrase, scratch=dirname(resolve(target))) {
  const salt=randomBytes(16), iv=randomBytes(12), key=derive(passphrase,salt);
  const dir=await mkdtemp(join(scratch,'workbench-snapshot-'));
  const file=join(dir,'snapshot.sqlite');
  try {
    await store.backup(file);
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(magic);
    const ciphertext=Buffer.concat([cipher.update(await readFile(file)),cipher.final()]);
    await writeFile(target,Buffer.concat([magic,salt,iv,cipher.getAuthTag(),ciphertext]),{flag:'wx',mode:0o600});
  } finally {
    key.fill(0);
    await rm(file,{force:true});
    await rmdir(dir);
  }
}

export async function recoverBackup(source,target,passphrase) {
  const buffer=await readFile(source);
  if (buffer.length<52 || !buffer.subarray(0,8).equals(magic)) throw new Error('备份文件格式无效');
  const key=derive(passphrase,buffer.subarray(8,24));
  try {
    const decipher=createDecipheriv('aes-256-gcm',key,buffer.subarray(24,36));
    decipher.setAAD(magic);
    decipher.setAuthTag(buffer.subarray(36,52));
    const data=Buffer.concat([decipher.update(buffer.subarray(52)),decipher.final()]);
    await writeFile(target,data,{flag:'wx',mode:0o600});
    const db=new DatabaseSync(target);
    try {
      db.exec('DELETE FROM sessions');
      if (db.prepare("SELECT value FROM settings WHERE key='mode'").get()?.value==='production') {
        db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('restore_pending','1');
      }
    } finally { db.close(); }
  } finally { key.fill(0); }
}
