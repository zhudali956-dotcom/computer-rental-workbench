import assert from 'node:assert/strict';
import { X509Certificate, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { strFromU8, unzipSync } from 'fflate';
import { openStore } from '../server/store.mjs';
import { createApp } from '../server/http.mjs';
import { loadFeishuConfig } from '../server/feishu-config.mjs';
import { feishuClient, syncOne } from '../server/feishu.mjs';
import { productionTls } from '../server/production.mjs';
import { contentAi } from '../server/content-ai.mjs';

const acceptanceTable = process.env.WORKBENCH_ACCEPTANCE_TABLE;
const config=await loadFeishuConfig(process.env);
if(!acceptanceTable||acceptanceTable===config.table)throw Error('请指定独立的飞书验收表');
const remote=feishuClient({...config,table:acceptanceTable});
await remote.checkFields();
const productionRemote=feishuClient(config);
async function productionIds(){const ids=[];for await(const r of productionRemote.list())ids.push(r.record_id);return ids.sort();}
const productionBefore=await productionIds();
const store=openStore(':memory:');
store.bindFeishu({...config,table:acceptanceTable});
const password=`accept-${randomUUID()}`;
store.createUser({username:'admin',name:'验收管理员',password,role:'admin'});
const server=createServer(productionTls(process.env,'127.0.0.1'),createApp(store,{secure:true,remote,ai:contentAi({},{mock:true})}));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const ca=new X509Certificate(await readFile(process.env.WORKBENCH_CA_FILE)).toString();
async function call(path,{method='GET',cookie,body,type='application/json',key=randomUUID()}={}) {
  if(body&&!(body instanceof Buffer))body=Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,method,ca,timeout:10000,
      headers:{...(cookie?{cookie}:{}),...(body?{'content-length':body.length,'content-type':type}:{}),'idempotency-key':key}},response=>{
      const chunks=[];response.on('data',part=>chunks.push(part));response.on('end',()=>{
        const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');
        resolve({status:response.statusCode,json:()=>JSON.parse(text),headers:response.headers,text,bytes});
      });
    });req.once('error',reject);req.once('timeout',()=>req.destroy(Error('本地 HTTPS 验收请求超时')));req.end(body);
  });
}
const signedCookie=response=>response.headers['set-cookie'][0].split(';')[0];
async function post(path,cookie,body){const response=await call(path,{method:'POST',cookie,body});assert.equal(response.status,200,`${path}: ${response.text}`);return response.json();}
const runId=`验收 ${new Date().toISOString().slice(0,10)} ${randomUUID().slice(0,6)}`;
async function flush(){while(await syncOne(store,remote)){}assert.deepEqual(store.outbox(),[]);}
const field=(row,name)=>Array.isArray(row.fields[name])?row.fields[name].map(part=>part.text).join(''):row.fields[name];
try {
  assert.equal((await call('/')).status,200);
  assert.equal((await call('/api/dashboard')).status,401);
  const admin=await call('/api/login',{method:'POST',body:{username:'admin',password}});
  assert.equal(admin.status,200);
  assert.match(admin.headers['set-cookie'][0],/^__Host-rental_production=.*; Path=\/;[^\r\n]*HttpOnly; Secure/);
  const cookie=signedCookie(admin);
  const accounts={};
  for(const [username,name] of [['sales-a','验收销售甲'],['sales-b','验收销售乙'],['operator-a','验收运营甲']]){
    accounts[username]=await post('/api/admin/employees',cookie,{username,name,password,role:'sales'});
  }
  const form=new FormData();
  const phone=`400${randomInt(0,10000000).toString().padStart(7,'0')}`;
  form.append('file',new Blob([`企业名称,联系电话,来源,联系依据\n${runId}虚构公司,${phone},合成数据,隔离验收\n${runId}虚构公司,${phone},合成数据,隔离验收\n异常号码示例,号码缺失,合成数据,隔离验收\n`]),'验收.csv');
  const batch=new Response(form);
  const preview=await call('/api/admin/import/preview',{method:'POST',cookie,body:Buffer.from(await batch.arrayBuffer()),type:batch.headers.get('content-type')});
  assert.equal(preview.status,200);
  const imported=await post('/api/admin/import/commit',cookie,{key:preview.json().key});
  assert.deepEqual(imported.summary,{new:1,updated:0,duplicate:1,dnc:0,review:1});
  assert.equal((await post('/api/admin/import/commit',cookie,{key:preview.json().key})).id,imported.id);
  assert.match((await call(`/api/admin/batches/${imported.id}.csv`,{cookie})).text,/待复核/);
  await syncOne(store,remote);
  const cookies=[];
  for(const username of ['sales-a','sales-b'])cookies.push(signedCookie(await call('/api/login',{method:'POST',body:{username,password}})));
  const results=await Promise.all(cookies.map(cookie=>call('/api/leads/claim',{method:'POST',cookie,body:{quantity:1}})));
  assert.ok(results.every(response=>response.status===200));
  const claimed=results.map(response=>response.json());
  assert.equal(claimed.flat().length,1);
  const winner=claimed.findIndex(rows=>rows.length),id=claimed[winner][0].id;
  assert.equal((await call(`/api/leads/${id}`,{cookie:cookies[1-winner]})).status,404);
  assert.equal((await call('/api/admin/sync',{cookie:cookies[winner]})).status,403);
  const owner=cookies[winner],next=new Date(Date.now()+86400000).toISOString();
  const firstCall={result:'interested',notes:'虚拟对话：需 8 台电脑',nextNote:'复核租期与报价',next};
  const contactArgs={method:'POST',cookie:owner,body:firstCall,key:randomUUID()};
  const firstContact=(await call(`/api/leads/${id}/contact`,contactArgs)).json();assert.ok(firstContact.id);
  assert.deepEqual((await call(`/api/leads/${id}/contact`,contactArgs)).json(),firstContact);
  assert.equal((await call('/api/leads?view=followup',{cookie:owner})).json().rows[0].id,id);
  const deal=await post(`/api/leads/${id}/opportunity`,owner,{stage:'待报价',model:'虚拟商务笔记本',quantity:8,term:'3 天',city:'虚构交付点'});
  const refused=await post(`/api/leads/${id}/contact`,owner,{result:'refused',notes:'测试客户要求停止联系'});
  const detail=(await call(`/api/leads/${id}`,{cookie:owner})).json();
  assert.equal(detail.logs.length,2);assert.equal(detail.lead.dnc,1);assert.equal(detail.lead.next,null);
  assert.equal((await call('/api/leads?view=followup',{cookie:owner})).json().total,0);
  assert.equal((await call(`/api/leads/${id}/contact`,{method:'POST',cookie:owner,body:firstCall})).status,409);
  assert.match((await call('/api/admin/today.csv',{cookie})).text,/验收销售/);
  await flush();
  console.log(`${runId} 销售链路通过：3 行导入，1 条有效、1 条重复、1 条复核。并发仅 1 人领取，跟进防重、商机、回访与勿扰均通过。`);

  const operator=signedCookie(await call('/api/login',{method:'POST',body:{username:'operator-a',password}}));
  const a=await post('/api/content/accounts',cookie,{platform:'xiaohongshu',name:`${runId}虚拟运营号`,handle:`fake-${randomUUID().slice(0,8)}`,operator:accounts['operator-a'].id,state:'ready'});
  const facts=await post('/api/content/facts',cookie,{name:`${runId}虚拟租赁资料`,details:'虚拟会务笔记本短租，只用于验收。',source:'合成数据'});
  for(const kind of ['copy','image']){
    assert.equal((await call('/api/content/ai',{method:'POST',cookie:operator,body:{account:a.id,fact:facts.id,kind,prompt:'验收模拟，请生成会务短租稿件'}})).status,202);
  }
  const generated=(await call('/api/content',{cookie:operator})).json().aiJobs;
  assert.equal(generated.filter(row=>row.state==='done').length,2);
  const image=JSON.parse(generated.find(row=>row.kind==='image').result).asset;
  assert.equal((await call(`/api/content/assets/${image}`,{cookie:cookies[0]})).status,404);
  const draft=await post('/api/content/drafts',operator,{account:a.id,fact:facts.id,format:'image',title:`${runId}图文稿`,body:JSON.parse(generated.find(row=>row.kind==='copy').result).text,tags:'#会务',media:[image],cover:image});
  const draftUrl=`/api/content/drafts/${draft.id}`,version=draft.version;
  await post(`${draftUrl}/submit`,operator,{version});
  assert.equal((await call(`${draftUrl}/review`,{method:'POST',cookie:operator,body:{version,action:'approve'}})).status,403);
  await post(`${draftUrl}/review`,cookie,{version,action:'approve',note:'虚拟素材审核通过'});
  const deadline=Date.now()+1400;
  const job=await post(`${draftUrl}/schedule`,operator,{version,planned:new Date(deadline).toISOString()});
  const jobUrl=`/api/content/jobs/${job.id}`;
  assert.equal((await call(`${jobUrl}/package`,{cookie:operator})).status,409);
  await delay(Math.max(0,deadline-Date.now()+100));
  await post(`${jobUrl}/result`,operator,{state:'working'});
  const zip=await call(`${jobUrl}/package`,{cookie:operator});assert.equal(zip.status,200);
  const archive=unzipSync(zip.bytes),manifest=JSON.parse(strFromU8(archive['清单.json']));
  assert.equal(manifest.contentVersion,version);assert.equal(manifest.account.id,a.id);assert.equal(manifest.media[0].id,image);
  const proof=await post(`${draftUrl}/platform-draft`,operator,{version,browser:'虚拟验收浏览器',note:'模拟暂存凭证，未操作真实小红书'});
  await post(`${jobUrl}/result`,operator,{state:'unknown',note:'模拟回执未知，等待核对'});
  assert.equal((await call(`${jobUrl}/package`,{cookie:operator})).status,409);
  await flush();
  const expected=[[id,'勿扰'],[firstContact.id,'接通有需求'],[refused.id,'拒绝联系'],[deal.id,'待报价'],[draft.id,'已审核'],[job.id,'结果待核验'],[proof.id,'已存平台草稿']];
  const linked=[];
  for(const [entity,state] of expected){const records=await remote.find(entity);assert.equal(records.length,1);assert.equal(field(records[0],'状态'),state);linked.push({type:field(records[0],'类型'),state,record:records[0].record_id});}
  assert.deepEqual(await productionIds(),productionBefore);
  console.log('内容链路通过：模拟 AI 生成、账号素材权限、运营不能自审、审核后排期、发布包核对、模拟草稿凭证和待核验状态。');
  console.log(JSON.stringify({runId,testAccounts:['验收管理员','验收销售甲','验收销售乙','验收运营甲'],linked,formalRecordCount:productionBefore.length}));
} finally {await new Promise(resolve=>server.close(resolve));store.close();}
