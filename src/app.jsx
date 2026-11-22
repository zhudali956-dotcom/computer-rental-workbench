import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { ContentPanel } from './content.jsx';

const names = { new:'新增',updated:'补充来源',duplicate:'重复',dnc:'勿扰',review:'待复核',pool:'待领取',claimed:'已领取',closed:'已关闭',local:'本地演示',confirmed:'已同步',pending:'待同步',failed:'同步失败',conflict:'数据冲突',unknown:'待核验' };
const fieldLabels = { company:'企业名称',phone:'联系电话',source:'来源',source_date:'来源日期',basis:'联系依据',person:'联系人',city:'城市',industry:'行业',notes:'备注' };
const formatDate = time => time ? new Intl.DateTimeFormat('zh-CN',{ timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short' }).format(new Date(time)) : '—';
const beijingDate = value => value ? `${value}:00+08:00` : '';
const formValues = event => Object.fromEntries(new FormData(event.currentTarget));
const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte=>byte.toString(16).padStart(2,'0')).join('');
const dateHeadline = () => new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'}).format(new Date());

async function api(path, method='GET', data, key) {
  const body = data instanceof FormData ? data : data === undefined ? undefined : JSON.stringify(data);
  const response = await fetch(`/api${path}`,{ method, body, headers:{ ...(body && !(body instanceof FormData) ? {'content-type':'application/json'} : {}), ...(key ? {'idempotency-key':key} : {}) } });
  if (!response.ok) throw Object.assign(new Error((await response.json().catch(()=>({}))).error ?? '服务未响应'),{ status:response.status });
  return response.json();
}

function useAction() {
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const lock = useRef(false);
  async function submit(path, method, value, success, deduplicate=false) {
    if (lock.current) return;
    lock.current=true; setBusy(true); setError('');
    let storageKey;
    try {
      let operation;
      if (deduplicate) {
        const fingerprint=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([path,value])));
        storageKey=`rental-operation-${Array.from(new Uint8Array(fingerprint),part=>part.toString(16).padStart(2,'0')).join('')}`;
        operation=sessionStorage.getItem(storageKey) || id();
        sessionStorage.setItem(storageKey,operation);
      }
      const result = await api(path,method,value,operation);
      if (storageKey) sessionStorage.removeItem(storageKey);
      success?.(result);
    } catch (e) { setError(e.message); if (storageKey && e.status && e.status<500) sessionStorage.removeItem(storageKey); }
    finally { lock.current=false; setBusy(false); }
  }
  return { busy,error,submit };
}

function useData(path, revision=0, retain=false) {
  const [state,set] = useState({data:null,error:''});
  useEffect(()=>{
    let active=true;
    if(!retain)set({data:null,error:''});
    api(path).then(data=>{if(active)set({data,error:''});}).catch(error=>{if(active)set({data:null,error:error.message});});
    return ()=>{active=false;};
  },[path,revision,retain]);
  return state;
}

function Notice({ text, type='warning' }) { return text ? <p className={`notice ${type}`} role={type==='warning'?'alert':'status'}>{text}</p> : null; }
function Empty({ children }) { return <p className="empty">{children}</p>; }
function Pill({ status }) { return <span className={`pill ${status}`}>{names[status] ?? status}</span>; }

function Login({ meta,onLogin }) {
  const action=useAction();
  return <main className="login-page"><section className="login-intro"><div className="brand-icon">租</div><h1>电脑租赁<br/>运营工作台</h1><p>从线索领取到客户回访，集中处理日常销售工作。</p></section>
    <section className="login-card"><h2>登录工作台</h2><form onSubmit={event=>{event.preventDefault();action.submit('/login','POST',formValues(event),onLogin);}}>
      <label>账号<input name="username" autoComplete="username" required /></label><label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
      <Notice text={action.error}/><button className="primary" disabled={action.busy}>{action.busy?'正在登录…':'登录'}</button>
    </form>{meta.demo && <div className="demo-accounts"><strong>本机演示账号</strong><p>管理员 <code>admin</code> · <code>demo-admin-2026</code></p><p>销售 <code>lin</code> / <code>zhou</code> · <code>demo-sales-2026</code></p></div>}</section></main>;
}

const nav = { overview:['◫','工作概览'],customers:['▤','客户线索'],followup:['◷','回访待办'],content:['◇','内容运营'],imports:['⇧','导入记录'],employees:['◉','员工管理'],audit:['≡','同步与审计'] };

