import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { previewImport } from '../server/import.mjs';
import { auditRemote, checkRestored, feishuClient, fieldNames, syncOne, verifyConflict } from '../server/feishu.mjs';
import { protectBackup, recoverBackup } from '../server/backup.mjs';

const sample = Buffer.from('企业名称,联系电话,来源\n甲公司,010-55550123,脱敏样例\n甲公司,01055550123,脱敏样例\n乙公司,01055550123,脱敏样例\n丙公司,123,脱敏样例\n');

test('Excel 样表解析首个工作表并保留六行分类', async (t) => {
  const store = openStore(':memory:', { demo:true });
  t.after(()=>store.close());
  const buffer = await readFile(new URL('../examples/sample.xlsx',import.meta.url));
  const preview = await previewImport(store,buffer,'sample.xlsx');
  assert.equal(preview.ready,true);
  assert.deepEqual(preview.rows.map(row=>row.status),['new','duplicate','new','new','review','review']);
});

test('导入预览保留行号并区分重复、冲突与无效号码', async (t) => {
  const store = openStore(':memory:', { demo: true });
  t.after(() => store.close());
  const preview = await previewImport(store, sample, '示例.csv');
  assert.deepEqual(preview.rows.map(({ line, status }) => [line, status]), [[2,'new'],[3,'duplicate'],[4,'review'],[5,'review']]);
  const batch = store.commitImport(store.users()[0], preview);
  assert.equal(store.commitImport(store.users()[0], preview).id, batch.id);
  assert.equal(store.dashboard(store.users()[0]).pool, 1);
});

test('领取有唯一归属，重试不重复，拒绝联系阻止继续营销', async (t) => {
  const store = openStore(':memory:', { demo: true });
  t.after(() => store.close());
  const [admin, alice, bob] = store.users();
  store.commitImport(admin, await previewImport(store, sample, '示例.csv', { basis:'脱敏测试' }));
  const [lead] = store.claim(alice, 1, 'claim-001');
  assert.equal(store.claim(alice, 1, 'claim-001')[0].id, lead.id);
  assert.deepEqual(store.claim(bob, 1, 'claim-002'), []);
  assert.throws(() => store.detail(bob, lead.id), { status: 404 });
  const followup = new Date(Date.now() + 86400000).toISOString();
  assert.throws(()=>store.contact(alice,lead.id,{result:'missed'},'missing-next'),{status:400});
  store.contact(alice, lead.id, { result:'missed', next:followup }, 'contact-001');
  store.contact(alice, lead.id, { result:'refused' }, 'contact-002');
  store.contact(alice, lead.id, { result:'refused' }, 'contact-002');
  const detail = store.detail(alice, lead.id);
  assert.equal(detail.logs.length, 2);
  assert.equal(detail.lead.dnc, 1);
  assert.equal(detail.lead.next, null);
  assert.throws(() => store.contact(alice, lead.id, { result:'missed' }, 'contact-003'), { status: 409 });
});

test('飞书写入成功后回执丢失，查证后确认同一条记录', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const admin = store.createUser({ name:'管理员', username:'owner', password:'test-secret-123', role:'admin' });
  store.commitImport(admin, await previewImport(store, sample, '示例.csv', { basis:'脱敏测试' }));
  const records = [];
  const remote = {
    find: async () => records,
    create: async (item, fields) => { records.push({ record_id:'rec-1', fields }); throw new Error('测试丢失回执'); }
  };
  await syncOne(store, remote);
  assert.equal(store.dashboard(admin).pool, 0);
  store.retry(admin, store.outbox()[0].id);
  await syncOne(store, remote);
  assert.equal(records.length, 1);
  assert.equal(store.dashboard(admin).pool, 1);
});

test('飞书未确认的新线索不会开放领取', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const admin = store.createUser({ name:'管理员', username:'owner', password:'test-secret-123', role:'admin' });
  store.commitImport(admin, await previewImport(store, sample, '示例.csv', { basis:'脱敏测试' }));
  assert.equal(store.dashboard(admin).pool, 0);
  const item = store.nextSync();
  assert.equal(item.kind, '线索');
  store.syncConfirmed(item, 'rec-test');
  assert.equal(store.dashboard(admin).pool, 1);
});

test('飞书受控字段被手改时冻结，原值核对通过后恢复', async (t) => {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const admin=store.createUser({name:'管理员',username:'owner',password:'test-secret-123',role:'admin'});
  store.commitImport(admin,await previewImport(store,sample,'示例.csv',{basis:'脱敏测试'}));
  let record;
  const remote={ find:async()=>record?[record]:[],create:async (item,fields)=>(record={record_id:'rec-1',fields}) };
  await syncOne(store,remote);
  const initial=record.fields.归属;
  record.fields.归属='被手改的归属';
  await auditRemote(store,remote,0);
  assert.equal(store.dashboard(admin).pool,0);
  const item=store.outbox()[0];
  assert.equal(item.state,'conflict');
  assert.equal(await verifyConflict(store,remote,admin,item.id),false);
  record.fields.归属=initial;
  assert.equal(await verifyConflict(store,remote,admin,item.id),true);
  assert.equal(store.dashboard(admin).pool,1);
});

