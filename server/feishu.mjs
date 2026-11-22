import { outcomes } from './store.mjs';

export const fieldNames = ['业务ID','类型','版本','企业名称','联系电话','归属','状态','下次回访','快照'];
function fieldsFor(item, snapshot) {
  const data = JSON.parse(snapshot);
  const sales=item.kind==='线索'||item.kind==='联系'||item.kind==='商机';
  return { 业务ID:item.entity, 类型:item.kind, 版本:String(data.version ?? item.version), 企业名称:data.company ?? data.title ?? data.name ?? '',
    联系电话:data.phone ?? '', 归属:String(data.owner ?? data.employee ?? data.operator ?? ''),
    状态:data.dnc ? '勿扰' : data.stage ?? outcomes[data.result] ?? (sales ? ({pool:'待领取',claimed:'已领取',closed:'已关闭'}[data.state] ?? '') : data.state??''),
    下次回访:data.next ?? data.planned ?? '', 快照:snapshot };
}
const valueOf = value => Array.isArray(value) ? value.map(part => part.text ?? '').join('') : String(value ?? '');
const equalFields = (a, b) => fieldNames.every(key => valueOf(a?.[key]) === valueOf(b[key]));
const errorWith = (state, message) => Object.assign(new Error(message), { state });
function readDnc(store,item,records) {
  if (item.kind!=='线索') return;
  const flagged=records.some(record=>{
    if (valueOf(record.fields?.状态)==='勿扰') return true;
    try { return Boolean(JSON.parse(valueOf(record.fields?.快照)).dnc); } catch {return false;}
  });
  if (flagged) store.remoteDnc(item);
}

