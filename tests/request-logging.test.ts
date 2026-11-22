import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import test from 'node:test'

test('a client can correlate its request without exposing the request path or query', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {Hono} from 'hono'
    import {traceRequest} from './src/request-errors.ts'
    const app = new Hono()
    app.use('*', traceRequest)
    app.get('/lookup/:code', c => c.json({ok: true}))
    const response = await app.request('/lookup/test-customer-code?email=customer@example.test')
    process.stdout.write(JSON.stringify({sentId: response.headers.get('x-request-id')}) + '\\n')
  `], {encoding:'utf8', env:{...process.env, AXIOM_TOKEN:'', AXIOM_DATASET:'', LOG_LEVEL:'info'}})
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split('\n').map(row => JSON.parse(row))
  const completed = lines.find(row => row.event === 'request_completed')
  assert.equal(completed.route, '/lookup/:code')
  assert.equal(completed.status, 200)
  assert.match(completed.requestId, /^[a-f0-9-]{36}$/)
  assert.equal(completed.requestId, lines.find(row => row.sentId).sentId)
  assert.doesNotMatch(result.stdout, /test-customer-code|customer@example\.test/)
})