function Overview({ user,revision,navigate }) {
  const {data,error}=useData('/dashboard',revision);
  if(error)return <Notice text={error}/>;
  if(!data)return <Empty>正在读取工作概览…</Empty>;
  const tiles=[['公共池',data.pool,'当前可领取线索'],['未联系客户',data.waiting,'已领取、尚无联系记录'],['到期回访',data.due,'今日到期及逾期'],['今日联系',data.attempts,`已联系 ${data.customers} 个客户`]];
  return <><div className="metrics">{tiles.map(([label,value,detail])=><section className="metric" key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></section>)}</div>
    <div className="split overview-grid"><section className="panel"><div className="panel-heading"><h2>今日联系</h2><span className="muted">北京时间</span></div><div className="fact-row"><span>联系记录</span><b>{data.attempts} 次</b></div><div className="fact-row"><span>接通</span><b>{data.connected} 次</b></div><div className="fact-row"><span>接通率</span><b>{data.attempts ? `${(100*data.connected/data.attempts).toFixed(1)}%` : '—'}</b></div><button onClick={()=>navigate('followup')}>查看回访待办 →</button></section>
    <section className="panel"><div className="panel-heading"><h2>商机进度</h2></div>{data.deals.length ? data.deals.map(row=><div className="fact-row" key={row.stage}><span>{row.stage}</span><b>{row.count}</b></div>) : <Empty>登记有需求的客户后，可新建商机。</Empty>}<button onClick={()=>navigate('customers')}>查看客户线索 →</button></section></div>
    {user.role==='admin' && <><section className="panel"><div className="panel-heading"><h2>员工联系统计</h2><a href="/api/admin/today.csv">导出今日 CSV</a></div>{data.staff.length?<div className="scroll"><table><thead><tr><th>员工</th><th>登记次数</th><th>客户数</th><th>接通次数</th><th>接通率</th></tr></thead><tbody>{data.staff.map(row=><tr key={row.id}><td>{row.name}{!row.enabled && <small>已禁用</small>}</td><td>{row.attempts}</td><td>{row.customers}</td><td>{row.connected}</td><td>{row.attempts?`${(100*row.connected/row.attempts).toFixed(1)}%`:'—'}</td></tr>)}</tbody></table></div>:<Empty>暂无销售员工</Empty>}</section><section className="panel"><div className="panel-heading"><h2>飞书同步</h2><button onClick={()=>navigate('audit')}>查看同步与审计</button></div>{data.demo ? <p className="muted">演示数据保存在本机。</p> : data.sync.length ? <div className="summary">{data.sync.map(row=><span key={row.state}>{names[row.state]} <b>{row.count}</b></span>)}</div> : <Empty>暂无同步任务</Empty>}</section></>}</>;
}

function Customers({ user,meta,tab,revision,refresh,notify }) {
  const admin=user.role==='admin';
  const [view,setView]=useState(admin?'all':'mine'), [query,setQuery]=useState(''), [search,setSearch]=useState(''), [page,setPage]=useState(1), [selected,setSelected]=useState('');
  const activeView=tab==='followup'?'followup':view;
  const {data,error}=useData(`/leads?view=${activeView}&page=${page}&q=${encodeURIComponent(search)}`,revision);
  const stats=useData('/dashboard',revision).data;
  const claim=useAction();
  const pages=Math.max(1,Math.ceil((data?.total??0)/25));
  return <><div className="toolbar"><form className="search" onSubmit={e=>{e.preventDefault();setPage(1);setSearch(query);}}><input aria-label="搜索客户" placeholder="搜索企业或电话号码" value={query} onChange={e=>setQuery(e.target.value)}/><button>搜索</button></form>
    {admin && tab!=='followup' && <select aria-label="线索筛选" value={view} onChange={e=>{setPage(1);setView(e.target.value);setSelected('');}}><option value="all">全部线索</option><option value="pool">公共池</option><option value="dnc">勿扰名单</option></select>}
    {!admin && tab==='customers' && <div className="claim"><span>可领取 <b>{stats?.pool??'—'}</b> 条</span>{[1,5].map(quantity=><button className={quantity===1?'primary':''} key={quantity} disabled={claim.busy || !stats?.pool || meta.paused} onClick={()=>claim.submit('/leads/claim','POST',{quantity},rows=>{notify(`本次领取 ${rows.length} 条`);setSelected(rows[0]?.id??'');setPage(1);refresh();},true)}>领取 {quantity} 条</button>)}</div>}</div>
    <Notice text={error||claim.error}/><div className={`split ${selected?'with-detail':''}`}><section className="panel table-panel"><div className="panel-heading"><h2>{tab==='followup'?'回访列表':admin?'客户列表':'我的客户'}</h2><span className="muted">{data?.total??'—'} 条</span></div>
    {data?.rows.length ? <div className="scroll"><table><thead><tr><th>企业 / 联系人</th><th>状态</th><th>下次回访</th><th>操作</th></tr></thead><tbody>{data.rows.map(row=><tr key={row.id} className={selected===row.id?'chosen':''}><td><b>{row.company}</b><small>{[row.person,row.city,row.owner_name].filter(Boolean).join(' · ')||'—'}</small></td><td><Pill status={row.dnc?'dnc':row.conflict?'conflict':row.state}/>{row.recent && <small>{meta.outcomes[row.recent]}</small>}</td><td>{formatDate(row.next)}</td><td><button className="subtle" onClick={()=>setSelected(row.id)}>查看</button></td></tr>)}</tbody></table></div> : <Empty>{data ? tab==='followup'?'当前没有回访待办。':'没有符合条件的客户。' : '正在读取客户列表…'}</Empty>}
    {pages>1 && <div className="pager"><button disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</button><span>{page} / {pages}</span><button disabled={page>=pages} onClick={()=>setPage(page+1)}>下一页</button></div>}</section>
    {selected && <CustomerDetail key={selected} id={selected} user={user} meta={meta} revision={revision} onClose={()=>setSelected('')} refresh={refresh} notify={notify}/>}</div></>;
}