export function feishuClient(config, { fetcher = fetch, origin = 'https://open.feishu.cn' } = {}) {
  const base = `/open-apis/bitable/v1/apps/${encodeURIComponent(config.base)}/tables/${encodeURIComponent(config.table)}`;
  let token, expiry = 0;
  async function call(path, method, body, authenticate = true) {
    if (authenticate && Date.now() >= expiry) {
      const auth = await call('/open-apis/auth/v3/tenant_access_token/internal', 'POST', { app_id:config.id, app_secret:config.secret }, false);
      if (!auth.tenant_access_token) throw errorWith('failed', '飞书未返回应用凭据');
      token = auth.tenant_access_token;
      expiry = Date.now()+Math.max(0, (auth.expire-120)*1000);
    }
    const response = await fetcher(`${origin}${path}`, { method, redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{ 'content-type':'application/json', ...(authenticate ? {authorization:`Bearer ${token}`} : {}) },
      body:body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      if (response.status === 401 || [99991663,99991664,99991668].includes(data.code)) expiry=0;
      const state = response.status>=500 || response.status===429 || [1254290,1254291,1255001,1255040,1254607,99991663,99991664,99991668].includes(data.code) ? 'unknown' : 'failed';
      throw errorWith(state, `飞书请求未确认，HTTP ${response.status}，错误码 ${Number(data.code) || 0}`);
    }
    return data;
  }
  return {
    async checkFields() {
      const { data } = await call(`${base}/fields?page_size=100`, 'GET');
      const fields = new Map(data.items.map(field => [field.field_name,field.type]));
      const missing = fieldNames.filter(name => fields.get(name)!==1);
      if (missing.length) throw new Error(`飞书需要以下文本字段：${missing.join('、')}`);
    },
    async find(entity) {
      const { data } = await call(`${base}/records/search?page_size=10`, 'POST', { field_names:fieldNames,
        filter:{conjunction:'and', conditions:[{field_name:'业务ID',operator:'is',value:[entity]}]} });
      if (!Array.isArray(data?.items) && data?.total !== 0) throw errorWith('unknown','飞书查询结果不完整');
      return data.items ?? [];
    },
    async *list() {
      let cursor='';
      do {
        const suffix=cursor ? `&page_token=${encodeURIComponent(cursor)}` : '';
        const { data }=await call(`${base}/records/search?page_size=100${suffix}`,'POST',{field_names:fieldNames});
        if (!Array.isArray(data?.items) && data?.total!==0) throw errorWith('unknown','飞书查询结果不完整');
        yield* data.items ?? [];
        if (data.has_more && (!data.page_token || data.page_token===cursor)) throw errorWith('unknown','飞书分页结果不完整');
        cursor=data.has_more?data.page_token:'';
      } while(cursor);
    },
    async create(item, fields) {
      // 业务 ID 本身是 UUIDv4，重试使用同一个飞书 client_token。
      const { data } = await call(`${base}/records?client_token=${encodeURIComponent(item.entity)}`, 'POST', { fields });
      return data.record;
    },
    async update(id, fields) {
      const { data } = await call(`${base}/records/${encodeURIComponent(id)}`, 'PUT', { fields });
      return data.record;
    }
  };
}

export async function syncOne(store, remote, { paused = false } = {}) {
  if (paused) return false;
  const item = store.nextSync();
  if (!item) return false;
  try {
    const fields = fieldsFor(item, item.snapshot);
    const records = await remote.find(item.entity);
    readDnc(store,item,records);
    if (records.length > 1) throw errorWith('conflict', '飞书存在重复业务 ID，请核对同一业务记录');
    const current = records[0];
    if (current && equalFields(current.fields, fields)) { store.syncConfirmed(item, current.record_id); return true; }
    if (item.expected && !current) throw errorWith('conflict', '飞书记录缺失，请核对删除或移动情况');
    if (current && !item.expected) throw errorWith('conflict', '飞书已有同 ID 记录，字段与本次写入不一致');
    if (current && item.expected) {
      const last = fieldsFor({ ...item, version:item.version-1 }, item.expected);
      if (!equalFields(current.fields, last)) throw errorWith('conflict', '飞书记录已偏离上次确认值，请核对受控字段');
    }
    const saved = current ? await remote.update(current.record_id, fields) : await remote.create(item, fields);
    if (!saved?.record_id || !equalFields(saved.fields, fields)) throw errorWith('unknown','飞书写入回执不完整，需重新查询');
    store.syncConfirmed(item, saved.record_id);
  } catch (error) {
    store.syncError(item, { state:error.state ?? 'unknown', message:error.state ? error.message : '飞书请求结果未知，稍后核对' }, Math.min(60000, 1000*2**item.attempts));
  }
  return true;
}

export async function auditRemote(store, remote, after) {
  const [item] = store.confirmedForAudit(after,1);
  if (!item) return 0;
  const records = await remote.find(item.entity);
  readDnc(store,item,records);
  if (records.length!==1 || records[0].record_id!==item.remote_id || !equalFields(records[0].fields,fieldsFor(item,item.snapshot))) {
    store.checkConflict(item,'对账：飞书记录缺失、重复或受控字段发生变化');
  }
  return item.id;
}

export async function verifyConflict(store, remote, user, id) {
  const item = store.conflictItem(id);
  if (!item) return false;
  const records = await remote.find(item.entity);
  const auditConflict = item.error?.startsWith('对账：');
  const expected = auditConflict ? item.snapshot : item.expected;
  if (expected) {
    if (records.length!==1 || !equalFields(records[0].fields,fieldsFor({...item,version:item.version-(auditConflict?0:1)},expected))) return false;
    if (auditConflict && records[0].record_id!==item.remote_id) return false;
  } else if (records.length) return false;
  store.resolveConflict(user,item);
  return true;
}

export async function checkRestored(store,remote) {
  const expected=new Map(store.confirmedSnapshots().map(item=>[item.entity,item]));
  let extra=0, different=0;
  for await (const record of remote.list()) {
    const entity=valueOf(record.fields?.业务ID);
    if (!entity) continue;
    const item=expected.get(entity);
    if (!item) {extra++;continue;}
    expected.delete(entity);
    if (record.record_id!==item.remote_id || !equalFields(record.fields,fieldsFor(item,item.snapshot))) different++;
  }
  return { extra,different,missing:expected.size };
}
