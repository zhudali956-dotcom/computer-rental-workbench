import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../server/store.mjs';
import { unzipSync,strFromU8 } from 'fflate';
import { contentAi } from '../server/content-ai.mjs';
import { syncOne } from '../server/feishu.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3sAAAAASUVORK5CYII=','base64');
const future=()=>new Date(Date.now()+86400000).toISOString();

function scenario(t, platform='xiaohongshu') {
  const store=openStore(':memory:',{demo:true}); t.after(()=>store.close());
  const [admin,alice,bob]=store.users(), ops=store.content;
  const account=ops.account(admin,{platform,name:'租赁演示号',handle:'demo-001',operator:alice.id});
  const fact=ops.fact(admin,{name:'测试用电脑租赁',details:'可按天租赁，数量以确认结果为准',source:'测试资料'});
  const asset=ops.upload(alice,account.id,'封面.png',image);
  const draft={account:account.id,fact:fact.id,format:'image',title:'会务用电脑租赁',body:'详情请咨询',media:[asset.id]};
  return {ops,admin,alice,bob,account,draft,asset};
}

test('审核锁定版本，撤销操作员后禁止导出和回填',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const {ops,admin,alice,bob,account,draft,asset}=scenario(t);
  assert.throws(()=>ops.asset(bob,asset.id),{status:404});
  const created=ops.save(alice,draft);
  assert.throws(()=>ops.review(alice,created.id,created.version,'approve'),{status:403});
  ops.submit(alice,created.id,created.version);
  ops.review(admin,created.id,created.version,'approve');
  const job=ops.schedule(alice,created.id,created.version,future());
  assert.throws(()=>ops.package(alice,job.id),{status:409});
  assert.throws(()=>ops.result(alice,job.id,{state:'working'}),{status:409});
  t.mock.timers.tick(86400000);
  ops.result(alice,job.id,{state:'working'});
  assert.equal(ops.package(alice,job.id).snapshot.title,draft.title);
  const other=ops.save(alice,{...draft,title:'另一份电脑租赁稿件'});
  ops.submit(alice,other.id,other.version);
  ops.review(admin,other.id,other.version,'approve');
  const waiting=ops.schedule(alice,other.id,other.version,future());
  t.mock.timers.tick(86400000);
  assert.throws(()=>ops.result(alice,waiting.id,{state:'working'}),{status:409});
  assert.throws(()=>ops.result(alice,waiting.id,{state:'reviewing',note:'尝试跳过工位'}),{status:409});
  assert.throws(()=>ops.package(alice,waiting.id),{status:409});
  const edit=ops.save(alice,{...draft,id:created.id,version:created.version,title:'新标题'});
  assert.throws(()=>ops.schedule(alice,created.id,edit.version,future()),{status:409});
  assert.equal(ops.package(alice,job.id).snapshot.title,draft.title);
  ops.account(admin,{...account,operator:bob.id});
  assert.throws(()=>ops.package(alice,job.id),{status:404});
  assert.throws(()=>ops.package(bob,job.id),{status:409});
  ops.result(admin,job.id,{state:'unknown',note:'核验原操作员的提交情况'});
  const reassigned=ops.result(admin,job.id,{state:'ready',note:'平台后台核对确认未提交'});
  assert.equal(reassigned.operator,bob.id);
  ops.result(bob,job.id,{state:'working'});
  assert.equal(ops.package(bob,job.id).snapshot.title,draft.title);
});

test('发布结果未知会阻止同一内容重排，核验和回填必须带证据',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const {ops,admin,alice,draft}=scenario(t,'douyin');
  const approve=data=>{const item=ops.save(alice,data);ops.submit(alice,item.id,item.version);ops.review(admin,item.id,item.version,'approve');return item;};
  const first=approve(draft), job=ops.schedule(alice,first.id,first.version,future());
  t.mock.timers.tick(86400000);
  ops.result(alice,job.id,{state:'working'});
  ops.result(alice,job.id,{state:'unknown',note:'提交后未看到回执'});
  const second=approve(draft);
  assert.throws(()=>ops.schedule(alice,second.id,second.version,future()),{status:409});
  assert.throws(()=>ops.result(alice,job.id,{state:'public'}),{status:400});
  assert.throws(()=>ops.result(alice,job.id,{state:'public',url:'https://example.com/video/1'}),{status:400});
  ops.result(alice,job.id,{state:'reviewing',note:'平台后台已收到稿件'});
  ops.result(alice,job.id,{state:'public',url:'https://www.douyin.com/video/123456',note:'退出账号后打开作品页核验'});
  assert.equal(ops.home(alice).jobs[0].state,'public');
});

