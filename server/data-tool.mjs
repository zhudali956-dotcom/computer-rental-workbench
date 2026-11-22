import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openStore } from './store.mjs';
import { protectBackup,recoverBackup } from './backup.mjs';
import { checkRestored, feishuClient } from './feishu.mjs';
import { loadFeishuConfig } from './feishu-config.mjs';

const [action,source,target,mode]=process.argv.slice(2);
if (!source || !['backup','restore','verify-restore'].includes(action) || (action!=='verify-restore'&&!target)) throw new Error('用法：data-tool.mjs backup 数据库 备份文件 [--demo]，restore 备份文件 恢复数据库，或 verify-restore 恢复数据库');
const password=process.env.WORKBENCH_BACKUP_PASSWORD;
if (action==='verify-restore') {
  const { id,secret,base,table }=await loadFeishuConfig(process.env);
  if (![id,secret,base,table].every(Boolean)) throw new Error('请指定恢复库对应的飞书测试配置');
  await access(source);
  const store=openStore(source);
  try {
    if (!store.requiresRecovery()) throw new Error('该库没有待核验的恢复标记');
    store.bindFeishu({base,table});
    const remote=feishuClient({id,secret,base,table});
    await remote.checkFields();
    const {extra,different,missing}=await checkRestored(store,remote);
    console.log(`飞书对账：仅远端 ${extra}，记录不一致 ${different}，远端缺失 ${missing}。`);
    if (extra||different||missing) { process.exitCode=1; console.log('恢复库继续保持只读。请使用更新的快照或先核对修复差异。'); }
    else {store.clearRecovery();console.log('飞书对账一致，可切换正式服务。');}
  } finally { store.close(); }
} else if (action==='restore') {
  await recoverBackup(source,target,password);
  console.log('已恢复到新文件。正式库请在恢复检查模式核对。');
} else {
  await access(source);
  const store=openStore(source,{demo:mode==='--demo'});
  try { await protectBackup(store,target,password,dirname(resolve(source))); }
  finally {store.close();}
  console.log('已创建加密数据库快照。');
}
