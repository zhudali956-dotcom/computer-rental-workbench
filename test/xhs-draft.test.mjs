import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDraftForXhs } from '../server/xhs-draft.mjs';
import { openStore } from '../server/store.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3sAAAAASUVORK5CYII=','base64');

test('草稿助手拒绝越权、已暂存版本和非小红书图文',t=>{
  const db=openStore(':memory:',{demo:true});t.after(()=>db.close());
  const [admin,alice,bob]=db.users(),c=db.content;
  const fact=c.fact(admin,{name:'演示',details:'虚构场景',source:'测试'});
  const newDraft=(platform,handle)=>{
    const a=c.account(admin,{platform,handle,name:'演示',operator:alice.id,editor:bob.id});
    const img=c.upload(alice,a.id,'封面.png',png);
    return c.save(alice,{account:a.id,fact:fact.id,format:'image',title:'会议短租准备',body:'先确认数量',tags:'#会务 #电脑租赁',media:[img.id]});
  };
  const xhs=newDraft('xiaohongshu','fixture-xhs'), other=newDraft('douyin','fixture-douyin');
  assert.throws(()=>c.draftForXhs(bob,xhs.id,xhs.version),{status:403});
  assert.throws(()=>c.draftForXhs(alice,other.id,other.version),{status:400});
  const pack=c.draftForXhs(alice,xhs.id,xhs.version);
  assert.deepEqual(validateDraftForXhs(pack).topics,['会务','电脑租赁']);
  assert.deepEqual(pack.files[0].buffer,png);
  c.recordPlatformDraft(alice,xhs.id,xhs.version,{browser:'测试',note:'已在草稿箱核实'});
  assert.throws(()=>c.draftForXhs(alice,xhs.id,xhs.version),{status:409});
});

test('草稿助手校验账号标识、标题和图片大小',()=>{
  const pack={account:{handle:'fixture-xhs'},title:'会务短租',body:'先确认数量',tags:'#会务',files:[{mimeType:'image/png',buffer:png}]};
  assert.throws(()=>validateDraftForXhs({...pack,account:{handle:'演示账号'}}),{status:400});
  assert.throws(()=>validateDraftForXhs({...pack,title:'超出小红书图文标题字数限制的测试文字用例共超过二十字'}),{status:400});
  assert.throws(()=>validateDraftForXhs({...pack,files:[{mimeType:'video/mp4',buffer:png}]}),{status:400});
});
