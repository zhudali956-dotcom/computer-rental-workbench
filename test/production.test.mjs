import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../server/store.mjs';
import { productionHost } from '../server/production.mjs';
import { personalContentAi } from '../server/content-personal.mjs';

test('正式服务只监听环回或指定的办公室私网地址',()=>{
  assert.equal(productionHost(), '127.0.0.1');
  assert.equal(productionHost('10.123.45.6'), '10.123.45.6');
  assert.throws(()=>productionHost('0.0.0.0'));
  assert.throws(()=>productionHost('198.19.0.1'));
});

test('正式数据库绑定首次确认的飞书表，阻止重启时切错表',t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  store.bindFeishu({base:'productionBase',table:'tableOne'});
  store.bindFeishu({base:'productionBase',table:'tableOne'});
  assert.throws(()=>store.bindFeishu({base:'productionBase',table:'tableTwo'}),{status:409});
});

test('正式环境的临时个人 AI 只允许本机初始管理员使用',()=>{
  const ai=personalContentAi({}, {localOnly:true});
  const local={localAddress:'10.123.45.6',remoteAddress:'10.123.45.6'};
  const admin={id:1,role:'admin'};
  assert.equal(ai.allows(admin,local),true);
  assert.throws(()=>ai.authorize(admin,{...local,remoteAddress:'10.123.45.7'}),{status:403});
  assert.throws(()=>ai.authorize({id:2,role:'admin'},local),{status:403});
  assert.throws(()=>ai.authorize(admin,{}),{status:403});
});
