import {errorFields} from './error-fields.js'
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
  await next()
  const durationMs=Math.round(performance.now()-start)
  if (c.res.status >= 400 || durationMs>=1000) {
    // A route pattern omits emails, phone numbers, webhook tokens and query parameters.
    const route = c.req.matchedRoutes.filter(r => r.path !== '/*' && r.path !== '*').at(-1)?.path ?? 'unmatched'
    console.warn(JSON.stringify({event:c.res.status>=400?'request_failed':'slow_request',durationMs,requestId:id,status:c.res.status,method:c.req.method,route}))
  }
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
    const retry=err.res?.headers.get('Retry-After')
    if(retry)c.header('Retry-After',retry)
    return requestError(c,err.status,err.message)
  }
  console.error(JSON.stringify({event:'unhandled_error',requestId:c.get('supportRequestId'),...errorFields(err)}))
  return requestError(c,500)
}
