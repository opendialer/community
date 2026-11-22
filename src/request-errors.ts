import {log,withLogContext} from './log.js'
import type { Context, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomUUID } from 'node:crypto'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

declare module 'hono' {
  interface ContextVariableMap {
    supportRequestId: string
  }
}

export const traceRequest: MiddlewareHandler = async (c, next) => {
  const id = randomUUID()
  c.set('supportRequestId', id)
  c.header('X-Request-ID', id)
  const start=performance.now()
  await withLogContext({requestId:id},async()=>{
    await next()
    const durationMs=Math.round(performance.now()-start)
    // A route pattern omits emails, phone numbers, webhook tokens and query parameters.
    const route = c.req.matchedRoutes.filter(r => r.path !== '/*' && r.path !== '*').at(-1)?.path ?? 'unmatched'
    const status=c.res.status
    // userId/orgId/platformAdmin are added to the log context by the auth helpers while the request runs and
    // this line is written inside the same context object, so they appear here without being passed.
    const fields={requestId:id,method:c.req.method,route,status,durationMs}
    if(status>=500)log.error('request_completed',{...fields,reason:statusReason(status,route)})
    else if(status>=400)log.warn('request_failed',{...fields,reason:statusReason(status,route)})
    else if(durationMs>=1000)log.warn('slow_request',{...fields,reason:'slow_response',thresholdMs:1000})
    else if(c.req.method!=='GET' || route!=='/health')log.info('request_completed',fields)
  })
}

const statusReasons: Record<number,string> = {
  400:'bad_request',401:'unauthorized',403:'forbidden',404:'not_found',409:'conflict',413:'payload_too_large',422:'unprocessable',429:'rate_limited',
  500:'internal_error',502:'bad_gateway',503:'service_unavailable',504:'gateway_timeout'
}
function statusReason(status:number,route:string){
  if(status===404 && route==='unmatched')return 'route_not_found'
  return statusReasons[status] ?? (status>=500?'server_error':'client_error')
}

const fallback: Record<number,string> = {
  400:'Check the request fields and try again.',
  401:'Sign in again and retry the request.',
  403:'You do not have permission to perform this action.',
  404:'We could not find that resource.',
  409:'The resource has changed or is unavailable for this action. Refresh it and try again.',
  413:'The request is too large. Reduce the size and try again.',
  429:'Too many requests. Wait a moment and try again.',
  502:'The connected service could not complete this request.',
  503:'This service is temporarily unavailable.',
}

export function requestError(c: Context, status: ContentfulStatusCode, message?: string, issues?: {path: PropertyKey[],message: string}[]) {
  if(status===429 && !c.res.headers.has('Retry-After'))c.header('Retry-After','60')
  const error = message || fallback[status] || 'Something went wrong. Contact support with the request ID.'
  return c.json({error,requestId:c.get('supportRequestId'),...(issues ? {issues} : {})},status)
}

export function handleRequestError(err: Error, c: Context) {
  if (err instanceof HTTPException) {
    if(err.status>=500)log.error('service_error',{requestId:c.get('supportRequestId'),status:err.status,reason:'http_exception_5xx',error:err.cause??err})
    const retry=err.res?.headers.get('Retry-After')
    if(retry)c.header('Retry-After',retry)
    return requestError(c,err.status,err.message)
  }
  log.error('unhandled_error',{requestId:c.get('supportRequestId'),status:500,reason:'unhandled_exception',error:err})
  return requestError(c,500)
}
