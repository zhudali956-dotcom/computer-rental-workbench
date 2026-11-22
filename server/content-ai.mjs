const demoImage=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3sAAAAASUVORK5CYII=','base64');
const positive=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:undefined;};

export function contentAi(env,{mock=false,fetcher=fetch}={}) {
  if(mock) return { mode:'mock', daily:0, personal:0, rates:{copy:0,image:0,edit:0},
    async generate({kind,fact,platform,reference}) {
      if(kind==='copy')return {text:`${platform}演示草稿\n${fact.name}\n${fact.details}\n欢迎咨询适用的设备与租期。`};
      return {image:reference?Buffer.from(reference.data):demoImage};
    }};
  const daily=positive(env.OPENAI_DAILY_BUDGET_CENTS),personal=positive(env.OPENAI_USER_BUDGET_CENTS);
  if(!env.OPENAI_API_KEY||!daily||!personal)return null;
  const copyRate=positive(env.OPENAI_TEXT_RESERVE_CENTS),imageRate=positive(env.OPENAI_IMAGE_RESERVE_CENTS);
  const rates={copy:env.OPENAI_TEXT_MODEL?copyRate:undefined,image:env.OPENAI_IMAGE_MODEL?imageRate:undefined,edit:env.OPENAI_IMAGE_MODEL?imageRate:undefined};
  if(!Object.values(rates).some(Boolean))return null;
  return {mode:'live',daily,personal,rates,async generate(input){
    const {kind,reference,fact,request,platform}=input;
    const prompt=`目标平台：${platform}\n制作要求：${request}\n已确认业务资料：${fact.name}\n${fact.details}\n租金、规格、库存、免押与配送范围只使用已确认资料。缺失信息保留为待确认。`;
    const headers={authorization:`Bearer ${env.OPENAI_API_KEY}`};
    let path,body;
    if(kind==='edit') {
      path='images/edits';body=new FormData();
      body.append('model',env.OPENAI_IMAGE_MODEL);body.append('prompt',`${prompt}\n保持设备外观准确，不添加价格或业务承诺。`);
      body.append('image',new Blob([reference.data],{type:reference.mime}),`reference.${reference.mime.split('/')[1]}`);
      body.append('n','1');body.append('size','1024x1024');body.append('quality','medium');
    } else {
      headers['content-type']='application/json';
      if(kind==='copy') {
        path='responses';body=JSON.stringify({model:env.OPENAI_TEXT_MODEL,input:prompt,store:false,max_output_tokens:1200,
          instructions:'为电脑租赁团队起草中文文案。以业务资料为事实边界。供人工审核，不生成虚假的用户体验或营销承诺。'});
      } else {
        path='images/generations';body=JSON.stringify({model:env.OPENAI_IMAGE_MODEL,prompt:`${prompt}\n制作供人工审核的配图，无价格、文字或业务承诺。`,n:1,size:'1024x1024',quality:'medium'});
      }
    }
    const res=await fetcher(`https://api.openai.com/v1/${path}`,{method:'POST',headers,body,signal:AbortSignal.timeout(150000),redirect:'error'});
    if(!res.ok)throw Object.assign(new Error(`生成接口返回 HTTP ${res.status}`),{definite:[400,401,403,404,422,429].includes(res.status)});
    const json=await res.json();
    if(kind==='copy') {
      const text=json.output?.flatMap(row=>row.content??[]).filter(row=>row.type==='output_text').map(row=>row.text).join('\n');
      if(!text)throw Error('生成响应未返回文案');
      return {text:text.slice(0,6000),usage:json.usage};
    }
    if(!json.data?.[0]?.b64_json)throw Error('生成响应未返回图片');
    return {image:Buffer.from(json.data[0].b64_json,'base64'),usage:json.usage};
  }};
}