test('两个平台的图文与视频均导出审核清单、原文件及平台文案',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const mp4=Buffer.from('000000186674797069736f6d0000000069736f6d69736f32','hex');
  for(const platform of ['xiaohongshu','douyin']) {
    const {ops,admin,alice,draft,account,asset}=scenario(t,platform);
    const video=ops.upload(alice,account.id,'演示视频.mp4',mp4);
    for(const format of ['image','video']) {
      const v=ops.save(alice,{...draft,format,media:format==='image'?[asset.id]:[video.id,asset.id],cover:asset.id});
      ops.submit(alice,v.id,v.version);ops.review(admin,v.id,v.version,'approve');
      const job=ops.schedule(alice,v.id,v.version,future());
      t.mock.timers.tick(86400000);
      ops.result(alice,job.id,{state:'working'});
      const files=unzipSync(ops.download(alice,job.id));
      const manifest=JSON.parse(strFromU8(files['清单.json']));
      assert.equal(manifest.contentVersion,1);
      assert.equal(manifest.account.platform,platform);
      assert.equal(manifest.format,format);
      assert.equal(strFromU8(files['标题正文.txt']).split('\n')[0],draft.title);
      assert.deepEqual(Buffer.from(files[manifest.media[0].file]),format==='image'?image:mp4);
      ops.result(alice,job.id,{state:'unknown',note:'测试结束'});
    }
  }
});

test('预算预留覆盖并发和未知状态，操作号重试复用原任务',t=>{
  const {ops,admin,alice,draft}=scenario(t);
  const policy={daily:10,personal:5,rates:{copy:5}};
  const request={account:draft.account,fact:draft.fact,kind:'copy',prompt:'写会场短租说明'};
  const first=ops.reserveAi(alice,request,'sample-ai-001',policy);
  assert.ok(first.request);
  assert.equal(ops.reserveAi(alice,request,'sample-ai-001',policy).request,undefined);
  ops.finishAi(first.job.id,'unknown',{});
  assert.throws(()=>ops.reserveAi(alice,{...request,prompt:'另一份说明'},'sample-ai-002',policy),{status:409});
  assert.throws(()=>ops.resolveAi(alice,first.job.id,false,'已查账'),{status:403});
  ops.resolveAi(admin,first.job.id,false,'账单已核对');
  assert.ok(ops.reserveAi(alice,request,'sample-ai-002',policy).request);
});

test('OpenAI 适配器按类型提交 Responses、图片生成和图片编辑',async()=>{
  const calls=[];
  const env={OPENAI_API_KEY:'fixture-key',OPENAI_DAILY_BUDGET_CENTS:'50',OPENAI_USER_BUDGET_CENTS:'25',OPENAI_TEXT_RESERVE_CENTS:'2',OPENAI_IMAGE_RESERVE_CENTS:'5',OPENAI_TEXT_MODEL:'fixture-text',OPENAI_IMAGE_MODEL:'fixture-image'};
  const ai=contentAi(env,{fetcher:async(url,options)=>{
    calls.push({url,options});
    return Response.json(url.endsWith('/responses')?{output:[{content:[{type:'output_text',text:'示例文本'}]}]}:{data:[{b64_json:image.toString('base64')}]});
  }});
  const input={request:'简短实用',fact:{name:'测试租赁',details:'真实参数'},platform:'小红书'};
  assert.equal((await ai.generate({...input,kind:'copy'})).text,'示例文本');
  assert.deepEqual((await ai.generate({...input,kind:'image'})).image,image);
  assert.deepEqual((await ai.generate({...input,kind:'edit',reference:{data:image,mime:'image/png'}})).image,image);
  assert.match(JSON.parse(calls[0].options.body).input,/真实参数/);
  assert.equal(JSON.parse(calls[0].options.body).store,false);
  assert.equal(calls[2].options.body.get('image').type,'image/png');
  assert.equal(contentAi({...env,OPENAI_USER_BUDGET_CENTS:''}),null);
});

test('内容元数据进入原有飞书写入队列，素材二进制只存本地',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());
  const user=store.createUser({name:'管理员',username:'admin',password:'test-pass-2026',role:'admin'});
  const a=store.content.account(user,{name:'演示抖音',platform:'douyin',handle:'service-test',operator:user.id});
  store.content.upload(user,a.id,'测试素材.png',image);
  const records=[];
  const fake={find:async()=>[],create:async(item,fields)=>{records.push(fields);return{record_id:`rec-${records.length}`,fields};}};
  await syncOne(store,fake);await syncOne(store,fake);
  assert.deepEqual(records.map(r=>r.类型),['社媒账号','素材']);
  assert.equal(JSON.parse(records[1].快照).data,undefined);
  assert.equal(store.outbox().length,0);
});

test('平台草稿凭证按稿件版本保存，和审核、公开发布状态分开',t=>{
  const {ops,admin,alice,bob,draft,asset}=scenario(t);
  const first=ops.save(alice,draft);
  const details={browser:'联调浏览器',note:'草稿箱已看到对应标题和封面',evidence:asset.id};
  assert.throws(()=>ops.recordPlatformDraft(bob,first.id,first.version,details),{status:404});
  const proof=ops.recordPlatformDraft(alice,first.id,first.version,details);
  assert.equal(ops.recordPlatformDraft(alice,first.id,first.version,details).id,proof.id);
  assert.equal(ops.home(admin).contents[0].state,'draft');
  assert.equal(ops.home(admin).contents[0].platformDraft.id,proof.id);
  assert.equal(ops.home(admin).jobs.length,0);
  const next=ops.save(alice,{...draft,id:first.id,version:first.version,title:'二次编辑'});
  assert.equal(next.version,2);
  assert.equal(ops.home(admin).contents[0].platformDraft,null);
  assert.throws(()=>ops.recordPlatformDraft(alice,first.id,first.version,details),{status:409});
});
