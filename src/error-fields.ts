// Avoid database detail, SQL text, provider response bodies, URLs and request parameters.
export function errorFields(error:unknown){
  const e=error instanceof Error?error:new Error('Non-error exception')
  const code='code' in e && typeof e.code==='string'?e.code:undefined
  const sqlState=code && /^[0-9A-Z]{5}$/.test(code)?code:undefined
  const safe=(s:string)=>s
    .replace(/(?:https?|postgres(?:ql)?):\/\/\S+/gi,'[url]')
    .replace(/(?:bearer|basic|password|token|secret|api[-_ ]?key|authorization)\s*[:= ]\s*[^,;\n]+/gi,'[credential]')
    .replace(/["'`][^"'`\n]*["'`]/g,'[value]')
    .replace(/[\w.+-]+@[\w.-]+|\+?\d[\d ()-]{6,}\d|[A-Za-z\d+_/.~-]{24,}/g,'[value]')
    .replace(/[\r\n\t]/g,' ').slice(0,220)
  const frames=(e.stack??'').split('\n').filter(l=>/^\s+at .+:\d+:\d+\)?$/.test(l)).slice(0,6)
    .map(l=>l.replace(/\?.*?(?=:\d+:\d+\)?$)/,'').trim().slice(0,180))
  return {errorType:e.name,message:safe(e.message.split('\n')[0]??''),...(sqlState?{sqlState}:{}),stack:frames}
}
