import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/http.mjs';
import { openStore } from '../server/store.mjs';

const directory = await mkdtemp(join(tmpdir(),'workbench-browser-'));
const store = openStore(join(directory,'data.sqlite'),{demo:true});
const server = createApp(store).listen(0,'127.0.0.1');
await new Promise((done,reject)=>{server.once('listening',done);server.once('error',reject);});
const baseURL=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const errors=[];
  async function login(username,password) {
    const context=await browser.newContext({baseURL,viewport:{width:1440,height:950}});
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('/');
    await page.getByLabel('账号',{exact:true}).fill(username);
    await page.getByLabel('密码',{exact:true}).fill(password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('heading',{name:'工作概览'}).waitFor();
    return { page,context };
  }
  const admin=await login('admin','demo-admin-2026');
  await admin.page.getByRole('button',{name:'导入记录'}).click();
  await admin.page.getByLabel('Excel / CSV 文件').setInputFiles(resolve('examples/sample.xlsx'));
  await admin.page.getByRole('button',{name:'预览文件'}).click();
  await admin.page.getByText('新增 3',{exact:true}).waitFor();
  await admin.page.getByRole('button',{name:'确认导入'}).click();
  await admin.page.getByText('导入完成，新增 3 条').waitFor();
  const report=await admin.page.getByRole('link',{name:'下载 CSV'}).getAttribute('href');
  assert.match(await (await admin.context.request.get(report)).text(),/待复核/);
  const alice=await login('lin','demo-sales-2026'), bob=await login('zhou','demo-sales-2026');
  await alice.page.getByRole('button',{name:'客户线索',exact:true}).click();
  const claimResponse=alice.page.waitForResponse(response=>response.url().endsWith('/api/leads/claim')&&response.request().method()==='POST');
  await alice.page.getByRole('button',{name:'领取 1 条'}).click();
  const [lead]=await (await claimResponse).json();
  assert.equal((await bob.context.request.get(`/api/leads/${lead.id}`)).status(),404);
  assert.equal((await bob.context.request.get('/api/admin/employees')).status(),403);
  const future=new Date(Date.now()+32*3600000).toISOString().slice(0,16);
  async function fillContact() {
    await alice.page.getByRole('button',{name:'登记联系'}).click();
    await alice.page.getByLabel('联系结果').selectOption('interested');
    await alice.page.getByLabel('联系备注').fill('客户需要 20 台电脑用于培训。');
    await alice.page.getByLabel('下次回访时间（北京时间）').fill(future);
    await alice.page.getByLabel('下一步',{exact:true}).fill('确认租期并给报价');
  }
  await fillContact();
  await alice.page.route(`**/api/leads/${lead.id}/contact`,async route=>{
    const saved=await route.fetch();
    assert.equal(saved.status(),200);
    await route.abort('failed');
  },{times:1});
  await alice.page.getByRole('button',{name:'保存联系'}).click();
  await alice.page.getByRole('alert').waitFor();
  await alice.page.reload();
  await alice.page.getByRole('button',{name:'客户线索',exact:true}).click();
  await alice.page.getByRole('button',{name:'查看',exact:true}).click();
  await fillContact();
  await alice.page.getByRole('button',{name:'保存联系'}).click();
  await alice.page.getByText('联系结果已保存').waitFor();
  assert.equal((await (await alice.context.request.get(`/api/leads/${lead.id}`)).json()).logs.length,1);
  await alice.page.getByRole('button',{name:'新建商机'}).click();
  await alice.page.getByLabel('机型需求').fill('商务笔记本');
  await alice.page.getByLabel('数量',{exact:true}).fill('20');
  await alice.page.getByLabel('租期',{exact:true}).fill('7 天');
  await alice.page.getByLabel('交付地点').fill('活动会场');
  await alice.page.getByRole('button',{name:'保存商机'}).click();
  await alice.page.getByText('商机已保存').waitFor();
  await alice.page.getByRole('button',{name:'回访待办'}).click();
  await alice.page.getByRole('button',{name:'查看',exact:true}).click();
  await alice.page.getByText('确认租期并给报价',{exact:true}).waitFor();
  if(process.env.DEMO_SCREENSHOT) {
    await mkdir(resolve('.data'),{recursive:true});
    await alice.page.screenshot({path:resolve('.data/销售工作台验收.png'),fullPage:true});
  }
  await alice.page.getByRole('button',{name:'登记联系'}).click();
  await alice.page.getByLabel('联系结果').selectOption('refused');
  await alice.page.getByRole('button',{name:'保存联系'}).click();
  await alice.page.getByText('当前没有回访待办。',{exact:true}).waitFor();
  const remaining=await Promise.all(Array.from({length:20},(_,index)=>(index%2?alice:bob).context.request.post('/api/leads/claim',{data:{quantity:1},headers:{'idempotency-key':`parallel-${index}`}})));
  assert.ok(remaining.every(res=>res.ok()));
  const claimed=(await Promise.all(remaining.map(res=>res.json()))).flat();
  assert.equal(claimed.length,2);
  assert.equal(new Set(claimed.map(row=>row.id)).size,2);
  assert.deepEqual(errors,[]);
  console.log('Chrome 端到端通过：Excel 导入、两个独立销售会话、越权拦截、回执丢失后刷新防重、商机、回访、勿扰和 20 个并发领取请求。');
} finally {
  await browser?.close();
  await new Promise(done=>server.close(done));
  store.close();
  await rm(directory,{recursive:true,force:true});
}
