import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, test} from 'node:test'
import {OpenAPIHono} from '@hono/zod-openapi'
import {pool} from '../src/db.js'
import {registerAccounts} from '../src/identity/accounts.js'
import {deliverIdentityEmail} from '../src/identity/mail.js'

after(() => pool.end())

test('register, verify email, log in and revoke a session', async () => {
  const app = new OpenAPIHono()
  registerAccounts(app)
  const email = randomUUID() + '@example.test'
  const password = 'A sufficiently long test passphrase'
  const post = (path: string, body: object) => app.request('/v1/auth/' + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  })
  assert.equal((await post('register', {email})).status, 202)
  let code = ''
  assert.ok(await deliverIdentityEmail(async (_url, options) => {
    const message = JSON.parse(String(options?.body))
    assert.equal(message.to[0], email)
    code = message.text.split('\n').at(-1)
    return Response.json({id: randomUUID()})
  }))
  assert.equal((await post('verify-email', {code, password})).status, 200)
  const login = await post('login', {email, password})
  assert.equal(login.status, 200)
  const headers = {Authorization: 'Bearer ' + (await login.json()).accessToken}
  assert.equal((await app.request('/v1/auth/me', {headers})).status, 200)
  assert.equal((await app.request('/v1/auth/logout', {method: 'POST', headers})).status, 200)
  assert.equal((await app.request('/v1/auth/me', {headers})).status, 401)
})