function CustomerDetail({id:leadId,user,meta,revision,onClose,refresh,notify}) {
  const {data,error}=useData(`/leads/${leadId}`,revision);
  const [tab,setTab]=useState('info'), [deal,setDeal]=useState(undefined);
  const action=useAction();
  const employees=useData(user.role==='admin'?'/admin/employees':'/me',revision).data;
  const lead=data?.lead;
  const canEdit=lead && lead.state==='claimed' && !lead.dnc && !lead.conflict && !meta.paused;
  function save(event,suffix,message,transform=value=>value) {
    event.preventDefault();
    action.submit(`/leads/${leadId}/${suffix}`,'POST',transform(formValues(event)),()=>{setTab('info');setDeal(undefined);notify(message);refresh();},true);
  }
  return <aside className="panel details"><div className="panel-heading"><h2>{lead?.company??'客户详情'}</h2><button aria-label="关闭详情" onClick={onClose}>关闭</button></div><Notice text={error||action.error}/>{lead && <>
    <div className="summary"><Pill status={lead.dnc?'dnc':lead.state}/>{!meta.demo && <Pill status={lead.sync}/>}<span className="muted">{lead.owner_name??'未分配'}</span></div>
    {lead.dnc ? <Notice text="客户已明确拒绝联系，回访已关闭。"/> : <div className="phone">{lead.phone}</div>}
    <p className="muted">{[lead.person,lead.city,lead.industry].filter(Boolean).join(' · ')}</p>
    <div className="tabs"><button className={tab==='info'?'active':''} onClick={()=>setTab('info')}>跟进记录</button>{canEdit && <><button className={tab==='contact'?'active':''} onClick={()=>setTab('contact')}>登记联系</button><button className={tab==='deal'?'active':''} onClick={()=>{setDeal(undefined);setTab('deal');}}>新建商机</button></>}{user.role==='admin' && !meta.paused && !lead.dnc && !lead.conflict && lead.state!=='closed' && <button className={tab==='assign'?'active':''} onClick={()=>setTab('assign')}>分配</button>}</div>
    {tab==='info' && <><div className="fact-row"><span>下次回访</span><b>{formatDate(lead.next)}</b></div>{lead.next_note && <p className="muted">{lead.next_note}</p>}{lead.notes && <p className="muted">{lead.notes}</p>}
      <h3>线索来源</h3>{data.sources.map((row,index)=><p className="muted" key={index}>{[row.source,row.source_date,row.basis].filter(Boolean).join(' · ')}</p>)}
      <h3>联系历史</h3>{data.logs.length ? data.logs.map(log=><div className="timeline" key={log.id}><b>{meta.outcomes[log.result]}</b><small>{formatDate(log.at)} · {log.employee_name}</small>{log.notes && <p>{log.notes}</p>}</div>) : <Empty>暂无联系记录</Empty>}
      <h3>商机</h3>{data.opportunities.length ? data.opportunities.map(item=><div className="timeline" key={item.id}><b>{item.details.model} · {item.details.quantity} 台</b><small>{item.stage} · {item.details.term} · {item.details.city}</small>{canEdit && <button className="subtle" onClick={()=>{setDeal(item);setTab('deal');}}>编辑商机</button>}</div>) : <Empty>暂无商机</Empty>}</>}
    {tab==='contact' && canEdit && <form className="form-stack" onSubmit={e=>save(e,'contact','联系结果已保存',v=>({...v,next:beijingDate(v.next)}))}><label>联系结果<select name="result">{Object.entries(meta.outcomes).map(([key,value])=><option value={key} key={key}>{value}</option>)}</select></label><label>联系备注<textarea name="notes" rows="3" maxLength="2000"/></label><label>下次回访时间（北京时间）<input name="next" type="datetime-local"/></label><label>下一步<input name="nextNote" placeholder="例如 确认短租数量" maxLength="500"/></label><p className="muted">选择“拒绝联系”会同时关闭回访并标记勿扰。</p><button className="primary" disabled={action.busy}>保存联系</button></form>}
    {tab==='deal' && canEdit && <form key={deal?.id??'new'} className="form-stack" onSubmit={e=>save(e,'opportunity','商机已保存',v=>({...v,id:deal?.id}))}><label>商机阶段<select name="stage" defaultValue={deal?.stage}>{meta.stages.map(stage=><option key={stage}>{stage}</option>)}</select></label><div className="form-grid">{[['model','机型需求','text',true],['quantity','数量','number',true],['term','租期','text',true],['city','交付地点','text',true],['start','预计起租','date'],['amount','金额（元）','number'],['deposit','押金（元）','number'],['validUntil','报价有效期','date'],['proof','成交依据','text'],['nextStep','下一步','text']].map(([key,label,type,required])=><label key={key}>{label}<input name={key} type={type} defaultValue={deal?.details[key]} required={required} min={key==='quantity'?1:undefined} step={['amount','deposit'].includes(key)?'0.01':undefined}/></label>)}</div><button className="primary" disabled={action.busy}>保存商机</button></form>}
    {tab==='assign' && <form className="form-stack" onSubmit={e=>save(e,'assign','归属已更新',v=>({owner:v.owner?Number(v.owner):null,reason:v.reason}))}><label>归属<select name="owner" defaultValue={lead.owner??''}><option value="">回收到公共池</option>{Array.isArray(employees) && employees.filter(row=>row.enabled && row.role==='sales').map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>原因<input name="reason" required /></label><button className="primary" disabled={action.busy}>保存分配</button></form>}
  </>}</aside>;
}

function Imports({ meta,revision,refresh,notify }) {
  const [file,setFile]=useState(null), [sampleName,setSampleName]=useState(''), [preview,setPreview]=useState(null), [mapping,setMapping]=useState({});
  const [source,setSource]=useState(''), [basis,setBasis]=useState(''), [dirty,setDirty]=useState(false);
  const action=useAction(), batches=useData('/admin/batches',revision);
  async function loadExample() {
    const response=await fetch('/api/admin/sample.csv');
    if (!response.ok) {notify('样表下载失败');return;}
    setFile(new File([await response.blob()],'示例线索.csv',{type:'text/csv'}));setSampleName('示例线索.csv');setPreview(null);setMapping({});
  }
  function requestPreview(e) {
    e.preventDefault();
    const body=new FormData(); body.append('file',file); body.append('mapping',JSON.stringify(mapping)); body.append('source',source); body.append('basis',basis);
    action.submit('/admin/import/preview','POST',body,data=>{setPreview(data);setMapping(data.mapping);setDirty(false);});
  }
  return <><section className="panel"><div className="panel-heading"><h2>上传并预览</h2><div className="inline"><a href="/api/admin/sample.csv">下载样表</a>{(meta.demo||meta.feishuTest) && <button onClick={loadExample}>使用演示样表</button>}</div></div>
    <form className="import-form" onSubmit={requestPreview}><label>Excel / CSV 文件<input type="file" accept=".csv,.xlsx" onChange={e=>{setFile(e.target.files[0]);setSampleName('');setPreview(null);setMapping({});}}/>{sampleName && <small>已选 {sampleName}</small>}</label><div className="form-grid"><label>默认来源<input value={source} onChange={e=>{setSource(e.target.value);setDirty(true);}} placeholder="仅补充空白来源" /></label><label>默认联系依据<input value={basis} onChange={e=>{setBasis(e.target.value);setDirty(true);}} placeholder="仅补充空白依据"/></label></div>
    {preview && <details open={!preview.ready}><summary>列映射</summary><div className="form-grid mapping">{Object.entries(fieldLabels).map(([key,label])=><label key={key}>{label}<select value={mapping[key]??-1} onChange={e=>{setMapping({...mapping,[key]:Number(e.target.value)});setDirty(true);}}><option value={-1}>不映射</option>{preview.headers.map((header,index)=><option key={index} value={index}>{index+1}. {header||'空白列'}</option>)}</select></label>)}</div></details>}
    <div className="inline"><button className="primary" disabled={!file||action.busy||meta.paused}>{preview?'刷新预览':'预览文件'}</button>{preview && <button type="button" disabled={action.busy||!preview.ready||!preview.total||dirty||meta.paused} onClick={()=>action.submit('/admin/import/commit','POST',{key:preview.key},result=>{notify(result.repeated?'重复文件，已返回原导入批次':`导入完成，新增 ${result.summary.new} 条`);setPreview(null);setMapping({});refresh();})}>确认导入</button>}</div></form>
    <Notice text={action.error}/>{preview && <div className="preview"><div className="summary"><b>{preview.total} 行</b>{Object.entries(preview.counts).map(([status,count])=><span key={status}>{names[status]} {count}</span>)}</div>{dirty && <Notice text="映射或默认值已更改，请刷新预览。"/>}<div className="scroll"><table><thead><tr><th>行号</th><th>企业</th><th>号码</th><th>结果</th><th>说明</th></tr></thead><tbody>{preview.rows.map(row=><tr key={row.line}><td>{row.line}</td><td>{row.data.company||'—'}</td><td>{row.data.phone||'—'}</td><td><Pill status={row.status}/></td><td>{row.reason||'—'}</td></tr>)}</tbody></table></div>{preview.total>40 && <small>预览前 40 行。导入结果可下载全量行报告。</small>}</div>}</section>
    <section className="panel"><div className="panel-heading"><h2>导入批次</h2></div><Notice text={batches.error}/>{batches.data?.length ? <div className="scroll"><table><thead><tr><th>文件 / 时间</th><th>新增</th><th>补充</th><th>重复</th><th>勿扰</th><th>待复核</th><th>行报告</th></tr></thead><tbody>{batches.data.map(batch=><tr key={batch.id}><td><b>{batch.name}</b><small>{formatDate(batch.at)}</small></td>{['new','updated','duplicate','dnc','review'].map(key=><td key={key}>{batch.summary[key]}</td>)}<td><a href={`/api/admin/batches/${batch.id}.csv`}>下载 CSV</a></td></tr>)}</tbody></table></div> : <Empty>暂无导入批次</Empty>}</section></>;
}

function Employees({ user,meta,revision,refresh,notify }) {
  const {data,error}=useData('/admin/employees',revision), action=useAction();
  return <><section className="panel"><div className="panel-heading"><h2>团队成员</h2></div><Notice text={error||action.error}/><table><thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{data?.map(row=><tr key={row.id}><td>{row.name}</td><td>{row.username}</td><td>{row.role==='admin'?'管理员':'销售'}</td><td>{row.enabled?'启用':'禁用'}</td><td><button disabled={row.id===user.id||action.busy||meta.paused} onClick={()=>action.submit(`/admin/employees/${row.id}`,'PATCH',{enabled:!row.enabled},()=>{notify('员工状态已更新');refresh();})}>{row.enabled?'禁用':'启用'}</button></td></tr>)}</tbody></table></section>
    <section className="panel"><div className="panel-heading"><h2>创建员工</h2></div><form className="form-stack" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;action.submit('/admin/employees','POST',formValues(e),()=>{form.reset();notify('员工已创建');refresh();});}}><div className="form-grid"><label>姓名<input name="name" required /></label><label>登录账号<input name="username" minLength="3" required /></label><label>初始密码<input name="password" type="password" minLength="12" autoComplete="new-password" required /></label><label>角色<select name="role"><option value="sales">销售</option><option value="admin">管理员</option></select></label></div><button className="primary" disabled={action.busy||meta.paused}>创建员工</button></form></section></>;
}

