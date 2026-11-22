import { createHash, randomUUID } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { fail } from './store.mjs';

export const platforms={xiaohongshu:'小红书',douyin:'抖音'};
export const accountStates={pending:'待登录',ready:'可用',login:'需重新登录',disabled:'停用'};
export const contentStates={draft:'草稿',pending:'待审核',rejected:'已退回',approved:'已审核'};
export const jobStates={scheduled:'已排期',working:'待人工提交',unknown:'结果待核验',submitted:'已提交',reviewing:'审核中',public:'公开可见',rejected:'平台驳回',removed:'已删除',cancelled:'已取消'};
const clean=(v,n=300)=>typeof v==='string'?v.trim().slice(0,n):'';
const time=()=>new Date().toISOString();
const day=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const hash=v=>createHash('sha256').update(v).digest('hex');
const admin=user=>{if(user.role!=='admin')fail(403,'需要管理员权限');};
const maxAsset=40*1024*1024;
const maxTotal=256*1024*1024;
const selects='id,account,name,mime,bytes,sha,created';

function mediaType(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
  if(bytes.length>3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff)return 'image/jpeg';
  if(bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  if(bytes.toString('ascii',4,8)==='ftyp' && bytes.length>20)return bytes.toString('ascii',8,12)==='qt  '?'video/quicktime':'video/mp4';
  return '';
}
const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/quicktime':'mov'};
const hostList={xiaohongshu:['xiaohongshu.com','xhslink.com'],douyin:['douyin.com','iesdouyin.com']};
function publicationUrl(value,platform) {
  if(!value)return '';
  try {
    const url=new URL(value);
    if(url.protocol==='https:' && !url.username && !url.password && !url.port && hostList[platform].some(host=>url.hostname===host || url.hostname.endsWith(`.${host}`)))return url.href;
  } catch { /* 由统一提示说明平台链接格式。 */ }
  fail(400,'请填写对应平台的 HTTPS 作品链接');
}

export function initContent(db,{tx,audit,queue}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_accounts(id TEXT PRIMARY KEY,platform TEXT,name TEXT,handle TEXT,editor INTEGER REFERENCES users(id),
      operator INTEGER REFERENCES users(id),state TEXT,version INTEGER,UNIQUE(platform,handle));
    CREATE TABLE IF NOT EXISTS business_facts(id TEXT PRIMARY KEY,series TEXT,version INTEGER,name TEXT,details TEXT,source TEXT,
      effective TEXT,expires TEXT,actor INTEGER REFERENCES users(id),created TEXT,UNIQUE(series,version));
    CREATE TABLE IF NOT EXISTS content_assets(id TEXT PRIMARY KEY,account TEXT REFERENCES social_accounts(id),name TEXT,mime TEXT,bytes INTEGER,
      sha TEXT,data BLOB,created TEXT,UNIQUE(account,sha));
    CREATE TABLE IF NOT EXISTS content_items(id TEXT PRIMARY KEY,account TEXT REFERENCES social_accounts(id),version INTEGER,author INTEGER REFERENCES users(id),updated TEXT);
    CREATE TABLE IF NOT EXISTS content_versions(content TEXT REFERENCES content_items(id),version INTEGER,snapshot TEXT,state TEXT,
      reviewed TEXT,reviewer INTEGER REFERENCES users(id),note TEXT,revision INTEGER DEFAULT 1,PRIMARY KEY(content,version));
    CREATE TABLE IF NOT EXISTS platform_drafts(id TEXT PRIMARY KEY,content TEXT,content_version INTEGER,account TEXT REFERENCES social_accounts(id),
      browser TEXT,note TEXT,evidence TEXT REFERENCES content_assets(id),actor INTEGER REFERENCES users(id),at TEXT,revision INTEGER,
      UNIQUE(content,content_version),FOREIGN KEY(content,content_version) REFERENCES content_versions(content,version));
    CREATE TABLE IF NOT EXISTS xhs_draft_runs(content TEXT,content_version INTEGER,stage TEXT,at TEXT,
      PRIMARY KEY(content,content_version),FOREIGN KEY(content,content_version) REFERENCES content_versions(content,version));
    CREATE TABLE IF NOT EXISTS publish_jobs(id TEXT PRIMARY KEY,content TEXT REFERENCES content_items(id),content_version INTEGER,
      account TEXT REFERENCES social_accounts(id),fingerprint TEXT,planned TEXT,operator INTEGER REFERENCES users(id),state TEXT,
      attempts INTEGER DEFAULT 0,revision INTEGER DEFAULT 1,updated TEXT,UNIQUE(content,content_version));
    CREATE INDEX IF NOT EXISTS publish_jobs_fingerprint ON publish_jobs(account,fingerprint,state);
    CREATE TABLE IF NOT EXISTS publish_events(id INTEGER PRIMARY KEY,job TEXT REFERENCES publish_jobs(id),state TEXT,url TEXT,note TEXT,
      evidence TEXT REFERENCES content_assets(id),actor INTEGER REFERENCES users(id),at TEXT);
    CREATE TABLE IF NOT EXISTS ai_content_jobs(id TEXT PRIMARY KEY,actor INTEGER REFERENCES users(id),account TEXT REFERENCES social_accounts(id),
      kind TEXT,state TEXT,amount INTEGER,day TEXT,signature TEXT,result TEXT,created TEXT,updated TEXT);
    CREATE INDEX IF NOT EXISTS ai_content_jobs_day ON ai_content_jobs(day,state);`);
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const change=(kind,id,revision,data)=>queue(kind,id,id,revision,{id,version:revision,...data});
  const readable=(user,a)=>a && (user.role==='admin' || (a.state!=='disabled' && (a.editor===user.id || a.operator===user.id)));
  const conflicted=(id)=>get("SELECT 1 FROM outbox WHERE lead_id=? AND state='conflict'",id);
  function access(user,id,write=false) {
    const a=get('SELECT * FROM social_accounts WHERE id=?',id??'');
    if(!readable(user,a))fail(404,'账号不存在或无权访问');
    if(write && (a.state==='disabled' || conflicted(a.id)))fail(409,'账号已停用或等待飞书对账');
    return a;
  }
  function account(user,input) {
    admin(user);
    const name=clean(input.name,80),handle=clean(input.handle,100),platform=input.platform,state=input.state??'ready';
    const editor=input.editor?Number(input.editor):null,operator=input.operator?Number(input.operator):null;
    if(!Object.hasOwn(platforms,platform) || !Object.hasOwn(accountStates,state) || !name || !handle)fail(400,'请填写平台、账号名称和可核对的账号标识');
    for(const employee of [editor,operator])if(employee && !get('SELECT 1 FROM users WHERE id=? AND enabled=1',employee))fail(400,'负责人须为启用的员工');
    return tx(()=>{
      const prev=input.id?access(user,input.id):null;
      if(prev && (prev.platform!==platform || prev.handle!==handle))fail(400,'平台和账号标识不可覆盖，请另建账号');
      const duplicate=get('SELECT id FROM social_accounts WHERE platform=? AND handle=?',platform,handle);
      if(duplicate && duplicate.id!==prev?.id)fail(409,'该平台账号已登记');
      const a={id:prev?.id??randomUUID(),platform,name,handle,editor,operator,state,version:(prev?.version??0)+1};
      run(`INSERT INTO social_accounts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,editor=excluded.editor,
        operator=excluded.operator,state=excluded.state,version=excluded.version`,...Object.values(a));
      change('社媒账号',a.id,a.version,a);audit(user,'保存社媒账号',a.id);
      return a;
    });
  }
  function fact(user,input) {
    admin(user);
    const name=clean(input.name,100),details=clean(input.details,3000),source=clean(input.source,300),effective=clean(input.effective,10)||day(),expires=clean(input.expires,10);
    if(!name||!details||!source || !/^\d{4}-\d{2}-\d{2}$/.test(effective) || (expires && (!/^\d{4}-\d{2}-\d{2}$/.test(expires)||expires<effective)))fail(400,'请检查资料名称、事实、来源与有效期');
    return tx(()=>{
      const prev=input.id?get('SELECT * FROM business_facts WHERE id=?',input.id):null;
      if(input.id && !prev)fail(404,'资料版本不存在');
      const series=prev?.series??randomUUID(), revision=get('SELECT max(version) AS v FROM business_facts WHERE series=?',series).v??0;
      if(prev && revision!==prev.version)fail(409,'已有新版本，请刷新资料');
      const obj={id:randomUUID(),series,version:revision+1,name,details,source,effective,expires,actor:user.id,created:time()};
      run('INSERT INTO business_facts VALUES(?,?,?,?,?,?,?,?,?,?)',...Object.values(obj));
      // 每份事实版本是独立且不可变的远端记录。
      change('业务资料',obj.id,1,{...obj,factVersion:obj.version,version:1});audit(user,'保存业务资料版本',obj.id);
      return obj;
    });
  }
  function getFact(id) {
    const fact=get('SELECT * FROM business_facts WHERE id=?',id??'');
    if(!fact)fail(400,'请选择业务资料版本');
    if(fact.effective>day() || (fact.expires && fact.expires<day()) || conflicted(fact.id))fail(409,'业务资料未生效、已过期或待核验');
    return fact;
  }
  function upload(user,accountId,name,buffer) {
    const a=access(user,accountId,true);
    if(!buffer?.length || buffer.length>maxAsset)fail(400,'素材单个文件限 40 MB');
    const content=Buffer.from(buffer),mime=mediaType(content);
    if(!mime)fail(400,'素材支持 PNG、JPEG、WebP、MP4 和 MOV');
    const sha=hash(content);
    return tx(()=>{
      const prior=get(`SELECT ${selects} FROM content_assets WHERE account=? AND sha=?`,a.id,sha);
      if(prior)return prior;
      if(get('SELECT coalesce(sum(bytes),0) AS used FROM content_assets').used+content.length>maxTotal)fail(409,'当前素材库已到本机试运行容量上限');
      const item={id:randomUUID(),account:a.id,name:clean(name,150)||`素材.${extension[mime]}`,mime,bytes:content.length,sha,created:time()};
      run('INSERT INTO content_assets(id,account,name,mime,bytes,sha,created,data) VALUES(?,?,?,?,?,?,?,?)',...Object.values(item),content);
      change('素材',item.id,1,item);audit(user,'添加内容素材',item.id);
      return item;
    });
  }
  function asset(user,id) {
    const row=get('SELECT * FROM content_assets WHERE id=?',id??'');
    if(!row)fail(404,'素材不存在或无权访问');
    access(user,row.account);
    return row;
  }
  function save(user,input) {
    return tx(()=>{
      const a=access(user,input.account,true),f=getFact(input.fact);
      const id=input.id??randomUUID(), prior=get('SELECT * FROM content_items WHERE id=?',id);
      if(input.id&&!prior)fail(404,'内容不存在');
      if(prior) {
        access(user,prior.account,true);
        if(prior.version!==input.version || conflicted(id))fail(409,'内容已变更或待对账，请刷新');
        if(prior.account!==a.id)fail(400,'请为另一个平台账号新建稿件并单独审核');
      }
      const title=clean(input.title,120),body=clean(input.body,3500),format=input.format;
      if(!title||!body||!['image','video'].includes(format))fail(400,'请填标题、正文和内容形式');
      if(!Array.isArray(input.media) || input.media.length<1 || input.media.length>9 || new Set(input.media).size!==input.media.length)fail(400,'请选择 1–9 个不同素材');
      const media=input.media.map(id=>{
        const row=asset(user,id);
        if(row.account!==a.id)fail(400,'素材须属于当前账号');
        return {id:row.id,sha:row.sha,mime:row.mime,name:row.name,bytes:row.bytes};
      });
      const number=media.filter(item=>item.mime.startsWith('video/')).length;
      if((format==='image'&&number!==0) || (format==='video'&&(number!==1||media.length>2)))fail(400,'图文仅包含图片，视频稿件包含一个视频和可选的一张封面');
      if(media.reduce((sum,item)=>sum+item.bytes,0)>80*1024*1024)fail(400,'发布包素材合计限 80 MB');
      const cover=clean(input.cover,80);
      if(cover&&!media.some(item=>item.id===cover&&item.mime.startsWith('image/')))fail(400,'封面须为稿件中的图片');
      const version=(prior?.version??0)+1;
      const snapshot={account:{id:a.id,name:a.name,platform:a.platform,handle:a.handle},fact:{id:f.id,version:f.version,name:f.name,details:f.details,source:f.source,effective:f.effective,expires:f.expires},
        format,title,body,media,cover,tags:clean(input.tags,300)};
      run('INSERT INTO content_items VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,updated=excluded.updated',id,a.id,version,prior?.author??user.id,time());
      run("INSERT INTO content_versions(content,version,snapshot,state) VALUES(?,?,?,'draft')",id,version,JSON.stringify(snapshot));
      trackDraft(id,version,'draft',snapshot,1);
      audit(user,'保存内容草稿',id,`版本 ${version}`);
      return {id,version};
    });
  }
  function draft(user,id,version,write=false) {
    const item=get('SELECT * FROM content_items WHERE id=?',id??'');
    if(!item)fail(404,'内容不存在');
    access(user,item.account,write);
    if(write&&conflicted(id))fail(409,'内容正在等待飞书对账');
    const v=get('SELECT * FROM content_versions WHERE content=? AND version=?',item.id,version??item.version);
    if(!v)fail(404,'内容版本不存在');
    return {...v,snapshot:JSON.parse(v.snapshot),current:item.version};
  }
  function trackDraft(id,version,state,snapshot,step) {
    change('内容',id,(version-1)*10+step,{contentVersion:version,state:contentStates[state],title:snapshot.title,account:snapshot.account.id,format:snapshot.format,fact:snapshot.fact.id,media:snapshot.media.map(({id,sha})=>({id,sha})),body:snapshot.body,tags:snapshot.tags});
  }
  function recordPlatformDraft(user,id,version,input) {
    const browser=clean(input.browser,100),note=clean(input.note,500),evidence=clean(input.evidence,80)||null;
    if(!Number.isSafeInteger(version)||!browser||!note)fail(400,'请记录草稿所在浏览器和核验依据');
    return tx(()=>{
      const v=draft(user,id,version,true),a=access(user,v.snapshot.account.id,true);
      if(v.version!==v.current)fail(409,'请核对当前稿件版本后记录');
      if(user.role!=='admin'&&user.id!==a.operator)fail(403,'仅管理员或账号发布操作员可登记平台草稿');
      if(evidence){const file=asset(user,evidence);if(file.account!==a.id||!file.mime.startsWith('image/'))fail(400,'请选择当前账号的草稿截图');}
      const old=get('SELECT * FROM platform_drafts WHERE content=? AND content_version=?',id,version);
      if(old&&old.browser===browser&&old.note===note&&old.evidence===evidence)return old;
      if(old&&conflicted(old.id))fail(409,'平台草稿记录正等待飞书对账');
      const entry={id:old?.id??randomUUID(),content:id,content_version:version,account:a.id,browser,note,evidence,actor:user.id,at:time(),revision:(old?.revision??0)+1};
      run(`INSERT INTO platform_drafts VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET browser=excluded.browser,
        note=excluded.note,evidence=excluded.evidence,actor=excluded.actor,at=excluded.at,revision=excluded.revision`,...Object.values(entry));
      change('平台草稿',entry.id,entry.revision,{content:id,contentVersion:version,account:a.id,title:v.snapshot.title,platform:a.platform,
        state:'已存平台草稿',browser,note,evidence,verifiedAt:entry.at});
      audit(user,'登记平台草稿',entry.id,`稿件 V${version}`);
      return entry;
    });
  }
  function xhsDraftVersion(user,id,version) {
    if(!Number.isSafeInteger(version))fail(400,'请先保存稿件版本');
    const v=draft(user,id,version,true),a=access(user,v.snapshot.account.id,true);
    if(user.role!=='admin'&&user.id!==a.operator)fail(403,'仅账号发布操作员或管理员可准备草稿');
    if(a.platform!=='xiaohongshu'||v.snapshot.format!=='image')fail(400,'草稿助手当前支持小红书图文');
    if(v.version!==v.current||get('SELECT 1 FROM platform_drafts WHERE content=? AND content_version=?',id,version)||
      get('SELECT 1 FROM xhs_draft_runs WHERE content=? AND content_version=?',id,version))fail(409,'当前版本已有草稿或已经开始填写，请先核对平台');
    getFact(v.snapshot.fact.id);
    return {v,a};
  }
  function draftForXhs(user,id,version) {
    const {v,a}=xhsDraftVersion(user,id,version),s=v.snapshot;
    const files=s.media.map((item,index)=>{
      const file=asset(user,item.id);
      if(file.sha!==item.sha||hash(file.data)!==item.sha)fail(409,'稿件素材校验失败');
      return {name:`图${index+1}.${extension[file.mime]}`,mimeType:file.mime,buffer:Buffer.from(file.data)};
    });
    return {account:{handle:a.handle},title:s.title,body:s.body,tags:s.tags,files};
  }
  function beginXhsDraft(user,id,version) {
    tx(()=>{
      xhsDraftVersion(user,id,version);
      run("INSERT INTO xhs_draft_runs VALUES(?,?,'uploading',?)",id,version,time());
      audit(user,'开始填写小红书草稿',id,`稿件 V${version}`);
    });
  }
  const finishXhsDraft=(id,version,stage)=>run('UPDATE xhs_draft_runs SET stage=? WHERE content=? AND content_version=?',stage,id,version);
  function submit(user,id,version) {
    return tx(()=>{
      const v=draft(user,id,version,true);
      if(v.state!=='draft' || v.current!==v.version)fail(409,'仅可提交当前草稿');
      getFact(v.snapshot.fact.id);
      run("UPDATE content_versions SET state='pending',revision=2 WHERE content=? AND version=?",id,v.version);
      trackDraft(id,v.version,'pending',v.snapshot,2);audit(user,'提交内容审核',id);
      return {id,version:v.version,state:'pending'};
    });
  }
  function review(user,id,version,action,note) {
    admin(user);
    if(!['approve','reject'].includes(action))fail(400,'请选择通过或退回');
    note=clean(note,600);
    if(action==='reject'&&!note)fail(400,'退回时请填写原因');
    return tx(()=>{
      const v=draft(user,id,version,true);
      if(v.state!=='pending' || v.current!==v.version)fail(409,'该版本已更新或不在待审核状态');
      if(action==='approve')getFact(v.snapshot.fact.id);
      const state=action==='approve'?'approved':'rejected';
      run('UPDATE content_versions SET state=?,reviewed=?,reviewer=?,note=?,revision=3 WHERE content=? AND version=?',state,time(),user.id,note,id,v.version);
      trackDraft(id,v.version,state,v.snapshot,3);audit(user,action==='approve'?'审核通过':'退回草稿',id,note);
      return {id,version:v.version,state};
    });
  }
  function trackJob(job,v,details={}) {
    change('发布',job.id,job.revision,{title:v.snapshot.title,account:job.account,content:job.content,contentVersion:job.content_version,
      owner:job.operator,state:jobStates[job.state],planned:job.planned,...details});
  }
  function schedule(user,id,version,planned) {
    if(typeof planned!=='string'||!(Date.parse(planned)>Date.now()))fail(400,'排期须晚于当前时间');
    planned=new Date(planned).toISOString();
    return tx(()=>{
      const v=draft(user,id,version,true),a=access(user,v.snapshot.account.id,true);
      if(v.state!=='approved' || v.current!==v.version)fail(409,'当前版本须先通过审核');
      getFact(v.snapshot.fact.id);
      if(a.state!=='ready' || !get('SELECT 1 FROM users WHERE id=? AND enabled=1',a.operator))fail(409,'请先确认账号可用并指定启用的发布操作员');
      const existed=get('SELECT * FROM publish_jobs WHERE content=? AND content_version=?',id,version);
      if(existed && existed.planned===planned && existed.state==='scheduled')return existed;
      if(existed)fail(409,'该审核版本已有发布任务，请在发布计划中处理');
      const s=v.snapshot;
      const fingerprint=hash(JSON.stringify([s.format,s.title,s.body,s.tags,s.media.map(item=>item.sha),s.media.find(item=>item.id===s.cover)?.sha]));
      if(get("SELECT 1 FROM publish_jobs WHERE account=? AND fingerprint=? AND state NOT IN ('cancelled','removed','rejected')",a.id,fingerprint))fail(409,'同账号已有相同内容的发布记录，请先核验原任务');
      const job={id:randomUUID(),content:id,content_version:version,account:a.id,fingerprint,planned,operator:a.operator,state:'scheduled',revision:1,updated:time()};
      run('INSERT INTO publish_jobs(id,content,content_version,account,fingerprint,planned,operator,state,revision,updated) VALUES(?,?,?,?,?,?,?,?,?,?)',...Object.values(job));
      trackJob(job,v);audit(user,'创建发布计划',job.id);
      return job;
    });
  }
  function getJob(user,id) {
    const job=get('SELECT * FROM publish_jobs WHERE id=?',id??'');
    if(!job)fail(404,'发布任务不存在');
    return {job,a:access(user,job.account),v:draft(user,job.content,job.content_version)};
  }
  function operator(user,job,a) {
    if(a.state!=='ready'||job.operator!==a.operator||!get('SELECT 1 FROM users WHERE id=? AND enabled=1',job.operator))fail(409,'原操作员授权或账号状态已变，请管理员检查');
    if(user.id!==job.operator)fail(403,'仅指定发布操作员可执行');
  }
  function release(user,id,planned) {
    admin(user);
    if(typeof planned!=='string'||!(Date.parse(planned)>Date.now()))fail(400,'请填写新的未来排期');
    return tx(()=>{
      const {job,a,v}=getJob(user,id);
      if(job.state!=='scheduled' || a.state!=='ready' || !get('SELECT 1 FROM users WHERE id=? AND enabled=1',a.operator))fail(409,'当前状态不可重新安排');
      job.operator=a.operator;job.planned=new Date(planned).toISOString();job.revision++;job.updated=time();
      run('UPDATE publish_jobs SET operator=?,planned=?,revision=?,updated=? WHERE id=?',job.operator,job.planned,job.revision,job.updated,id);
      trackJob(job,v);audit(user,'重新安排发布',id);
      return job;
    });
  }
  function pack(user,id) {
    const {job,a,v}=getJob(user,id);
    operator(user,job,a);getFact(v.snapshot.fact.id);
    if(conflicted(id)||conflicted(a.id)||conflicted(job.content)||job.state!=='working')fail(409,'请先开始人工发布，取得执行工位后再下载发布包');
    return {job,snapshot:v.snapshot};
  }
  function download(user,id) {
    const {job,snapshot}=pack(user,id);
    const files={};
    const manifest={job:job.id,contentVersion:job.content_version,planned:job.planned,...snapshot,media:[]};
    for(const [index,item] of snapshot.media.entries()) {
      const file=asset(user,item.id);
      if(file.sha!==item.sha||hash(file.data)!==item.sha)fail(409,'素材校验失败');
      const name=`${String(index+1).padStart(2,'0')}_${item.id===snapshot.cover?'封面':'素材'}.${extension[item.mime]}`;
      files[name]=file.data;manifest.media.push({...item,file:name});
    }
    files['标题正文.txt']=strToU8(`${snapshot.title}\n\n${snapshot.body}\n\n${snapshot.tags}\n`);
    files['发布说明.txt']=strToU8(`${platforms[snapshot.account.platform]} · ${snapshot.account.name}\n账号标识 ${snapshot.account.handle}\n内容版本 ${job.content_version}\n排期 ${job.planned}\n核对账号、素材顺序和文案后，由操作员手动提交。提交后回工作台登记回执与可见性。\n`);
    files['清单.json']=strToU8(JSON.stringify(manifest,null,2));
    return zipSync(files,{level:0});
  }
  function result(user,id,input) {
    return tx(()=>{
      const {job,a,v}=getJob(user,id), state=input.state;
      const allowed={scheduled:['working','cancelled'],working:['unknown','submitted','reviewing','public'],unknown:['ready','submitted','reviewing','public','rejected'],submitted:['reviewing','public','rejected','unknown'],reviewing:['public','rejected','unknown'],public:['removed']};
      const note=clean(input.note,700),url=publicationUrl(clean(input.url,500),a.platform),evidence=clean(input.evidence,80)||null;
      if(!(user.role==='admin'&&['cancelled','ready','unknown','submitted','reviewing','public','rejected','removed'].includes(state)))operator(user,job,a);
      const latest=get('SELECT * FROM publish_events WHERE job=? ORDER BY id DESC LIMIT 1',id);
      if(latest?.state===state && latest.note===note && latest.url===url && latest.evidence===evidence)return job;
      if(!allowed[job.state]?.includes(state))fail(409,'该状态转换不可用');
      if(state==='working') {
        if(conflicted(id)||conflicted(a.id)||conflicted(job.content))fail(409,'当前任务等待对账');
        getFact(v.snapshot.fact.id);
        if(get("SELECT 1 FROM publish_jobs WHERE state='working' AND id!=?",id))fail(409,'执行工位已有待提交任务');
        if(Date.parse(job.planned)>Date.now())fail(409,'排期未到，请到时再开始人工发布');
        if(Date.parse(job.planned)<Date.now()-86400000)fail(409,'排期已过，请先重新安排');
        job.attempts++;
      } else if(!note)fail(400,'请填写平台结果或核验依据');
      if(state==='public'&&!url)fail(400,'公开可见需记录作品链接和核验依据');
      if(evidence) {
        const proof=asset(user,evidence);
        if(proof.account!==a.id||!proof.mime.startsWith('image/'))fail(400,'请选择当前账号的截图作为证据');
      }
      if(state==='ready') {
        if(a.state!=='ready'||!get('SELECT 1 FROM users WHERE id=? AND enabled=1',a.operator))fail(409,'请先指定可用的账号与操作员');
        // 跨员工恢复必须由管理员核验未提交并保留原任务。
        if(job.operator!==a.operator) { admin(user); job.operator=a.operator; }
      }
      job.state=state==='ready'?'scheduled':state;job.revision++;job.updated=time();
      run('UPDATE publish_jobs SET state=?,operator=?,attempts=?,revision=?,updated=? WHERE id=?',job.state,job.operator,job.attempts,job.revision,job.updated,id);
      run('INSERT INTO publish_events(job,state,url,note,evidence,actor,at) VALUES(?,?,?,?,?,?,?)',id,state,url,note,evidence,user.id,job.updated);
      trackJob(job,v,{url,note,evidence});audit(user,'登记发布状态',id,jobStates[job.state]);
      return job;
    });
  }
  function home(user) {
    const accounts=all('SELECT * FROM social_accounts ORDER BY name').filter(a=>readable(user,a));
    const ids=new Set(accounts.map(a=>a.id));
    const facts=all('SELECT * FROM business_facts ORDER BY created DESC LIMIT 200');
    const assets=all(`SELECT ${selects} FROM content_assets ORDER BY created DESC`).filter(a=>ids.has(a.account));
    const localDrafts=new Map(all('SELECT * FROM platform_drafts').map(row=>[`${row.content}:${row.content_version}`,row]));
    const draftRuns=new Map(all('SELECT content,content_version,stage FROM xhs_draft_runs').map(row=>[`${row.content}:${row.content_version}`,row.stage]));
    const contents=all(`SELECT i.*,v.snapshot,v.state,v.note FROM content_items i JOIN content_versions v ON v.content=i.id AND v.version=i.version ORDER BY updated DESC`)
      .filter(i=>ids.has(i.account)).map(i=>({...i,snapshot:JSON.parse(i.snapshot),platformDraft:localDrafts.get(`${i.id}:${i.version}`)??null,xhsDraftStage:draftRuns.get(`${i.id}:${i.version}`)??null}));
    const jobs=all(`SELECT j.*,v.snapshot FROM publish_jobs j JOIN content_versions v ON v.content=j.content AND v.version=j.content_version ORDER BY j.planned DESC`)
      .filter(j=>ids.has(j.account)).map(({snapshot,...j})=>({...j,title:JSON.parse(snapshot).title,events:all('SELECT state,url,note,evidence,at FROM publish_events WHERE job=? ORDER BY id DESC',j.id)}));
    return {accounts,facts,assets,contents,jobs,aiJobs:all('SELECT id,actor,account,kind,state,amount,result,created FROM ai_content_jobs ORDER BY created DESC LIMIT 100')
      .filter(item=>ids.has(item.account)&&(item.actor===user.id||user.role==='admin'))};
  }
  function reserveAi(user,input,key,policy) {
    const a=access(user,input.account,true),f=getFact(input.fact);
    const request=clean(input.prompt,1200),kind=input.kind;
    if(!request||!['copy','image','edit'].includes(kind)||!(/^[\w-]{12,80}$/).test(key??''))fail(400,'请填写生成要求和有效操作编号');
    const amount=policy?.rates[kind];
    if(!Number.isSafeInteger(amount)||amount<0)fail(409,'该类 AI 生成尚未配置');
    const reference=kind==='edit'?asset(user,input.reference):null;
    if(reference&&(reference.account!==a.id||!reference.mime.startsWith('image/')||reference.bytes>8*1024*1024))fail(400,'请选择当前账号内不大于 8 MB 的图片');
    const signature=hash(JSON.stringify([a.id,f.id,request,kind,reference?.id]));
    return tx(()=>{
      const prior=get('SELECT * FROM ai_content_jobs WHERE id=?',key);
      if(prior) {
        if(prior.actor!==user.id||prior.signature!==signature)fail(409,'该操作编号已用于其他生成请求');
        return {job:prior};
      }
      if(get("SELECT 1 FROM ai_content_jobs WHERE actor=? AND signature=? AND state IN ('running','unknown')",user.id,signature))fail(409,'相同请求尚在执行或待核验');
      const today=day();
      const total=get("SELECT coalesce(sum(amount),0) AS total,count(*) FILTER(WHERE state='running') AS running FROM ai_content_jobs WHERE day=? AND state!='failed'",today);
      const personal=get("SELECT coalesce(sum(amount),0) AS total FROM ai_content_jobs WHERE day=? AND actor=? AND state!='failed'",today,user.id).total;
      if(total.running>=2||total.total+amount>policy.daily||personal+amount>policy.personal)fail(409,'生成任务已达并发上限或今日预算');
      const at=time();
      run("INSERT INTO ai_content_jobs VALUES(?,?,?,?,'running',?,?,?,NULL,?,?)",key,user.id,a.id,kind,amount,today,signature,at,at);
      audit(user,'提交 AI 生成',key);
      return {job:{id:key,state:'running',kind,amount},request:{kind,request,reference,fact:f,platform:platforms[a.platform]}};
    });
  }
  function finishAi(id,state,out) {
    run("UPDATE ai_content_jobs SET state=?,result=?,updated=? WHERE id=? AND state='running'",state,JSON.stringify(out),time(),id);
  }
  function resolveAi(user,id,wasCharged,note) {
    admin(user);
    note=clean(note,500);
    if(!note||typeof wasCharged!=='boolean')fail(400,'请记录核验结论和依据');
    return tx(()=>{
      if(!run("UPDATE ai_content_jobs SET state=?,result=?,updated=? WHERE id=? AND state='unknown'",wasCharged?'no_result':'failed',JSON.stringify({message:note}),time(),id).changes)fail(409,'该任务已处理或无需核验');
      audit(user,'核验 AI 任务',id,note);
      return {id};
    });
  }
  const recoverAi=()=>run("UPDATE ai_content_jobs SET state='unknown',result=?,updated=? WHERE state='running'",JSON.stringify({message:'服务重启，请核对生成使用记录'}),time());
  return {account,fact,getFact,access,upload,asset,save,submit,review,schedule,release,package:pack,download,result,recordPlatformDraft,
    draftForXhs,beginXhsDraft,finishXhsDraft,home,reserveAi,finishAi,resolveAi,recoverAi};
}
