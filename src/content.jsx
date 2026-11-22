import { useEffect, useState } from 'react';

const formatNames={image:'图文',video:'视频'};
const creatorBackends={xiaohongshu:'https://creator.xiaohongshu.com/',douyin:'https://creator.douyin.com/'};
const aiNames={copy:'文案',image:'生图',edit:'图片编辑',running:'生成中',done:'已完成',failed:'失败',unknown:'待核验',no_result:'无可用结果'};
const form=e=>{e.preventDefault();return Object.fromEntries(new FormData(e.currentTarget));};
const planned=value=>value?`${value.length===16?`${value}:00`:value}+08:00`:'';
const badge=value=><span className="pill">{value}</span>;
const member=(employees,id)=>employees.find(x=>x.id===id)?.name??(id?`员工 ${id}`:'未指定');
const asJson=value=>{try{return JSON.parse(value??'{}');}catch{return {};}};

function BackendLink({ account }) {
  const url=creatorBackends[account?.platform];
  return url?<a href={url} target="_blank" rel="noopener noreferrer" aria-label={`打开后台：${account.name}`}>打开后台 ↗</a>:null;
}

export function ContentPanel({ user,meta,revision,refresh,notify,useData,useAction,formatDate }) {
  const [tab,setTab]=useState('drafts');
  const data=useData('/content',revision,true);
  const action=useAction();
  const [draft,setDraft]=useState(null), [editAccount,setAccount]=useState(null), [editFact,setFact]=useState(null),[seed,setSeed]=useState(null);
  function send(path,value,success='',after,dedup=false) {
    action.submit(`/content${path}`,'POST',value,result=>{if(success)notify(success);after?.(result);refresh();},dedup);
  }
  return <><div className="content-nav" role="group" aria-label="内容运营模块">{Object.entries({drafts:'内容稿件',assets:'素材库',jobs:'发布计划',facts:'业务资料',accounts:user.role==='admin'?'账号管理':'我的账号',ai:'AI 创作'}).map(([id,label])=><button key={id} className={tab===id?'active':''} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    {(data.error||action.error) && <p role="alert" className="notice">{data.error||action.error}</p>}
    {!data.data ? <section className="panel"><p className="muted">正在读取内容运营…</p></section> : <>
      {tab==='drafts'&& <Drafts d={data.data} user={user} draft={draft} setDraft={value=>{setDraft(value);setSeed(null);}} seed={seed} send={send} formatDate={formatDate} busy={action.busy||meta.paused}/>}
      {tab==='assets'&& <Assets d={data.data} send={send} busy={action.busy||meta.paused}/>}
      {tab==='jobs'&& <Jobs d={data.data} user={user} send={send} formatDate={formatDate} busy={action.busy||meta.paused}/>}
      {tab==='facts'&& <Facts d={data.data} user={user} edit={editFact} setEdit={setFact} send={send} busy={action.busy||meta.paused}/>}
      {tab==='accounts'&& <Accounts d={data.data} admin={user.role==='admin'} edit={editAccount} setEdit={setAccount} send={send} busy={action.busy||meta.paused}/>}
      {tab==='ai'&& <><GeneratedDraft d={data.data} busy={meta.paused} onCompose={value=>{setDraft(null);setSeed(value);setTab('drafts');}}/><Ai d={data.data} user={user} send={send} refresh={refresh} busy={action.busy||meta.paused}/></>}
    </>}</>;
}

function Accounts({d,admin,edit,setEdit,send,busy}) {
  return <div className={`split ${admin?'content-split':''}`}><section className="panel"><div className="panel-heading"><h2>平台账号</h2>{admin&&<button onClick={()=>setEdit(null)}>新建账号</button>}</div>{d.accounts.length?<><div className="scroll"><table><thead><tr><th>平台 / 账号</th>{admin&&<th>发布操作员</th>}<th>状态</th><th>操作</th></tr></thead><tbody>{d.accounts.map(row=><tr key={row.id}><td><b>{row.name}</b><small>{d.platforms[row.platform]} · {row.handle}</small></td>{admin&&<td>{member(d.employees,row.operator)}</td>}<td>{badge(d.accountStates[row.state])}</td><td><div className="inline"><BackendLink account={row}/>{admin&&<button className="subtle" onClick={()=>setEdit(row)}>编辑账号</button>}</div></td></tr>)}</tbody></table></div><small>后台使用当前浏览器的登录账号，打开后请核对账号标识。</small></>:<p className="empty">{admin?'登记一个小红书或抖音账号后，即可上传素材。':'暂无分配给你的平台账号。'}</p>}</section>
    {admin&&<section className="panel"><div className="panel-heading"><h2>{edit?'编辑平台账号':'登记平台账号'}</h2></div><form key={edit?.id??'new'} className="form-stack" onSubmit={e=>{const v=form(e);send('/accounts',{...v,platform:edit?.platform??v.platform,handle:edit?.handle??v.handle,id:edit?.id},'账号配置已保存',()=>setEdit(null));}}>
      <label>平台<select name="platform" defaultValue={edit?.platform} disabled={Boolean(edit)}>{Object.entries(d.platforms).map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label>
      <label>账号名称<input name="name" defaultValue={edit?.name} required maxLength="80"/></label><label>平台账号标识<input name="handle" defaultValue={edit?.handle} required maxLength="100" readOnly={Boolean(edit)}/></label>
      <label>状态<select name="state" aria-label="状态" defaultValue={edit?.state??'pending'}>{Object.entries(d.accountStates).map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label>
      {Object.entries({editor:'内容编辑',operator:'发布操作员'}).map(([key,label])=><label key={key}>{label}<select name={key} aria-label={label} defaultValue={edit?.[key]??''}><option value="">未指定</option>{d.employees.filter(row=>row.enabled).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>)}
      <button className="primary" disabled={busy}>保存账号</button></form></section>}</div>;
}

function Facts({d,user,edit,setEdit,send,busy}) {
  return <div className={`split ${user.role==='admin'?'content-split':''}`}><section className="panel"><div className="panel-heading"><h2>可引用的业务资料</h2></div>{d.facts.length?d.facts.map(row=><article className="ops-row" key={row.id}><div><b>{row.name} · V{row.version}</b><p className="preserve muted">{row.details}</p><small>来源 {row.source} · {row.effective}{row.expires?` 至 ${row.expires}`:''}</small></div>{user.role==='admin'&& <button onClick={()=>setEdit(row)}>创建新版本</button>}</article>):<p className="empty">暂无业务资料。</p>}</section>
    {user.role==='admin'&& <section className="panel"><div className="panel-heading"><h2>{edit?'更新业务资料版本':'新增业务资料'}</h2>{edit&&<button onClick={()=>setEdit(null)}>取消</button>}</div><form key={edit?.id??'new'} className="form-stack" onSubmit={e=>send('/facts',{...form(e),id:edit?.id},'业务资料版本已保存',()=>setEdit(null))}><label>资料名称<input name="name" defaultValue={edit?.name} required maxLength="100" /></label><label>已确认业务事实<textarea name="details" defaultValue={edit?.details} required maxLength="3000" rows="5" placeholder="填写已确认的设备、租期、租金、押金及配送范围"/></label><label>资料来源<input name="source" defaultValue={edit?.source} required maxLength="300"/></label><div className="form-grid"><label>生效日期<input type="date" name="effective" defaultValue={edit?.effective}/></label><label>失效日期<input type="date" name="expires" defaultValue={edit?.expires}/></label></div><button className="primary" disabled={busy}>保存资料版本</button></form></section>}
  </div>;
}

function Assets({d,send,busy}) {
  const [selected,setSelected]=useState('');
  const id=selected||d.accounts[0]?.id;
  return <><section className="panel"><div className="panel-heading"><h2>上传素材</h2></div>{id?<form className="asset-upload" onSubmit={e=>{e.preventDefault();const node=e.currentTarget,body=new FormData();body.append('file',node.elements.file.files[0]);send(`/assets/${id}`,body,'素材已入库',()=>{node.reset();});}}><label>所属账号<select value={id} onChange={e=>setSelected(e.target.value)}>{d.accounts.map(a=><option value={a.id} key={a.id}>{a.name} · {d.platforms[a.platform]}</option>)}</select></label><label>图片或视频<input name="file" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,.mov" required/></label><button className="primary" disabled={busy}>上传素材</button></form>:<p className="empty">请先登记或分配平台账号。</p>}</section>
    <section className="panel"><div className="panel-heading"><h2>账号素材</h2><small>单个文件至多 40 MB</small></div><div className="asset-grid">{d.assets.filter(row=>row.account===id).map(row=><article key={row.id} className="asset-card">{row.mime.startsWith('image/')?<img alt={row.name} src={`/api/content/assets/${row.id}?view=1`} loading="lazy"/>:<div className="video-thumb">视频</div>}<div><b>{row.name}</b><small>{(row.bytes/1024).toFixed(1)} KB</small><a href={`/api/content/assets/${row.id}`}>下载原文件</a></div></article>)}</div>{!d.assets.some(row=>row.account===id)&&<p className="empty">当前账号还没有素材。</p>}</section></>;
}

function Drafts({d,user,draft,setDraft,seed,send,formatDate,busy}) {
  const item=d.contents.find(x=>x.id===draft);
  return <><section className="panel"><div className="panel-heading"><h2>稿件列表</h2><button onClick={()=>setDraft(null)}>新建稿件</button></div>{d.contents.length?<div className="scroll"><table><thead><tr><th>稿件</th><th>目标账号</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{d.contents.map(row=><tr key={row.id} className={draft===row.id?'chosen':''}><td><b>{row.snapshot.title}</b><small>{formatNames[row.snapshot.format]} · V{row.version}</small></td><td>{row.snapshot.account.name} · {d.platforms[row.snapshot.account.platform]}</td><td>{badge(d.contentStates[row.state])}</td><td>{formatDate(row.updated)}</td><td><button className="subtle" onClick={()=>setDraft(row.id)}>打开稿件</button></td></tr>)}</tbody></table></div>:<p className="empty">还没有内容稿件。</p>}</section>
    <div className="split content-split"><section className="panel"><div className="panel-heading"><h2>{item?'编辑新版本':'新建稿件'}</h2>{item&&badge(`当前 V${item.version}`)}</div>{d.accounts.length&&d.facts.length?<DraftForm key={item?`${item.id}-${item.version}`:seed?.copy??'new'} d={d} item={item} seed={seed} send={send} setDraft={setDraft} busy={busy}/>:<p className="empty">先登记平台账号、业务资料并上传素材。</p>}</section>
    {item&&<section className="panel"><div className="panel-heading"><h2>当前版本与审核</h2>{badge(d.contentStates[item.state])}</div><h3>{item.snapshot.title}</h3><p className="preserve">{item.snapshot.body}</p><p className="muted preserve">{item.snapshot.tags}</p><p className="muted">引用 {item.snapshot.fact.name} V{item.snapshot.fact.version} · {item.snapshot.media.length} 个素材</p>{item.note&&<p className="notice">{item.note}</p>}
      {item.state==='draft'&&<button className="primary" disabled={busy} onClick={()=>send(`/drafts/${item.id}/submit`,{version:item.version},'已提交审核')}>提交审核</button>}
      {item.state==='pending'&&user.role==='admin'&&<form className="form-stack control-form" onSubmit={e=>{const value=form(e);send(`/drafts/${item.id}/review`,{...value,version:item.version},'审核结果已保存');}}><label>审核决定<select name="action"><option value="approve">审核通过</option><option value="reject">退回修改</option></select></label><label>审核说明<input name="note" placeholder="退回时必填" /></label><button className="primary" disabled={busy}>保存审核</button></form>}
      {item.state==='approved'&&<form className="form-stack control-form" onSubmit={e=>send(`/drafts/${item.id}/schedule`,{version:item.version,planned:planned(form(e).planned)},'已加入发布计划')}><label>排期时间（北京时间）<input type="datetime-local" name="planned" required step="1"/></label><button className="primary" disabled={busy}>创建发布计划</button></form>}
      <DraftEvidence key={`${item.id}-${item.version}`} d={d} item={item} user={user} send={send} formatDate={formatDate} busy={busy}/></section>}</div></>;
}

function DraftEvidence({d,item,user,send,formatDate,busy}) {
  const proof=item.platformDraft, account=d.accounts.find(row=>row.id===item.account);
  const [feedback,setFeedback]=useState('');
  return <section className="control-form"><div className="panel-heading"><h3>平台草稿</h3><BackendLink account={account}/></div>
    {proof&&<div className="timeline"><b>已存平台草稿</b><small>{formatDate(proof.at)} · {proof.browser}</small><p>{proof.note}</p>{proof.evidence&&<a href={`/api/content/assets/${proof.evidence}`} target="_blank" rel="noreferrer">查看核验截图</a>}</div>}
    {d.xhsDraftEnabled&&account?.platform==='xiaohongshu'&&item.snapshot.format==='image'&&<>
      <div className="inline control-form"><button type="button" disabled={busy} onClick={()=>send('/xhs-browser',{},'',result=>setFeedback(result.message))}>打开专用 Chrome</button>
        {!proof&&!item.xhsDraftStage&&<button type="button" className="primary" disabled={busy} onClick={()=>send(`/drafts/${item.id}/xhs-prepare`,{version:item.version},'',result=>setFeedback(result.message))}>一键填写小红书</button>}</div>
      {feedback?<p className="notice" role="status">{feedback}</p>:!proof&&item.xhsDraftStage&&<p className="notice">{item.xhsDraftStage==='filled'?'已填写，请核对后暂存。':'曾开始填写，请先核对专用浏览器。'}</p>}
    </>}
    {(user.role==='admin'||account?.operator===user.id)&&<details key={`${item.id}-${item.version}`}><summary>登记平台草稿</summary><form key={proof?.revision??'new'} className="form-stack control-form" onSubmit={e=>send(`/drafts/${item.id}/platform-draft`,{...form(e),version:item.version},'平台草稿凭证已保存')}>
      <label>草稿所在浏览器<input name="browser" defaultValue={proof?.browser} placeholder="例如 ChatGPT 内置浏览器" required maxLength="100"/></label>
      <label>草稿核验依据<textarea name="note" rows="2" defaultValue={proof?.note} required maxLength="500"/></label>
      <label>草稿截图<select name="evidence" defaultValue={proof?.evidence??''}><option value="">未选择</option>{d.assets.filter(a=>a.account===item.account&&a.mime.startsWith('image/')).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <button type="submit" disabled={busy}>保存草稿凭证</button></form></details>}
  </section>;
}

function DraftForm({d,item,seed,send,setDraft,busy}) {
  const s=item?.snapshot;
  const [account,setAccount]=useState(item?.account??seed?.account??d.accounts[0].id),[media,setMedia]=useState(s?.media.map(x=>x.id)??(seed?.image?[seed.image]:[])),[cover,setCover]=useState(s?.cover??seed?.image??'');
  const available=d.assets.filter(a=>a.account===account);
  function shift(index,offset) {
    const copy=[...media];[copy[index],copy[index+offset]]=[copy[index+offset],copy[index]];setMedia(copy);
  }
  return <form className="form-stack" onSubmit={e=>send('/drafts',{...form(e),id:item?.id,version:item?.version,account,media,cover},'稿件版本已保存',result=>setDraft(result.id))}>
    <label>目标账号<select value={account} disabled={Boolean(item)} onChange={e=>{setAccount(e.target.value);setMedia([]);setCover('');}}>{d.accounts.map(a=><option key={a.id} value={a.id}>{a.name} · {d.platforms[a.platform]}</option>)}</select></label>
    <div className="form-grid"><label>内容形式<select name="format" defaultValue={s?.format??'image'}>{Object.entries(formatNames).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label>业务资料版本<select name="fact" defaultValue={s?.fact.id??seed?.fact??d.facts[0].id}>{d.facts.map(row=><option key={row.id} value={row.id}>{row.name} V{row.version}</option>)}</select></label></div>
    <label>稿件标题<input name="title" defaultValue={s?.title??seed?.title} required maxLength="120"/></label><label>稿件正文<textarea name="body" defaultValue={s?.body??seed?.body} required rows="5" maxLength="3500"/></label><label>话题<input name="tags" defaultValue={s?.tags??seed?.tags} maxLength="300"/></label>
    <fieldset className="asset-pick"><legend>选择素材</legend>{available.length?available.map(a=><label key={a.id}><input type="checkbox" checked={media.includes(a.id)} onChange={e=>{setMedia(e.target.checked?[...media,a.id]:media.filter(id=>id!==a.id));if(!e.target.checked&&cover===a.id)setCover('');}}/>{a.name}</label>):<p className="muted">去素材库上传当前账号的图片或视频。</p>}</fieldset>
    {media.length>0&&<div><small>发布顺序</small>{media.map((id,index)=><div className="fact-row" key={id}><span>{index+1}. {available.find(a=>a.id===id)?.name}</span><span className="inline"><button type="button" disabled={index===0} onClick={()=>shift(index,-1)}>上移</button><button type="button" disabled={index===media.length-1} onClick={()=>shift(index,1)}>下移</button></span></div>)}<label>封面<select value={cover} onChange={e=>setCover(e.target.value)}><option value="">未指定</option>{available.filter(a=>media.includes(a.id)&&a.mime.startsWith('image/')).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div>}
    <button className="primary" disabled={busy||!media.length}>保存草稿</button></form>;
}

const options={scheduled:['cancelled'],working:['unknown','submitted','reviewing','public'],unknown:['ready','submitted','reviewing','public','rejected'],submitted:['reviewing','public','rejected','unknown'],reviewing:['public','rejected','unknown'],public:['removed']};
function Jobs({d,user,send,formatDate,busy}) {
  const [selected,setSelected]=useState(''),[state,setState]=useState('');
  const item=d.jobs.find(x=>x.id===selected);
  const account=item&&d.accounts.find(a=>a.id===item.account);
  const isOperator=account?.state==='ready'&&item.operator===user.id&&account.operator===user.id;
  const allowed=(options[item?.state]??[]).filter(value=>value==='working'?isOperator:value==='cancelled'?user.role==='admin':user.role==='admin'||isOperator);
  const selectedState=allowed.includes(state)?state:allowed[0];
  return <div className={`split ${item?'content-split':''}`}><section className="panel"><div className="panel-heading"><h2>排期与发布待办</h2><small>北京时间</small></div>{d.jobs.length?<div className="scroll"><table><thead><tr><th>稿件</th><th>排期</th><th>状态</th><th>操作</th></tr></thead><tbody>{d.jobs.map(j=><tr key={j.id} className={selected===j.id?'chosen':''}><td><b>{j.title}</b><small>审核 V{j.content_version}</small></td><td>{formatDate(j.planned)}</td><td>{badge(d.jobStates[j.state])}</td><td><button className="subtle" onClick={()=>{setSelected(j.id);setState('');}}>查看任务</button></td></tr>)}</tbody></table></div>:<p className="empty">审核通过的稿件可加入排期。</p>}</section>
    {item&&<section className="panel"><div className="panel-heading"><h2>{item.title}</h2>{badge(d.jobStates[item.state])}</div><div className="inline"><p className="muted">{account.name} · {d.platforms[account.platform]} · 账号 {account.handle} · V{item.content_version}</p><BackendLink account={account}/></div>{item.operator!==account.operator&&<p className="notice">发布操作员已变更，请管理员重新安排。</p>}
      {isOperator&&item.state==='scheduled'&&<div className="control-form"><button className="primary" disabled={busy} onClick={()=>send(`/jobs/${item.id}/result`,{state:'working'},'已取得发布工位')}>开始人工发布</button><p className="muted">排期到时可开始。取得发布工位后即可下载发布包。</p></div>}
      {isOperator&&item.state==='working'&&!busy&&<p className="control-form"><a href={`/api/content/jobs/${item.id}/package`}>下载人工发布包</a></p>}
      {allowed.length>0&&<form className="form-stack control-form" key={item.id} onSubmit={e=>send(`/jobs/${item.id}/result`,{...form(e),state:selectedState},'发布状态已登记')}><label>更新发布状态<select aria-label="更新发布状态" value={selectedState} onChange={e=>setState(e.target.value)}>{allowed.map(key=><option value={key} key={key}>{key==='ready'?'确认未提交，恢复原任务':d.jobStates[key]}</option>)}</select></label>{selectedState!=='working'&&<><label>平台作品链接<input name="url" type="url" required={selectedState==='public'}/></label><label>平台回执或核验依据<textarea name="note" required rows="2"/></label><label>截图证据<select name="evidence"><option value="">未选择</option>{d.assets.filter(a=>a.account===item.account&&a.mime.startsWith('image/')).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label></>}<button className="primary" disabled={busy}>保存发布状态</button></form>}
      {user.role==='admin'&&item.state==='scheduled'&&<form className="form-stack control-form" onSubmit={e=>send(`/jobs/${item.id}/release`,{planned:planned(form(e).planned)},'已重新安排发布任务')}><label>重新安排时间<input name="planned" type="datetime-local" required/></label><button disabled={busy}>重新安排</button></form>}
      <h3>状态记录</h3>{item.events.length?item.events.map((event,index)=><div className="timeline" key={index}><b>{event.state==='ready'?'已确认未提交':d.jobStates[event.state]}</b><small>{formatDate(event.at)}</small>{event.note&&<p>{event.note}</p>}{event.url&&<a href={event.url} target="_blank" rel="noreferrer">查看平台作品</a>}{event.evidence&&<p><a href={`/api/content/assets/${event.evidence}`}>下载核验截图</a></p>}</div>):<p className="empty">暂无平台回执。</p>}</section>}</div>;
}

function GeneratedDraft({d,busy,onCompose}) {
  const [copyId,setCopy]=useState('');
  const results=d.aiJobs.filter(row=>row.state==='done').map(row=>({...row,value:asJson(row.result)}));
  const copies=results.filter(row=>row.kind==='copy'&&row.value.text);
  const copy=copies.find(row=>row.id===copyId)??copies[0];
  if(!copy)return null;
  const images=results.filter(row=>row.account===copy.account&&row.value.asset&&d.assets.some(a=>a.id===row.value.asset));
  function compose(e) {
    const {image}=form(e), lines=copy.value.text.trim().split(/\r?\n/).map(line=>line.trim());
    const first=(lines.shift()??'').replace(/^#{1,6}\s+/,'').replace(/\*\*/g,'').replace(/^标题\s*[：:]?\s*/,'');
    const last=(lines.at(-1)??'').replace(/\*\*/g,'');
    const tags=/^话题\s*[：:]|^(?:#[^\s#]+\s*)+$/.test(last)?last.replace(/^话题\s*[：:]\s*/,''):'';
    if(tags)lines.pop();
    const title=Array.from(first).length<=24?first:'';
    const body=(title?lines:[first,...lines]).join('\n').trim().replace(/^(?:\*\*)?正文(?:\*\*)?\s*[：:]?\s*/,'');
    onCompose({title,body,tags,image,copy:copy.id,account:copy.account,fact:copy.value.factId});
  }
  return <section className="panel"><div className="panel-heading"><h2>用生成结果写稿</h2></div><form className="asset-upload" onSubmit={compose}>
    <label>选用文案<select value={copy.id} onChange={e=>setCopy(e.target.value)}>{copies.map(row=><option key={row.id} value={row.id}>{d.accounts.find(a=>a.id===row.account)?.name} · {row.value.text.split('\n')[0].slice(0,32)}</option>)}</select></label>
    <label>同账号配图<select key={copy.id} name="image" defaultValue={images[0]?.value.asset??''}><option value="">稍后在稿件选择</option>{images.map(row=><option key={row.id} value={row.value.asset}>{d.assets.find(a=>a.id===row.value.asset)?.name} · {new Date(row.created).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</option>)}</select></label>
    <button className="primary" disabled={busy}>带入新稿件</button></form></section>;
}

function Ai({d,user,send,refresh,busy}) {
  const [account,setAccount]=useState(''),[kind,setKind]=useState(d.ai.kinds[0]??'copy');
  const id=account||d.accounts[0]?.id;
  const running=d.aiJobs.some(row=>row.state==='running');
  useEffect(()=>{if(!running)return;const timer=setTimeout(refresh,1450);return()=>clearTimeout(timer);},[running,d,refresh]);
  return <div className="split content-split"><section className="panel"><div className="panel-heading"><h2>生成任务</h2>{badge(({mock:'模拟模式',live:'已启用',personal:'ChatGPT 个人联调'})[d.ai.mode]??'待配置')}</div>{!d.ai.kinds.length?<p className="empty">请由管理员配置服务端模型与预算。</p>:!id||!d.facts.length?<p className="empty">先登记平台账号和可引用的业务资料。</p>:<form className="form-stack" onSubmit={e=>send('/ai',{...form(e),account:id,kind},'生成任务已提交',undefined,true)}><label>目标账号<select value={id} onChange={e=>setAccount(e.target.value)}>{d.accounts.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label><label>业务资料版本<select name="fact">{d.facts.map(row=><option value={row.id} key={row.id}>{row.name} V{row.version}</option>)}</select></label><label>生成类型<select value={kind} onChange={e=>setKind(e.target.value)}>{d.ai.kinds.map(id=><option key={id} value={id}>{aiNames[id]}</option>)}</select></label>{kind==='edit'&&<label>参考图片<select name="reference" required><option value="">请选择</option>{d.assets.filter(a=>a.account===id&&a.mime.startsWith('image/')).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}<label>制作要求<textarea name="prompt" rows="5" required maxLength="1200"/></label><button className="primary" disabled={busy}>提交生成</button></form>}</section>
    <section className="panel"><div className="panel-heading"><h2>任务记录</h2><button onClick={refresh}>刷新</button></div>{d.aiJobs.length?d.aiJobs.map(row=>{const value=asJson(row.result);return <article className="ops-row" key={row.id}><div><b>{aiNames[row.kind]} · {aiNames[row.state]}</b>{row.amount>0&&<small>预算预留 {row.amount} 美分</small>}{value.message&&<p>{value.message}</p>}{value.text&&<textarea rows="5" aria-label="生成文案" readOnly value={value.text}/>} {value.asset&&<p><a href={`/api/content/assets/${value.asset}`}>下载生成图片</a> · 已加入素材库</p>}{row.state==='unknown'&&user.role==='admin'&&<form className="form-stack" onSubmit={e=>{const v=form(e);send(`/ai/${row.id}/resolve`,{wasCharged:v.charged==='yes',note:v.note},'生成结果已核验');}}><label>费用核验<select name="charged"><option value="yes">已发生费用</option><option value="no">确认未发生费用</option></select></label><label>核验依据<input name="note" required/></label><button disabled={busy}>保存核验</button></form>}</div></article>;}):<p className="empty">暂无生成任务。</p>}</section></div>;
}