function Audit({ meta,revision,refresh,notify }) {
  const sync=useData('/admin/sync',revision), audit=useData('/admin/audit',revision), action=useAction();
  return <><section className="panel"><div className="panel-heading"><h2>未确认同步</h2><button onClick={refresh}>刷新</button></div><Notice text={action.error||sync.error||sync.data?.health}/>{sync.data?.items.length ? <div className="scroll"><table><thead><tr><th>对象</th><th>状态</th><th>尝试</th><th>说明</th><th>操作</th></tr></thead><tbody>{sync.data.items.map(row=><tr key={row.id}><td>{row.kind}<small>{row.entity}</small></td><td><Pill status={row.state}/></td><td>{row.attempts}</td><td>{row.error||'—'}</td><td>{['failed','unknown','conflict'].includes(row.state) && <button disabled={action.busy||meta.paused} onClick={()=>action.submit(`/admin/sync/${row.id}/${row.state==='conflict'?'verify':'retry'}`,'POST',{},()=>{notify(row.state==='conflict'?'冲突核验通过':'已安排查询并重试');refresh();})}>{row.state==='conflict'?'核验修复':'重试'}</button>}</td></tr>)}</tbody></table></div> : <Empty>{meta.demo?'本机演示未连接飞书。':'没有未确认的同步任务。'}</Empty>}</section>
    <section className="panel"><div className="panel-heading"><h2>最近操作</h2></div><Notice text={audit.error}/>{audit.data?.length ? <div className="scroll"><table><thead><tr><th>发生时间</th><th>操作员</th><th>动作</th><th>对象</th></tr></thead><tbody>{audit.data.map(row=><tr key={row.id}><td>{formatDate(row.at)}</td><td>{row.actor_name??'系统'}</td><td>{row.action}</td><td>{row.target}</td></tr>)}</tbody></table></div> : <Empty>暂无审计记录</Empty>}</section></>;
}

