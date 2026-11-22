import { createRequire } from 'node:module';

export async function loadFeishuConfig(env) {
  const { FEISHU_APP_ID:id, FEISHU_BASE_TOKEN:base, FEISHU_TABLE_ID:table } = env;
  let secret = env.FEISHU_APP_SECRET;
  if (!secret && id && env.FEISHU_CREDENTIAL_SERVICE && env.FEISHU_KEYTAR_MODULE) {
    const keytar = createRequire(import.meta.url)(env.FEISHU_KEYTAR_MODULE);
    secret = await keytar.getPassword(env.FEISHU_CREDENTIAL_SERVICE, id);
  }
  return { id, secret, base, table };
}
