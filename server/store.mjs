import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { initContent } from './content.mjs';

export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export const outcomes = { missed:'未接通', no_need:'接通无需求', interested:'接通有需求', invalid:'号码无效', refused:'拒绝联系' };
export const stages = ['需求确认','待报价','已报价','跟进中','成交','流失'];
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

export function openStore(path, { demo = false, feishuTest = false } = {}) {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), until INTEGER);
    CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL, summary TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY, company TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
      person TEXT, city TEXT, industry TEXT, notes TEXT, owner INTEGER REFERENCES users(id),
      state TEXT NOT NULL, dnc INTEGER NOT NULL DEFAULT 0, next TEXT, next_note TEXT, created TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, sync TEXT NOT NULL, conflict INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS leads_state_owner ON leads(state, owner, created);
    CREATE TABLE IF NOT EXISTS sources(lead_id TEXT REFERENCES leads(id), source TEXT, source_date TEXT, basis TEXT,
      PRIMARY KEY(lead_id, source, source_date, basis));
    CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, lead_id TEXT REFERENCES leads(id),
      employee INTEGER REFERENCES users(id), at TEXT, recorded TEXT, result TEXT, notes TEXT);
    CREATE INDEX IF NOT EXISTS contacts_lead ON contacts(lead_id, at);
    CREATE TABLE IF NOT EXISTS opportunities(id TEXT PRIMARY KEY, lead_id TEXT REFERENCES leads(id),
      stage TEXT, details TEXT, created TEXT, updated TEXT, version INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS opportunities_lead ON opportunities(lead_id);
    CREATE TABLE IF NOT EXISTS operations(user_id INTEGER, key TEXT, fingerprint TEXT, result TEXT,
      PRIMARY KEY(user_id, key));
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT, actor INTEGER, action TEXT, target TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, lead_id TEXT, kind TEXT, entity TEXT,
      version INTEGER, snapshot TEXT, expected TEXT, state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0,
      due INTEGER DEFAULT 0, remote_id TEXT, error TEXT, UNIQUE(entity, version));
    CREATE INDEX IF NOT EXISTS outbox_entity ON outbox(entity, id);
    CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, due, id);`);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const mode = demo ? 'demo' : feishuTest ? 'feishu-test' : 'production';
  run('INSERT OR IGNORE INTO settings VALUES (?,?)', 'mode', mode);
  if (get("SELECT value FROM settings WHERE key='mode'").value !== mode) {
    db.close();
    fail(409, '演示、飞书联调与正式数据库不能混用');
  }
  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const administrator = user => { if (user?.role !== 'admin') fail(403, '需要管理员权限'); };
  const audit = (user, action, target, detail = '') => run('INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)', now(), user?.id ?? null, action, String(target), detail);
  const users = () => all('SELECT id,name,username,role,enabled FROM users ORDER BY id');
  function createUser({ name, username, password, role }, actor) {
    name = text(name, 60);
    username = text(username, 40).toLowerCase();
    if (!name || !/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username) || typeof password !== 'string' || password.length < 12 || password.length > 120 || !['admin','sales'].includes(role)) fail(400, '请检查姓名、账号和密码。密码需 12–120 个字符。');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return tx(() => {
      if (actor) administrator(actor);
      else if (users().length && !demo) fail(403, '初始管理员已存在');
      if (get('SELECT id FROM users WHERE username=?', username)) fail(409, '账号已存在');
      const id = run('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)', name, username, `${salt}:${hash}`, role).lastInsertRowid;
      audit(actor, '创建员工', id);
      return get('SELECT id,name,username,role,enabled FROM users WHERE id=?', id);
    });
  }
  if (demo && !users().length) {
    createUser({ name:'演示管理员', username:'admin', password:'demo-admin-2026', role:'admin' });
    createUser({ name:'销售小林', username:'lin', password:'demo-sales-2026', role:'sales' });
    createUser({ name:'销售小周', username:'zhou', password:'demo-sales-2026', role:'sales' });
  }
  function login(username, password) {
    if (typeof password !== 'string' || password.length > 120) return null;
    const user = get('SELECT * FROM users WHERE username=? AND enabled=1', text(username, 40).toLowerCase());
    const [salt, hash] = user ? user.password.split(':') : ['dummy-salt', '0'.repeat(128)];
    if (!timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash,'hex')) || !user) return null;
    const token = randomBytes(32).toString('hex');
    run('DELETE FROM sessions WHERE until<=?', Date.now());
    run('INSERT INTO sessions VALUES(?,?,?)', digest(token), user.id, Date.now() + 8*3600000);
    audit(user, '登录', user.id);
    return token;
  }
  function session(token) {
    if (!/^[a-f0-9]{64}$/.test(token ?? '')) return null;
    return get('SELECT u.id,u.name,u.username,u.role,u.enabled FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.until>? AND u.enabled=1', digest(token), Date.now());
  }
  function logout(token) { if (token) run('DELETE FROM sessions WHERE hash=?', digest(token)); }
  function setEnabled(actor, id, enabled) {
    administrator(actor);
    if (typeof enabled !== 'boolean' || actor.id === id) fail(400, '不能修改当前登录账号的启用状态');
    return tx(() => {
      if (!run('UPDATE users SET enabled=? WHERE id=?', +enabled, id).changes) fail(404, '员工不存在');
      if (!enabled) run('DELETE FROM sessions WHERE user_id=?', id);
      audit(actor, enabled ? '启用员工' : '禁用员工', id);
    });
  }

  const leadByPhone = phone => get('SELECT * FROM leads WHERE phone=?', phone);
  const firstConfirmed = alias => `(EXISTS(SELECT 1 FROM outbox q WHERE q.entity=${alias}.id AND q.version=1 AND q.state='confirmed') OR ${alias}.sync='local')`;
  const sources = id => all('SELECT source,source_date,basis FROM sources WHERE lead_id=? ORDER BY source,source_date,basis', id);
  function queue(kind, entity, leadId, version, value) {
    if (demo) return;
    const previous = get('SELECT snapshot FROM outbox WHERE entity=? ORDER BY id DESC LIMIT 1', entity);
    run('INSERT INTO outbox(lead_id,kind,entity,version,snapshot,expected) VALUES(?,?,?,?,?,?)', leadId, kind, entity, version, JSON.stringify(value), previous?.snapshot ?? null);
    run("UPDATE leads SET sync='pending' WHERE id=?", leadId);
  }
  function queueLead(id) {
    const { sync, conflict, ...lead } = get('SELECT * FROM leads WHERE id=?', id);
    queue('线索', id, id, lead.version, { ...lead, sources:sources(id) });
  }
  function updateLead(id, values, snapshot = true) {
    const keys = Object.keys(values);
    run(`UPDATE leads SET ${keys.map(k => `${k}=?`).join(',')}, version=version+1 WHERE id=?`, ...Object.values(values), id);
    if (snapshot) queueLead(id);
  }
  function commitImport(user, preview) {
    administrator(user);
    return tx(() => {
      const prior = get('SELECT id, name, at, summary FROM batches WHERE hash=?', preview.hash);
      if (prior) return { ...prior, summary:JSON.parse(prior.summary), repeated:true };
      const summary = { new:0, updated:0, duplicate:0, dnc:0, review:0 };
      const results = [];
      for (const row of preview.rows) {
        const { line, error, data } = row;
        let status = 'review';
        let reason = error;
        if (!error) {
          const lead = leadByPhone(data.phone);
          if (lead?.dnc) { status = 'dnc'; reason = '号码已标记勿扰'; }
          else if (lead?.conflict || (lead && lead.company !== data.company)) reason = '同一号码的归属需人工复核';
          else {
            const id = lead?.id ?? randomUUID();
            if (!lead) run(`INSERT INTO leads(id, company, phone, person, city, industry, notes, state, created, sync)
              VALUES(?,?,?,?,?,?,?,'pool',?,?)`, id, data.company, data.phone, data.person, data.city, data.industry, data.notes, now(), demo ? 'local' : 'pending');
            const added = run('INSERT OR IGNORE INTO sources VALUES(?,?,?,?)', id, data.source, data.source_date, data.basis).changes;
            status = !lead ? 'new' : added ? 'updated' : 'duplicate';
            if (!lead) queueLead(id);
            else if (added) { run('UPDATE leads SET version=version+1 WHERE id=?', id); queueLead(id); }
          }
        }
        summary[status]++;
        results.push({ line, status, reason: reason ?? '' });
      }
      const id = randomUUID(), at = now();
      run('INSERT INTO batches VALUES(?,?,?,?,?,?)', id, preview.name, preview.hash, at, JSON.stringify(summary), JSON.stringify(results));
      audit(user, '导入线索', id, JSON.stringify(summary));
      return { id, name:preview.name, at, summary };
    });
  }
  const batches = () => all('SELECT id,name,at,summary FROM batches ORDER BY at DESC LIMIT 100').map(row => ({ ...row, summary:JSON.parse(row.summary) }));
  function batch(id) {
    const row = get('SELECT result FROM batches WHERE id=?', id);
    if (!row) fail(404, '批次不存在');
    return JSON.parse(row.result);
  }
  function leadFor(user, id) {
    const lead = get('SELECT l.*,u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner WHERE l.id=?', id);
    if (!lead || (user.role !== 'admin' && user.id !== lead.owner)) fail(404, '线索不存在或无权查看');
    return lead;
  }
  function list(user, { view = 'mine', query = '', page = 1 } = {}) {
    const conditions = [], params = [];
    if (user.role !== 'admin' || view === 'mine') { conditions.push('l.owner=?'); params.push(user.id); }
    if (view === 'followup') { conditions.push('l.next IS NOT NULL AND l.dnc=0 AND l.conflict=0'); }
    if (view === 'pool') { administrator(user); conditions.push(`l.state='pool' AND l.dnc=0 AND l.conflict=0 AND ${firstConfirmed('l')}`); }
    if (view === 'dnc') conditions.push('l.dnc=1');
    if (query) { conditions.push('(instr(l.company,?)>0 OR instr(l.phone,?)>0)'); params.push(query, query); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return {
      total:get(`SELECT count(*) AS count FROM leads l ${where}`, ...params).count,
      rows:all(`SELECT l.*,u.name AS owner_name,(SELECT result FROM contacts WHERE lead_id=l.id ORDER BY at DESC,rowid DESC LIMIT 1) AS recent
        FROM leads l LEFT JOIN users u ON u.id=l.owner ${where} ORDER BY ${view === 'followup' ? 'l.next ASC' : 'l.created DESC'},l.id LIMIT 25 OFFSET ?`, ...params, (page-1)*25)
    };
  }
  function detail(user, id) {
    const lead = leadFor(user, id);
    return { lead, sources:sources(id), logs:all(`SELECT c.*,u.name AS employee_name FROM contacts c JOIN users u ON u.id=c.employee
      WHERE c.lead_id=? ORDER BY c.at DESC,c.rowid DESC`, id), opportunities:all('SELECT * FROM opportunities WHERE lead_id=? ORDER BY updated DESC', id).map(o => ({ ...o, details:JSON.parse(o.details) })) };
  }
  function operate(user, key, payload, work) {
    if (!/^[\w-]{8,80}$/.test(key ?? '')) fail(400, '缺少有效操作编号');
    const fingerprint = digest(JSON.stringify(payload));
    return tx(() => {
      const prior = get('SELECT fingerprint,result FROM operations WHERE user_id=? AND key=?', user.id, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, '该操作编号已用于其他请求');
        return JSON.parse(prior.result);
      }
      const result = work();
      run('INSERT INTO operations VALUES(?,?,?,?)', user.id, key, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  function claim(user, quantity, key) {
    if (user.role !== 'sales') fail(403, '请使用销售账号领取');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) fail(400, '单次领取 1–10 条');
    return operate(user, key, ['claim',quantity], () => {
      const rows = all(`SELECT id FROM leads WHERE state='pool' AND dnc=0 AND conflict=0 AND ${firstConfirmed('leads')} ORDER BY created,id LIMIT ?`, quantity);
      for (const { id } of rows) { updateLead(id, { owner:user.id, state:'claimed' }); audit(user, '领取线索', id); }
      return rows;
    });
  }
  function contact(user, id, input, key) {
    const { result } = input;
    if (!Object.hasOwn(outcomes, result ?? '')) fail(400, '请选择联系结果');
    const notes = text(input.notes, 2000), nextNote = text(input.nextNote);
    const next = ['refused','invalid'].includes(result) || !input.next ? null : text(input.next, 50);
    return operate(user, key, ['contact',id,result,notes,next,nextNote], () => {
      const lead = leadFor(user, id);
      if ((!lead.owner || lead.state !== 'claimed' || lead.dnc || lead.conflict) && result !== 'refused') fail(409, '当前线索不可继续登记营销联系');
      if (next && !(Date.parse(next) > Date.now())) fail(400, '回访时间须晚于现在');
      if (!next && !nextNote && !['refused','invalid'].includes(result)) fail(400, '请选择回访时间或填写下一步');
      const at = now(), logId = randomUUID();
      run('INSERT INTO contacts VALUES(?,?,?,?,?,?,?)', logId, id, user.id, at, at, result, notes);
      updateLead(id, {
        dnc:result === 'refused' ? 1 : lead.dnc,
        state:['refused','invalid'].includes(result) ? 'closed' : lead.state,
        next:next ? new Date(next).toISOString() : null,
        next_note:['refused','invalid'].includes(result) ? '' : nextNote
      }, !lead.conflict);
      queue('联系', logId, id, 1, { id:logId, lead_id:id, employee:user.id, at, result, notes });
      audit(user, result === 'refused' ? '标记勿扰' : '登记联系', id, outcomes[result]);
      return { id:logId };
    });
  }
  function assign(user, id, owner, reason, key) {
    administrator(user);
    reason = text(reason);
    if (!reason) fail(400, '请填写转交或回收原因');
    return operate(user, key, ['assign',id,owner,reason], () => {
      const lead = leadFor(user, id);
      if (lead.dnc || lead.conflict || lead.state === 'closed') fail(409, '该线索不可分配');
      if (owner !== null && !get("SELECT id FROM users WHERE id=? AND role='sales' AND enabled=1", owner)) fail(400, '请选择有效销售员工');
      if (owner === null && (get('SELECT id FROM contacts WHERE lead_id=?', id) || get('SELECT id FROM opportunities WHERE lead_id=?', id))) fail(409, '已有联系或商机，只能指定接收人');
      if (!get("SELECT id FROM outbox WHERE entity=? AND state='confirmed'", id) && !demo) fail(409, '请等待首次飞书入库确认');
      updateLead(id, { owner, state:owner === null ? 'pool' : 'claimed' });
      audit(user, owner === null ? '回收线索' : '转交线索', id, reason);
      return { id };
    });
  }
  function opportunity(user, leadId, input, key) {
    const stage = input.stage;
    const fields = Object.fromEntries(['model','term','city','start','amount','deposit','validUntil','proof','nextStep'].map(k => [k,text(input[k])]));
    const quantity = Number(input.quantity);
    if (!stages.includes(stage) || !Number.isInteger(quantity) || quantity < 1 || !fields.model || !fields.term || !fields.city) fail(400, '请填写阶段、机型需求、数量、租期和交付地点');
    if (['已报价','成交'].includes(stage) && (!fields.amount || !(Number(fields.amount)>0))) fail(400, '请填写有效金额');
    if (stage === '成交' && !fields.proof) fail(400, '请填写成交依据');
    if (stage === '已报价' && !fields.validUntil) fail(400, '请填写报价有效期');
    const fieldsJson = JSON.stringify({ ...fields, quantity });
    return operate(user, key, ['deal',leadId,input.id ?? null,stage,fieldsJson], () => {
      const lead = leadFor(user, leadId);
      if (!lead.owner || lead.dnc || lead.conflict || lead.state !== 'claimed') fail(409, '当前线索不可编辑商机');
      const prior = input.id ? get('SELECT * FROM opportunities WHERE id=? AND lead_id=?', input.id, leadId) : null;
      if (input.id && !prior) fail(404, '商机不存在');
      const id = prior?.id ?? randomUUID(), at = now(), version = (prior?.version ?? 0) + 1;
      run(`INSERT INTO opportunities VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stage=excluded.stage,
        details=excluded.details,updated=excluded.updated,version=excluded.version`, id, leadId, stage, fieldsJson, prior?.created ?? at, at, version);
      queue('商机', id, leadId, version, { id, lead_id:leadId, stage, details:JSON.parse(fieldsJson), created:prior?.created ?? at, updated:at });
      audit(user, '保存商机', id, JSON.stringify({ stage, details:JSON.parse(fieldsJson), version }));
      return { id };
    });
  }
  function dashboard(user) {
    const today = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    const start = new Date(`${today}T00:00:00+08:00`).toISOString();
    const end = new Date(Date.parse(start)+86400000).toISOString();
    const own = user.role === 'admin' ? [] : [user.id];
    const sqlOwner = own.length ? ' AND owner=?' : '';
    const pool = get(`SELECT count(*) AS n FROM leads WHERE state='pool' AND dnc=0 AND conflict=0 AND ${firstConfirmed('leads')}`).n;
    const waiting = get(`SELECT count(*) AS n FROM leads WHERE state='claimed' AND dnc=0 AND NOT EXISTS(SELECT 1 FROM contacts WHERE lead_id=leads.id)${sqlOwner}`, ...own).n;
    const due = get(`SELECT count(*) AS n FROM leads WHERE next<? AND dnc=0 AND conflict=0${sqlOwner}`, end, ...own).n;
    const trend = get(`SELECT count(*) AS attempts, count(DISTINCT lead_id) AS customers,
      count(*) FILTER (WHERE result IN ('no_need','interested','refused')) AS connected FROM contacts WHERE at>=? AND at<?${own.length ? ' AND employee=?' : ''}`, start, end, ...own);
    const staff = user.role==='admin' ? all(`SELECT u.id,u.name,u.enabled,count(c.id) AS attempts,count(DISTINCT c.lead_id) AS customers,
      count(c.id) FILTER(WHERE c.result IN ('no_need','interested','refused')) AS connected FROM users u
      LEFT JOIN contacts c ON c.employee=u.id AND c.at>=? AND c.at<?
      WHERE u.role='sales' OR c.id IS NOT NULL GROUP BY u.id ORDER BY u.enabled DESC,u.name`,start,end) : [];
    const deals = all(`SELECT o.stage,count(*) AS count FROM opportunities o JOIN leads l ON l.id=o.lead_id WHERE 1=1${sqlOwner} GROUP BY o.stage`, ...own);
    const sync = user.role === 'admin' ? all('SELECT state,count(*) AS count FROM outbox GROUP BY state') : [];
    return { pool, waiting, due, ...trend, deals, staff, sync, demo };
  }

  const outbox = () => all("SELECT id,kind,entity,state,attempts,error FROM outbox WHERE state!='confirmed' ORDER BY id LIMIT 100");
  const nextSync = () => get(`SELECT q.* FROM outbox q LEFT JOIN leads l ON l.id=q.lead_id
    WHERE q.state IN ('pending','unknown') AND q.due<=? AND COALESCE(l.conflict,0)=0
    AND NOT EXISTS(SELECT 1 FROM outbox p WHERE p.lead_id=q.lead_id AND p.id<q.id AND p.state!='confirmed') ORDER BY q.id LIMIT 1`, Date.now());
  function syncConfirmed(item, remoteId) {
    tx(() => {
      run("UPDATE outbox SET state='confirmed',remote_id=?,error=NULL WHERE id=?", remoteId, item.id);
      if (!get("SELECT id FROM outbox WHERE lead_id=? AND state!='confirmed'", item.lead_id)) {
        run("UPDATE leads SET sync='confirmed' WHERE id=?", item.lead_id);
      }
    });
  }
  function syncError(item, { state, message }, delay = 1000) {
    tx(() => {
      const attempts = item.attempts+1;
      const actual = attempts >= 5 && state === 'unknown' ? 'failed' : state;
      run('UPDATE outbox SET state=?,attempts=?,error=?,due=? WHERE id=?', actual, attempts, text(message), Date.now()+delay, item.id);
      run('UPDATE leads SET sync=?,conflict=MAX(conflict,?) WHERE id=?', actual, +(actual === 'conflict'), item.lead_id);
    });
  }
  function retry(user, id) {
    administrator(user);
    tx(() => {
      if (!run("UPDATE outbox SET state='unknown',attempts=0,due=0,error=NULL WHERE id=? AND state IN ('failed','unknown')", id).changes) fail(409, '该同步任务无法重试');
      audit(user, '重试同步', id);
    });
  }
  function confirmedForAudit(after, limit) {
    return all(`SELECT q.* FROM outbox q LEFT JOIN leads l ON l.id=q.lead_id WHERE q.id>? AND q.state='confirmed' AND COALESCE(l.conflict,0)=0
      AND q.id=(SELECT max(p.id) FROM outbox p WHERE p.entity=q.entity) ORDER BY q.id LIMIT ?`, after, limit);
  }
  function checkConflict(item, message) {
    tx(() => {
      run("UPDATE outbox SET state='conflict',error=? WHERE id=?", message, item.id);
      run("UPDATE leads SET sync='conflict',conflict=1 WHERE id=?", item.lead_id);
      audit(null,'发现同步冲突',item.entity,message);
    });
  }
  function remoteDnc(item) {
    if (item.kind!=='线索') return;
    tx(()=>{
      const lead=get('SELECT dnc FROM leads WHERE id=?',item.lead_id);
      if (lead?.dnc===0) {
        updateLead(item.lead_id,{ dnc:1,state:'closed',next:null,next_note:'' },false);
        audit(null,'收到飞书勿扰信号',item.lead_id);
      }
    });
  }
  const confirmedSnapshots = () => all(`SELECT q.* FROM outbox q WHERE q.state='confirmed' AND q.id=(SELECT max(p.id) FROM outbox p WHERE p.entity=q.entity AND p.state='confirmed')`);
  const requiresRecovery = () => Boolean(get("SELECT key FROM settings WHERE key='restore_pending'"));
  const clearRecovery = () => run("DELETE FROM settings WHERE key='restore_pending'");
  function bindFeishu({base,table}) {
    if (!base||!table) fail(400,'缺少正式飞书表标识');
    const target=JSON.stringify([base,table]);
    run("INSERT OR IGNORE INTO settings VALUES('feishu_target',?)",target);
    if(get("SELECT value FROM settings WHERE key='feishu_target'").value!==target)fail(409,'正式库已绑定其他飞书表，请先核对，避免数据写错位置');
  }
  const conflictItem = id => get("SELECT * FROM outbox WHERE id=? AND state='conflict'", id);
  function resolveConflict(user, item) {
    administrator(user);
    tx(() => {
      const previousAuditConflict = item.error?.startsWith('对账：');
      if (!run("UPDATE outbox SET state=?, attempts=0, due=0, error=NULL WHERE id=? AND state='conflict'", previousAuditConflict?'confirmed':'pending', item.id).changes) fail(409,'冲突已处理，请刷新');
      if (!get("SELECT id FROM outbox WHERE lead_id=? AND state='conflict'",item.lead_id)) {
        const waiting = get("SELECT id FROM outbox WHERE lead_id=? AND state!='confirmed'",item.lead_id);
        run('UPDATE leads SET conflict=0,sync=? WHERE id=?',waiting?'pending':'confirmed',item.lead_id);
        const lead = get('SELECT version FROM leads WHERE id=?',item.lead_id);
        const latest = get("SELECT max(version) AS v FROM outbox WHERE entity=? AND kind='线索'",item.lead_id);
        if (lead && lead.version > latest.v) queueLead(item.lead_id);
      }
      audit(user,'确认远端已恢复',item.entity);
    });
  }
  const auditLog = () => all('SELECT a.*,u.name AS actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 100');
  const content = initContent(db,{tx,audit,queue});
  return { users, createUser, login, session, logout, setEnabled, leadByPhone, sources, commitImport, batches, batch, list, detail,content,
    claim, contact, assign, opportunity, dashboard, outbox, nextSync, syncConfirmed, syncError, retry, auditLog,
    confirmedForAudit, checkConflict, remoteDnc, conflictItem, resolveConflict, confirmedSnapshots, requiresRecovery, clearRecovery, bindFeishu,
    backup: target => backup(db, target), close: () => db.close(), demo };
}
