import { Router } from 'express';
import multer from 'multer';
import { fail } from './store.mjs';
import { accountStates,contentStates,jobStates,platforms } from './content.mjs';

const mediaUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:40*1024*1024,files:1,fields:0}});

export function contentRoutes(store,ai,paused,xhsDraft) {
  const app=Router(), content=store.content;
  const data=req=>req.body??{};
  app.get('/',(req,res)=>{
    const active=ai?.allows&&!ai.allows(req.user,req.socket)?null:ai;
    res.json({...content.home(req.user),platforms,accountStates,contentStates,jobStates,
      xhsDraftEnabled:Boolean(xhsDraft)&&req.user.role==='admin'&&req.user.id===1,
      ai:{mode:active?.mode??'off',kinds:Object.entries(active?.rates??{}).filter(([,value])=>Number.isInteger(value)).map(([key])=>key)},
      employees:req.user.role==='admin'?store.users():[]});
  });
  app.post('/accounts',(req,res)=>res.json(content.account(req.user,data(req))));
  app.post('/facts',(req,res)=>res.json(content.fact(req.user,data(req))));
  app.post('/assets/:account',(req,res,next)=>{content.access(req.user,req.params.account,true);next();},mediaUpload.single('file'),(req,res)=>{
    if(!req.file)fail(400,'请选择要上传的素材');
    if(!store.session(req.sessionToken))fail(401,'当前会话已失效');
    const name=Buffer.from(req.file.originalname,'latin1').toString('utf8');
    res.json(content.upload(req.user,req.params.account,name,req.file.buffer));
  });
  app.get('/assets/:id',(req,res)=>{
    const asset=content.asset(req.user,req.params.id);
    if(req.query.view==='1'&&asset.mime.startsWith('image/'))res.type(asset.mime);
    else res.attachment(asset.name).type(asset.mime);
    res.send(Buffer.from(asset.data));
  });
  app.post('/drafts',(req,res)=>res.json(content.save(req.user,data(req))));
  app.post('/drafts/:id/submit',(req,res)=>res.json(content.submit(req.user,req.params.id,data(req).version)));
  app.post('/drafts/:id/review',(req,res)=>res.json(content.review(req.user,req.params.id,data(req).version,data(req).action,data(req).note)));
  app.post('/drafts/:id/schedule',(req,res)=>res.json(content.schedule(req.user,req.params.id,data(req).version,data(req).planned)));
  app.post('/drafts/:id/platform-draft',(req,res)=>res.json(content.recordPlatformDraft(req.user,req.params.id,data(req).version,data(req))));
  app.post('/drafts/:id/xhs-prepare',async(req,res)=>{
    if(!xhsDraft)fail(409,'当前入口没有启用本机小红书草稿助手');
    res.json(await xhsDraft.prepare(req.user,req.params.id,data(req).version));
  });
  app.post('/xhs-browser',async(req,res)=>{
    if(!xhsDraft)fail(409,'当前入口没有启用本机小红书草稿助手');
    res.json(await xhsDraft.open(req.user));
  });
  app.post('/jobs/:id/release',(req,res)=>res.json(content.release(req.user,req.params.id,data(req).planned)));
  app.post('/jobs/:id/result',(req,res)=>res.json(content.result(req.user,req.params.id,data(req))));
  app.get('/jobs/:id/package',(req,res)=>{
    if(paused)fail(409,'恢复检查期间暂停发布包下载');
    const output=content.download(req.user,req.params.id);
    res.type('application/zip').attachment('人工发布包.zip').send(Buffer.from(output));
  });
  app.post('/ai',(req,res)=>{
    const actor=req.user;
    ai?.authorize?.(actor,req.socket);
    const {job,request}=content.reserveAi(actor,data(req),req.get('idempotency-key'),ai);
    res.status(202).json({id:job.id,state:job.state});
    if(!request)return;
    void (async()=>{
      let generated;
      try { generated=await ai.generate(request); }
      catch(error) {
        content.finishAi(job.id,error.definite?'failed':'unknown',{message:error.definite?error.message:'生成结果待核验，暂保留预算'});
        return;
      }
      if(generated.text)content.finishAi(job.id,'done',{text:generated.text,usage:generated.usage,factId:request.fact.id});
      else {
        const user=store.users().find(row=>row.id===actor.id&&row.enabled);
        try {
          if(!user)fail(409,'提交人已停用');
          const asset=content.upload(user,data(req).account,'',generated.image);
          content.finishAi(job.id,'done',{asset:asset.id,usage:generated.usage,factId:request.fact.id});
        } catch {content.finishAi(job.id,'no_result',{message:'生成已返回，素材未入库。请核对账号授权或存储空间。',usage:generated.usage});}
      }
    })().catch(()=>console.error('AI 任务状态记录失败，重启后进入待核验'));
  });
  app.post('/ai/:id/resolve',(req,res)=>res.json(content.resolveAi(req.user,req.params.id,data(req).wasCharged,data(req).note)));
  return app;
}
