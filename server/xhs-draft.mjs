import { resolve } from 'node:path';

export const creatorOrigin='https://creator.xiaohongshu.com';
const home=`${creatorOrigin}/new/home`;
const editorUrl=`${creatorOrigin}/publish/publish?from=homepage&target=image`;
const error=(status,message)=>Object.assign(new Error(message),{status});
const titleSelector='input[placeholder="填写标题会有更多赞哦"]';
const editorSelector='[contenteditable="true"][role="textbox"]';

export function validateDraftForXhs(pack) {
  if(!/^[a-zA-Z0-9_-]{5,40}$/.test(pack.account.handle))throw error(400,'请在账号管理中登记创作者首页显示的小红书号');
  if(!pack.title||Array.from(pack.title).length>20)throw error(400,'小红书标题需在 20 字以内');
  const topics=[...new Set(pack.tags.split(/\s+/).map(value=>value.replace(/^#/, '')).filter(Boolean))];
  if(topics.length>10||topics.some(tag=>tag.includes('#')||Array.from(tag).length>40))throw error(400,'请填写不超过 10 个话题，用空格分隔');
  if(!pack.body||Array.from(pack.body+'\n'+topics.map(tag=>`#${tag}`).join(' ')).length>1000)throw error(400,'小红书正文与话题合计需在 1000 字以内');
  if(!pack.files.length||pack.files.length>9||pack.files.some(file=>!['image/png','image/jpeg','image/webp'].includes(file.mimeType)||!file.buffer.length||file.buffer.length>32*1024*1024))throw error(400,'请选择 1–9 张 PNG、JPEG 或 WebP 图片，单张限 32 MB');
  return {...pack,topics};
}

export async function fillXhsEditor(page,raw,{beforeUpload=()=>{}}={}) {
  const pack=validateDraftForXhs(raw);
  const exact=await page.getByText(new RegExp(`^\\s*小红书账号\\s*[：:]\\s*${escapeRegex(pack.account.handle)}\\s*$`)).isVisible();
  if(!exact)throw error(409,'登录账号与稿件目标不一致，或创作后台未显示小红书号');
  await page.goto(editorUrl,{waitUntil:'domcontentloaded',timeout:20000});
  const location=new URL(page.url());
  if(location.origin!==creatorOrigin||location.pathname!=='/publish/publish')throw error(409,'没有进入小红书图文编辑页');
  const upload=page.getByRole('button',{name:'上传图片',exact:true});
  await upload.waitFor({state:'visible',timeout:12000});
  if(await page.locator(titleSelector).isVisible() || await page.locator(editorSelector).isVisible())throw error(409,'当前页已有稿件，已停止填写');
  const [chooser]=await Promise.all([page.waitForEvent('filechooser',{timeout:12000}),upload.click()]);
  if(pack.files.length>1&&!chooser.isMultiple())throw error(409,'当前上传控件不支持多图，已停止填写');
  beforeUpload();
  await chooser.setFiles(pack.files);
  const title=page.locator(titleSelector),editor=page.locator(editorSelector);
  await title.waitFor({state:'visible',timeout:25000});
  const tip=page.getByRole('button',{name:'我知道了',exact:true});
  if(await tip.isVisible())await tip.click();
  if(await title.inputValue() || (await editor.innerText()).trim()) throw error(409,'编辑器已有文字，请检查后再继续');
  await title.fill(pack.title);
  await editor.click();
  await page.keyboard.insertText(pack.body);
  const compact=text=>text.replace(/\s+/g,'');
  if((await title.inputValue())!==pack.title || compact(await editor.innerText())!==compact(pack.body))throw error(409,'编辑器字段回读不一致，请检查草稿');
  if(pack.topics.length)await page.keyboard.press('Enter');
  for(const tag of pack.topics) {
    await page.locator('#topicBtn').click();
    await page.keyboard.insertText(tag);
    const option=page.getByText(new RegExp(`^#?${escapeRegex(tag)}\\s*\\d[\\d.,]*[万亿]?\\s*(?:次)?浏览$`));
    try {await option.first().click({timeout:3500});}
    catch {return {filled:true,manual:`话题「${tag}」未找到精确匹配，请核对剩余话题后暂存。`};}
  }
  return {filled:true,manual:'请核对图片、话题和内容声明，然后点击「暂存离开」。'};
}

function escapeRegex(text){return text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

export function createXhsDraftAssistant(store,env) {
  let context,profilePage,busy=false;
  async function browser() {
    if(context)return context;
    const {chromium}=await import('playwright-core');
    const current=await chromium.launchPersistentContext(resolve('.data/xhs-draft-browser'),{
      executablePath:env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:false,timeout:12000
    });
    current.on('close',()=>{if(context===current){context=null;profilePage=null;}});
    context=current;
    return context;
  }
  function requireOwner(user){
    if(user.role!=='admin'||user.id!==1)throw error(403,'本机草稿助手仅供初始管理员使用');
    if(busy)throw error(409,'已有小红书草稿正在处理');
  }
  async function openProfile() {
    const ctx=await browser();
    if(!profilePage||profilePage.isClosed()) profilePage=await ctx.newPage();
    await profilePage.bringToFront();
    await profilePage.goto(home,{waitUntil:'domcontentloaded',timeout:20000});
  }
  async function prepare(user,id,version){
    requireOwner(user);
    const pack=validateDraftForXhs(store.content.draftForXhs(user,id,version));
    busy=true;
    let reserved=false;
    try {
      await openProfile();
      const identity=profilePage.getByText(/^\s*小红书账号\s*[:：]/);
      const visible=await identity.first().waitFor({state:'visible',timeout:8000}).then(()=>true,()=>false);
      if(!visible)return {stage:'login',message:'请在刚打开的 Chrome 登录目标小红书账号，再回到工作台重试。'};
      const latest=store.users().find(row=>row.id===user.id&&row.enabled&&row.role==='admin');
      if(!latest)throw error(403,'当前操作员权限已撤销');
      const result=await fillXhsEditor(profilePage,pack,{beforeUpload:()=>{
        const active=store.users().find(row=>row.id===user.id&&row.enabled&&row.role==='admin');
        if(!active)throw error(403,'当前操作员权限已撤销');
        store.content.beginXhsDraft(active,id,version);reserved=true;
      }});
      store.content.finishXhsDraft(id,version,'filled');
      return {stage:'filled',message:result.manual};
    } catch (cause) {
      if(reserved){store.content.finishXhsDraft(id,version,'partial');return {stage:'partial',message:'已进入编辑环节，填写未完整核验。请检查已打开的页面，避免重复建草稿。'};}
      if(cause.status)throw cause;
      throw error(409,'草稿助手未能打开或识别创作页。请检查本机 Chrome、网络和登录状态。');
    } finally {if(reserved)profilePage=null;busy=false;}
  }
  async function open(user){
    requireOwner(user);busy=true;
    try {await openProfile();return {message:'专用 Chrome 已打开，请在窗口中登录或核对显示的小红书号。'};}
    catch {throw error(409,'无法打开创作后台，请检查本机 Chrome 和网络。');}
    finally {busy=false;}
  }
  return {open,prepare};
}