test('已入库线索补充来源待同步时仍可领取',async (t)=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const admin=store.createUser({name:'管理员',username:'owner',password:'test-secret-123',role:'admin'});
  await previewImport(store,sample,'样例.csv',{basis:'测试'}).then(preview=>store.commitImport(admin,preview));
  store.syncConfirmed(store.nextSync(),'rec-1');
  await previewImport(store,sample,'另一个来源.csv',{basis:'另一个联系依据'}).then(preview=>store.commitImport(admin,preview));
  assert.equal(store.dashboard(admin).pool,1);
  const seller=store.createUser({name:'销售',username:'sales-x',password:'test-secret-123',role:'sales'},admin);
  assert.equal(store.claim(seller,1,'fixture-claim').length,1);
});

test('远端新增勿扰在冲突修复后仍拦截领取',async (t)=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const admin=store.createUser({name:'管理员',username:'owner',password:'test-secret-123',role:'admin'});
  store.commitImport(admin,await previewImport(store,sample,'样例.csv',{basis:'测试'}));
  let record;
  const remote={find:async()=>record?[record]:[],create:async(item,fields)=>(record={record_id:'rec-1',fields})};
  await syncOne(store,remote);
  const before=record.fields.状态;
  record.fields.状态='勿扰';
  await auditRemote(store,remote,0);
  record.fields.状态=before;
  await verifyConflict(store,remote,admin,store.outbox()[0].id);
  assert.equal(store.dashboard(admin).pool,0);
  assert.equal(store.leadByPhone('01055550123').dnc,1);
});

test('加密快照可隔离恢复，错误口令和覆盖已有数据库均被拒绝', async (t)=>{
  const dir=await mkdtemp(join(tmpdir(),'workbench-backup-'));
  const store=openStore(join(dir,'original.sqlite'),{demo:true});
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const [admin,alice]=store.users();
  store.commitImport(admin,await previewImport(store,sample,'样例.csv'));
  const [lead]=store.claim(alice,1,'bk-claim-1');
  store.contact(alice,lead.id,{result:'missed',nextNote:'稍后核实需求'},'bk-contact-1');
  const key='test-only-backup-passphrase', encrypted=join(dir,'snapshot.rentalbak'), target=join(dir,'restored.sqlite');
  await protectBackup(store,encrypted,key);
  await assert.rejects(recoverBackup(encrypted,target,'incorrect-test-backup-passphrase'),/authenticate/);
  await recoverBackup(encrypted,target,key);
  await assert.rejects(recoverBackup(encrypted,target,key),{code:'EEXIST'});
  const recovered=openStore(target,{demo:true});
  try { assert.deepEqual(recovered.detail(alice,lead.id).logs.map(row=>row.result),['missed']); }
  finally { recovered.close(); }
});

test('飞书客户端使用应用凭据、业务标识和稳定的创建幂等键', async (t) => {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const admin=store.createUser({name:'管理员',username:'owner',password:'test-secret-123',role:'admin'});
  store.commitImport(admin,await previewImport(store,sample,'样例.csv',{basis:'脱敏测试'}));
  const entity=store.nextSync().entity;
  const seen=[];
  const remote=feishuClient({id:'test-app',secret:'test-config',base:'test-base',table:'test-table'}, { fetcher:async (url,request)=>{
    const path=new URL(url);
    const body=request.body?JSON.parse(request.body):null;
    seen.push({path:path.pathname,method:request.method,body,auth:request.headers.authorization,token:path.searchParams.get('client_token')});
    if (path.pathname.endsWith('/internal')) return Response.json({code:0,tenant_access_token:'test-token',expire:7200});
    if (path.pathname.endsWith('/fields')) return Response.json({code:0,data:{items:fieldNames.map(field_name=>({field_name,type:1}))}});
    if (path.pathname.endsWith('/search')) return Response.json({code:0,data:{total:0,items:[]}});
    if (path.pathname.endsWith('/records')) return Response.json({code:0,data:{record:{record_id:'rec-1',fields:body.fields}}});
    return Response.json({code:1},{status:400});
  }});
  await remote.checkFields();
  await syncOne(store,remote);
  assert.equal(store.dashboard(admin).pool,1);
  assert.equal(seen.length,4);
  assert.equal(seen[0].body.app_id,'test-app');
  assert.ok(seen.slice(1).every(call=>call.auth==='Bearer test-token'));
  assert.equal(seen[2].body.filter.conditions[0].value[0],entity);
  assert.equal(seen[3].token,entity);
});

test('正式库恢复后需要完整核对，能查出备份之后新增的远端记录',async (t)=>{
  const dir=await mkdtemp(join(tmpdir(),'workbench-check-restore-'));
  const store=openStore(join(dir,'source.sqlite'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const admin=store.createUser({name:'管理员',username:'owner',password:'test-secret-123',role:'admin'});
  const pass='test-only-backup-passphrase', encrypt=join(dir,'backup.rentalbak'), out=join(dir,'restore.sqlite');
  await protectBackup(store,encrypt,pass);
  store.commitImport(admin,await previewImport(store,sample,'样例.csv',{basis:'脱敏测试'}));
  const records=[];
  const remote={find:async()=>[],create:async(item,fields)=>{const record={record_id:'rec-1',fields};records.push(record);return record;},list:async function*(){yield* records;}};
  await syncOne(store,remote);
  await recoverBackup(encrypt,out,pass);
  const restored=openStore(out);
  try {
    assert.equal(restored.requiresRecovery(),true);
    assert.deepEqual(await checkRestored(restored,remote),{extra:1,different:0,missing:0});
    assert.equal(restored.requiresRecovery(),true);
  } finally {restored.close();}
});