function App() {
  const [meta,setMeta]=useState(null), [user,setUser]=useState(null), [boot,setBoot]=useState('正在连接工作台…'), [tab,navigate]=useState('overview');
  const [revision,setRevision]=useState(0), [message,notify]=useState('');
  const refresh=()=>setRevision(value=>value+1);
  useEffect(()=>{Promise.all([api('/meta'),api('/me').catch(e=>{if(e.status===401)return null;throw e;})]).then(([metadata,employee])=>{setMeta(metadata);setUser(employee);setBoot('');}).catch(e=>setBoot(e.message));},[]);
  useEffect(()=>{if(!message)return;const timeout=setTimeout(()=>notify(''),4500);return()=>clearTimeout(timeout);},[message]);
  if(boot)return <main className="boot">{boot}</main>;
  if(!user)return <Login meta={meta} onLogin={employee=>{setUser(employee);navigate('overview');}}/>;
  const visible=user.role==='admin'?Object.keys(nav):['overview','customers','followup','content'];
  const props={user,meta,revision,refresh,notify};
  return <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-icon">租</div><div><strong>电脑租赁</strong><small>运营工作台</small></div></div><nav aria-label="工作台导航">{visible.map(key=><button className={key===tab?'current':''} key={key} onClick={()=>navigate(key)} aria-current={key===tab?'page':undefined}><span aria-hidden="true">{nav[key][0]}</span>{nav[key][1]}</button>)}</nav><div className="sidebar-foot"><span>{user.name}</span><button onClick={async()=>{try{await api('/logout','POST',{});setUser(null);notify('');}catch(e){notify(e.message);}}}>退出</button></div></aside>
    <main className="main"><header className="page-header"><div><div className="eyebrow">{dateHeadline()}</div><h1>{nav[tab][1]}</h1></div><span className="mode">{meta.demo?'本机演示':meta.paused?'恢复检查':meta.feishuTest?'飞书联调':'办公室工作台'}</span></header><Notice text={meta.paused?'恢复检查期间仅可查看数据。':meta.feishuTest?'此工作台连接飞书联调表，请使用测试数据。':null}/>{message && <div className="toast" role="status">{message}</div>}
    {tab==='overview' && <Overview {...props} navigate={navigate}/>} {(tab==='customers'||tab==='followup') && <Customers key={tab} {...props} tab={tab}/>} {tab==='content' && <ContentPanel {...props} useData={useData} useAction={useAction} formatDate={formatDate}/>} {tab==='imports' && <Imports {...props}/>} {tab==='employees' && <Employees {...props}/>} {tab==='audit' && <Audit {...props}/>}</main></div>;
}

createRoot(document.getElementById('root')).render(<App/>);
