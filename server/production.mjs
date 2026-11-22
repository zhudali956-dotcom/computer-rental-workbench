import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export function productionHost(value = '127.0.0.1') {
  if (isIP(value)!==4) throw new Error('正式服务须绑定环回或指定的办公室 IPv4 地址');
  const [first,second]=value.split('.').map(Number);
  if (value==='127.0.0.1'||first===10||(first===172&&second>=16&&second<=31)||(first===192&&second===168)) return value;
  throw new Error('正式服务只允许环回或指定私网地址');
}

export function productionTls(env,host) {
  if (!env.WORKBENCH_CERT||!env.WORKBENCH_KEY) throw new Error('正式服务需要配置内网 HTTPS 证书与私钥');
  const cert=readFileSync(env.WORKBENCH_CERT),key=readFileSync(env.WORKBENCH_KEY);
  const leaf=new X509Certificate(cert);
  if (!leaf.checkIP(host)||!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error('证书地址或私钥与正式服务配置不匹配');
  if (Date.parse(leaf.validFrom)>Date.now()||Date.parse(leaf.validTo)<=Date.now()) throw new Error('正式 HTTPS 证书未生效或已过期');
  return {cert,key,minVersion:'TLSv1.2'};
}
