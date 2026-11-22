import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { creatorOrigin,fillXhsEditor } from '../server/xhs-draft.mjs';

// 用隔离浏览器模拟创作页，检查上传、回读和人工暂存边界。
const compose=`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<input type="file" accept="image/png" multiple hidden id="media">
<button id="upload">上传图片</button><div id="tool" hidden>
<input placeholder="填写标题会有更多赞哦"><div role="textbox" contenteditable="true" style="min-height:30px"></div>
<button id="topicBtn">话题</button><div id="choices"></div>
<button id="save">暂存离开</button><button id="publish">发布</button></div>
<output id="event"></output>
<script>
const media=document.querySelector('#media'), editor=document.querySelector('[contenteditable]'), choices=document.querySelector('#choices');
document.querySelector('#upload').onclick=()=>media.click();
media.onchange=()=>{document.querySelector('#tool').hidden=false;document.querySelector('#upload').hidden=true};
document.querySelector('#topicBtn').onclick=()=>{editor.focus();document.execCommand('insertText',false,'#')};
editor.oninput=()=>{const tag=editor.innerText.match(/#([^#\\s]+)$/)?.[1];choices.replaceChildren();if(!tag)return;
 const b=document.createElement('button');b.textContent='#'+tag+' 10万浏览';b.onclick=()=>{choices.replaceChildren();editor.focus();document.execCommand('insertText',false,' ')};choices.append(b)};
for(const name of ['save','publish'])document.querySelector('#'+name).onclick=()=>{document.querySelector('#event').textContent=name};
</script></html>`;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3sAAAAASUVORK5CYII=','base64');
const pack={account:{handle:'fixture-xhs'},title:'会务短租准备',body:'先确认数量\n再确定时间',tags:'#会务 #电脑租赁',files:[{name:'图1.png',mimeType:'image/png',buffer:png}]};
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
  const page=await browser.newPage();
  let identity=pack.account.handle,entries=0,reservations=0;
  await page.route(`${creatorOrigin}/**`,route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/new/home')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<p>小红书账号: ${identity}</p>`});
    entries++;
    return route.fulfill({contentType:'text/html; charset=utf-8',body:compose});
  });
  const run=()=>fillXhsEditor(page,pack,{beforeUpload:()=>reservations++});
  identity='wrong-user';await page.goto(`${creatorOrigin}/new/home`);
  await assert.rejects(run(),{status:409});assert.equal(entries,0);assert.equal(reservations,0);
  identity=pack.account.handle;await page.goto(`${creatorOrigin}/new/home`);
  const result=await run();
  assert.equal(reservations,1);assert.equal(result.filled,true);assert.match(result.manual,/暂存离开/);
  assert.equal(await page.getByPlaceholder('填写标题会有更多赞哦').inputValue(),pack.title);
  const content=await page.locator('[contenteditable="true"]').innerText();
  assert.match(content,/先确认数量[\s\S]*再确定时间/);assert.match(content,/#会务.*#电脑租赁/);
  assert.equal(await page.locator('#event').textContent(),'');
  console.log('小红书草稿助手浏览器验收通过：错号拦截、图片上传、标题正文与两个话题填写、保留人工暂存。');
} finally {await browser.close();}
