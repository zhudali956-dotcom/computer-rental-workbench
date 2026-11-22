import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, outcomes, stages } from './store.mjs';
import { previewImport, columns } from './import.mjs';
import { verifyConflict } from './feishu.mjs';
import { contentRoutes } from './content-http.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upload = multer({ storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1,fields:3,fieldSize:8192} });
const csvField = value => {
  const raw = String(value ?? '');
  const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"','""')}"`;
};

export function createApp(store, { secure = false, paused = false, remote = null, syncHealth = {}, feishuTest = false, ai = null, xhsDraft = null } = {}) {
  const app = express();
  const cookieName = secure ? '__Host-rental_production' : feishuTest ? 'rental_feishu_test' : 'rental_session';
  const cookiePattern = new RegExp(`(?:^|;\\s*)${cookieName}=([a-f0-9]{64})(?:;|$)`);
  const sessionCookie = req => req.headers.cookie?.match(cookiePattern)?.[1];
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    res.set({ 'x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY',
      'content-security-policy':"default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    next();
  });
  app.use('/api',(req,res,next) => {
    res.set('cache-control','no-store');
    if (req.method !== 'GET' && (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== `${secure ? 'https' : 'http'}://${req.get('host')}`))) fail(403, '请求来源不受信任');
    next();
  });
  app.use('/api',express.json({limit:'100kb'}));
  const cookie = { httpOnly:true, sameSite:'strict', secure, path:secure?'/':'/api' };
  const loginAttempts = new Map(), previews = new Map();
  app.get('/api/meta', (_,res) => res.json({ demo:store.demo, feishuTest, paused, outcomes, stages, columns }));
  app.post('/api/login', (req,res) => {
    const ip = req.ip;
    const at = Date.now();
    for (const [key,value] of loginAttempts) if (value.until<=at) loginAttempts.delete(key);
    const attempt = loginAttempts.get(ip) ?? { count:0, until:at+60000 };
    if (attempt.count>=12) fail(429,'登录失败次数过多，请一分钟后再试');
    const { username,password } = req.body ?? {};
    const token = store.login(username,password);
    if (!token) { attempt.count++; loginAttempts.set(ip,attempt); fail(401,'账号或密码不正确'); }
    store.logout(sessionCookie(req));
    res.cookie(cookieName, token, { ...cookie, maxAge:8*3600000 }).json(store.session(token));
  });
  app.use('/api',(req,res,next) => {
    req.sessionToken = sessionCookie(req);
    req.user = store.session(req.sessionToken);
    if (!req.user) fail(401,'请先登录');
    next();
  });
  const admin = (req,res,next) => { if (req.user.role !== 'admin') fail(403,'需要管理员权限'); next(); };
  app.get('/api/me',(req,res)=>res.json(req.user));
  app.post('/api/logout',(req,res)=>{ store.logout(sessionCookie(req)); res.clearCookie(cookieName,cookie).json({ok:true}); });
  app.use('/api',(req,res,next)=>{ if (paused && req.method!=='GET') fail(409,'系统处于恢复检查模式，仅可查看数据'); next(); });
  app.get('/api/dashboard',(req,res)=>res.json(store.dashboard(req.user)));
  app.get('/api/leads',(req,res)=>res.json(store.list(req.user,{ view:String(req.query.view??'mine'), query:String(req.query.q??'').slice(0,100), page:Math.max(1,Math.min(10000,Number.parseInt(req.query.page)||1)) })));
  app.post('/api/leads/claim',(req,res)=>res.json(store.claim(req.user,req.body?.quantity,req.get('idempotency-key'))));
  app.get('/api/leads/:id',(req,res)=>res.json(store.detail(req.user,req.params.id)));
  app.post('/api/leads/:id/contact',(req,res)=>res.json(store.contact(req.user,req.params.id,req.body??{},req.get('idempotency-key'))));
  app.post('/api/leads/:id/opportunity',(req,res)=>res.json(store.opportunity(req.user,req.params.id,req.body??{},req.get('idempotency-key'))));
  app.post('/api/leads/:id/assign',admin,(req,res)=>res.json(store.assign(req.user,req.params.id,req.body?.owner,req.body?.reason,req.get('idempotency-key'))));
  app.get('/api/admin/employees',admin,(req,res)=>res.json(store.users()));
  app.post('/api/admin/employees',admin,(req,res)=>res.json(store.createUser(req.body??{},req.user)));
  app.patch('/api/admin/employees/:id',admin,(req,res)=>{ store.setEnabled(req.user,Number(req.params.id),req.body?.enabled); res.json({ok:true}); });
  app.get('/api/admin/audit',admin,(req,res)=>res.json(store.auditLog()));
  app.get('/api/admin/today.csv',admin,(req,res)=>{
    const { staff }=store.dashboard(req.user);
    const rows=[['员工','登记次数','客户数','接通次数','接通率'], ...staff.map(row=>[row.name,row.attempts,row.customers,row.connected,row.attempts?`${(100*row.connected/row.attempts).toFixed(1)}%`:''])];
    res.type('text/csv').attachment('今日联系统计.csv').send(`\ufeff${rows.map(row=>row.map(csvField).join(',')).join('\r\n')}`);
  });
  app.get('/api/admin/sync',admin,(req,res)=>res.json({items:store.outbox(),health:syncHealth.message??''}));
  app.post('/api/admin/sync/:id/retry',admin,(req,res)=>{ store.retry(req.user,Number(req.params.id)); res.json({ok:true}); });
  app.post('/api/admin/sync/:id/verify',admin,async (req,res)=>{
    const ok = remote && await verifyConflict(store,remote,req.user,Number(req.params.id));
    if (!ok) fail(409,'飞书记录仍与上次确认状态不一致，请修复后再核验');
    res.json({ok:true});
  });
  app.get('/api/admin/sample.csv',admin,(req,res)=>res.type('text/csv').attachment('示例线索.csv').send(readFileSync(resolve(root,'examples/sample.csv'))));
  app.get('/api/admin/batches',admin,(req,res)=>res.json(store.batches()));
  app.get('/api/admin/batches/:id.csv',admin,(req,res)=>{
    const rows = store.batch(req.params.id);
    const labels = {new:'新增',updated:'补充来源',duplicate:'重复',dnc:'勿扰',review:'待复核'};
    const report = [['原始行号','处理结果','说明'], ...rows.map(row=>[row.line,labels[row.status],row.reason])].map(row=>row.map(csvField).join(',')).join('\r\n');
    res.type('text/csv').attachment('导入结果.csv').send(`\ufeff${report}`);
  });
  app.post('/api/admin/import/preview',admin,upload.single('file'),async (req,res)=>{
    if (!req.file) fail(400,'请选择导入文件');
    let mapping;
    try { mapping = JSON.parse(req.body.mapping || '{}'); } catch { fail(400,'字段映射格式有误'); }
    const name = Buffer.from(req.file.originalname,'latin1').toString('utf8');
    const preview = await previewImport(store,req.file.buffer,name,{mapping,source:req.body.source,basis:req.body.basis});
    const key = randomUUID();
    for (const [id,value] of previews) if (value.until<Date.now() || value.actor===req.user.id) previews.delete(id);
    if (previews.size>=10) fail(429,'预览任务较多，请稍后重试');
    previews.set(key,{preview,actor:req.user.id,until:Date.now()+15*60000});
    const counts = Object.fromEntries(['new','updated','duplicate','dnc','review'].map(s=>[s,0]));
    for (const row of preview.rows) counts[row.status]++;
    res.json({ key, name:preview.name, mapping:preview.mapping, headers:preview.headers, ready:preview.ready, rows:preview.rows.slice(0,40), counts, total:preview.rows.length });
  });
  app.post('/api/admin/import/commit',admin,(req,res)=>{
    const entry = previews.get(req.body?.key);
    if (!entry || entry.actor!==req.user.id || entry.until<Date.now()) fail(409,'导入预览已过期，请重新上传');
    if (!entry.preview.ready || !entry.preview.rows.length) fail(400,'请完成字段映射并提供数据行');
    res.json(store.commitImport(req.user,entry.preview));
  });
  app.use('/api/content',contentRoutes(store,ai,paused,xhsDraft));
  app.use('/api',(_,res)=>res.status(404).json({error:'接口不存在'}));
  app.use(express.static(resolve(root,'dist'),{index:'index.html',dotfiles:'deny'}));
  app.use((error,req,res,next)=>{
    if (res.headersSent) return next(error);
    const status = error instanceof multer.MulterError ? 400 : error.status ?? 500;
    if (status>=500) console.error('服务错误',error.code ?? error.name);
    res.status(status).json({error:error instanceof multer.MulterError ? (req.originalUrl.startsWith('/api/content/')?'素材上传失败。请选择一个 40 MB 以内的文件。':'上传失败。请选择一个 10 MB 以内的文件。') : status<500 ? error.message : '服务暂时不可用，请稍后重试'});
  });
  return app;
}
