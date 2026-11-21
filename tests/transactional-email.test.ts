import assert from 'node:assert/strict'
import test from 'node:test'
import { transactionalEmail } from '../src/email/transactional.js'

test('transactional email escapes customer text, preserves links and supplies a readable text alternative', () => {
  const action = {label:'Accept Invitation',url:new URL('https://example.test/accept#code=abc')}
  const message = {heading:'Team Invitation',description:'Join <Ops> & "Sales".',code:'abc',action}
  const {text,html} = transactionalEmail(message)
  assert.ok(text.includes(message.description) && text.endsWith(message.code))
  assert.ok(html.includes('Join &lt;Ops&gt; &amp; &quot;Sales&quot;.'))
  assert.ok(html.includes('href="'+action.url.href+'"'))
  assert.ok(html.includes('#1E1E20') && html.includes('#0A84FF') && html.includes('font-size:13px'))
  assert.equal(html.match(/<a /g)?.length,1)
  assert.throws(()=>transactionalEmail({...message,action:{...action,url:new URL('javascript:void(0)')}}))
})
