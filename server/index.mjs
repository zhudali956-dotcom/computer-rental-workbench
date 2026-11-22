import { createServer as httpsServer } from 'node:https';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openStore } from './store.mjs';
import { createApp } from './http.mjs';
import { auditRemote, feishuClient, syncOne } from './feishu.mjs';
import { loadFeishuConfig } from './feishu-config.mjs';
import { contentAi } from './content-ai.mjs';
import { personalContentAi } from './content-personal.mjs';
import { createXhsDraftAssistant } from './xhs-draft.mjs';
import { productionHost, productionTls } from './production.mjs';

const env = process.env;
const demo = process.argv.includes('--demo');
const feishuTest = process.argv.includes('--feishu-test');
if (demo && feishuTest) throw new Error('请选择一种启动模式');
let paused = !demo && env.SYNC_PAUSED === '1';
const host = demo || feishuTest ? '127.0.0.1' : productionHost(env.WORKBENCH_HOST);
const port = Number(env.WORKBENCH_PORT || (feishuTest ? 4189 : 4188));
const dbPath = resolve(demo ? (env.WORKBENCH_DEMO_DB || '.data/demo.sqlite') : feishuTest ? (env.WORKBENCH_FEISHU_TEST_DB || '.data/feishu-test.sqlite') : (env.WORKBENCH_DB || '.data/workbench.sqlite'));
const secure = !demo && !feishuTest;
const tls = secure ? productionTls(env,host) : null;
mkdirSync(dirname(dbPath),{recursive:true});
const store = openStore(dbPath,{demo,feishuTest});
if (!demo && store.requiresRecovery()) paused=true;
const config = !demo && !paused ? await loadFeishuConfig(env) : {};
if (!demo && !paused && Object.values(config).some(value=>!value)) throw new Error('正式服务需要配置飞书应用和多维表');
if (secure&&!paused) store.bindFeishu(config);
if (!demo && !store.users().length) {
  if (!env.WORKBENCH_ADMIN_PASSWORD) throw new Error('首次启动前须设置初始管理员密码');
  store.createUser({ username:env.WORKBENCH_ADMIN_USERNAME || 'admin', name:'管理员', password:env.WORKBENCH_ADMIN_PASSWORD, role:'admin' });
}
const remote = !demo && !paused ? feishuClient(config) : null;
const syncHealth = { message:remote?'正在验证飞书配置':'' };
if(!paused)store.content.recoverAi();
const personalMode=(feishuTest&&env.WORKBENCH_FEISHU_PERSONAL_CODEX==='1')||(secure&&env.WORKBENCH_PRODUCTION_PERSONAL_AI==='1');
const ai=paused?null:personalMode?personalContentAi(env,{localOnly:secure}):contentAi(env,{mock:demo||(feishuTest&&env.WORKBENCH_FEISHU_LIVE_AI!=='1')});
const xhsDraft=feishuTest&&!paused&&env.WORKBENCH_LOCAL_XHS_ASSIST==='1'?createXhsDraftAssistant(store,env):null;
const app = createApp(store,{secure,paused,remote,syncHealth,feishuTest,ai,xhsDraft});
const server = secure ? httpsServer(tls,app) : createServer(app);
server.requestTimeout = 60000;
let timer, stopping = false;
if (remote) {
  let checked = false, lastAudit = 0, cursor = 0;
  async function cycle() {
    let delay = 1000;
    try {
      if (!checked) { await remote.checkFields(); checked = true; }
      await syncOne(store,remote);
      if (Date.now()-lastAudit > 5000) { lastAudit=Date.now(); cursor=await auditRemote(store,remote,cursor); }
      syncHealth.message='';
    } catch (error) { syncHealth.message=`飞书检查暂缓。${error.message}`; console.error(syncHealth.message); delay=15000; }
    if (!stopping) timer=setTimeout(cycle,delay);
  }
  timer=setTimeout(cycle,0);
}
server.listen(port,host,()=>console.log(`${demo ? '本机演示' : paused ? '恢复检查' : feishuTest ? '飞书联调' : '工作台'} ${secure ? 'https' : 'http'}://${host}:${server.address().port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  stopping=true;
  clearTimeout(timer);
  server.close(()=>process.exit(0));
});
