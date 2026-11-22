import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { readSheet } from 'read-excel-file/node';
import { fail } from './store.mjs';

export const columns = {
  company:['企业名称','公司名称','公司','企业','company'],
  phone:['联系电话','电话','手机号','联系号码','联系方式','phone'],
  source:['来源','数据来源','source'], source_date:['来源日期','source_date'], basis:['联系依据','使用依据','basis'],
  person:['联系人','姓名','person'], city:['城市','地区','city'], industry:['行业','industry'], notes:['备注','notes']
};
const clean = (value, max = 300) => (value instanceof Date ? value.toISOString().slice(0,10) : String(value ?? '')).normalize('NFKC').trim().slice(0, max);

function phoneNumber(value) {
  let phone = value.replace(/[\s()\-]/g, '').replace(/^\+86(?=\d)/, '');
  if (/^861\d{10}$/.test(phone)) phone = phone.slice(2);
  return /^(?:1[3-9]\d{9}|0\d{9,11}(?:[转xX]\d{1,6})?|(?:400|800)\d{7})$/.test(phone) ? phone.replace(/[xX]/,'转') : '';
}

export async function previewImport(store, buffer, name, options = {}) {
  name = String(name).split(/[/\\]/).at(-1).slice(0,160);
  if (!buffer.length || buffer.length > 10*1024*1024) fail(400, '请选择 10 MB 以内的文件');
  let matrix;
  try {
    if (/\.xlsx$/i.test(name)) {
      // 限制压缩包展开规模，避免很小的 XLSX 耗尽内存。
      let eocd = -1;
      for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50 && i+22+buffer.readUInt16LE(i+20) === buffer.length) { eocd=i; break; }
      }
      if (eocd < 0) fail(400, 'Excel 文件结构无效');
      let cursor = buffer.readUInt32LE(eocd+16), size = 0;
      const entries = buffer.readUInt16LE(eocd+10);
      for (let i=0; i<entries; i++) {
        if (cursor+46>eocd || buffer.readUInt32LE(cursor)!==0x02014b50) fail(400, 'Excel 文件结构无效');
        size += buffer.readUInt32LE(cursor+24);
        cursor += 46+buffer.readUInt16LE(cursor+28)+buffer.readUInt16LE(cursor+30)+buffer.readUInt16LE(cursor+32);
        if (size>40*1024*1024 || entries>400) fail(413, 'Excel 解压后过大，请拆分文件');
      }
      const rows = await readSheet(buffer, 1);
      matrix = rows.map((cells, i) => ({ cells, line:i+1 }));
    } else if (/\.csv$/i.test(name)) {
      let content;
      try { content = new TextDecoder('utf-8',{ fatal:true }).decode(buffer); }
      catch { content = new TextDecoder('gb18030').decode(buffer); }
      let previous = 0;
      matrix = parse(content,{ bom:true, relax_column_count:true, info:true, max_record_size:50000 }).map(({ record,info }) => {
        const row = { cells:record, line:previous+1 };
        previous=info.lines;
        return row;
      });
    } else fail(400, '请选择 .csv 或 .xlsx 文件');
  } catch (error) {
    if (error.status) throw error;
    fail(400, '无法解析文件，请检查格式，或重新保存后上传');
  }
  if (!matrix.length || matrix.length > 10001 || matrix[0].cells.length > 100) fail(400, '文件须有表头，最多 100 列、10,000 行数据');
  const headers = matrix[0].cells.map(value => clean(value,100));
  const mapping = Object.fromEntries(Object.entries(columns).map(([key, names]) => {
    const index = options.mapping?.[key] ?? headers.findIndex(header => names.includes(header.toLowerCase()));
    return [key, Number.isInteger(Number(index)) && Number(index)<headers.length && Number(index)>=0 ? Number(index) : -1];
  }));
  const ready = mapping.company>=0 && mapping.phone>=0 && mapping.company!==mapping.phone;
  const staged = new Map();
  const rows = matrix.slice(1).map(({ cells,line }) => {
    const data = Object.fromEntries(Object.entries(mapping).map(([key,index]) => [key, index < 0 ? '' : clean(cells[index])]));
    data.phone = phoneNumber(data.phone);
    data.source ||= clean(options.source);
    data.basis ||= clean(options.basis);
    if (store.demo) { data.source ||= '本地演示'; data.basis ||= '虚构演示号码'; }
    const error = !ready ? '请映射企业名称和联系电话' : !data.company ? '企业名称为空' : !data.phone ? '联系电话格式无效' : !data.source || !data.basis ? '缺少来源或联系依据' : '';
    if (error) return { line, status:'review', reason:error, error, data };
    const prior = staged.get(data.phone) ?? store.leadByPhone(data.phone);
    let status = 'new', reason = '';
    if (prior?.dnc) { status = 'dnc'; reason = '号码已标记勿扰'; }
    else if (prior?.conflict || (prior && prior.company !== data.company)) { status = 'review'; reason = '同一号码的归属需人工复核'; }
    else if (prior) {
      const known = prior.sources ?? store.sources(prior.id);
      status = known.some(row => row.source===data.source && row.source_date===data.source_date && row.basis===data.basis) ? 'duplicate' : 'updated';
      staged.set(data.phone,{ company:data.company, sources:[...known,data] });
    } else staged.set(data.phone,{ company:data.company, sources:[data] });
    return { line, status, reason, data };
  });
  const hash = createHash('sha256').update(buffer).update(JSON.stringify({ version:1, mapping, source:clean(options.source), basis:clean(options.basis) })).digest('hex');
  return { name, headers, mapping, rows, hash, ready };
}
