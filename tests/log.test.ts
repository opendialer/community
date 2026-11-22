import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'

function run(source: string, shipping=false) {
  return spawnSync(process.execPath, ['--import','tsx','--input-type=module','-e',source], {
    encoding:'utf8',timeout:10000,env:{...process.env,LOG_LEVEL:'info',LOG_SERVICE:'api',
      AXIOM_TOKEN:shipping?'test-token':'',AXIOM_DATASET:shipping?'test':'',AXIOM_URL:'https://synthetic.invalid'},
  })
}

test('log records keep support IDs, stable event names and redacted request context',()=>{
  const result=run(`
    import {log,withLogContext} from './src/log.ts'
    withLogContext({requestId:'support',password:'test-private',callerNumber:'+15550000000'},()=>{
      log.info('payment_attempt',{requestId:'ab88561a-cd24-454c-a2e8-33eeacfed538',event:'override',level:'error',
        nested:{checkoutUrl:'test-private',apiKeyValue:'test-private'},error:{detail:'test-private'}})
    })
  `)
  assert.equal(result.status,0,result.stderr)
  assert.doesNotMatch(result.stdout,/test-private|15550000000|override/)
  const row=JSON.parse(result.stdout)
  assert.equal(row.level,'info');assert.equal(row.event,'payment_attempt')
  assert.equal(row.requestId,'support');assert.equal(row.operationRequestId,'ab88561a-cd24-454c-a2e8-33eeacfed538')
})

test('shutdown flush waits for a batch already in flight',()=>{
  const result=run(`
    import {log,flushLogs} from './src/log.ts'
    let delivered=false
    globalThis.fetch=async()=>{await new Promise(r=>setTimeout(r,80));delivered=true;return Response.json({ingested:200,failed:0})}
    for(let i=0;i<200;i++)log.info('synthetic_sample',{index:i})
    await flushLogs()
    if(!delivered)process.exitCode=1
  `,true)
  assert.equal(result.status,0,result.stderr)
})

test('fatal unhandled rejections exit the service after writing one sanitized event',()=>{
  const result=run(`
    import {installFatalLogging} from './src/log.ts'
    installFatalLogging()
    void Promise.reject(new Error('test failure token=test-private'))
  `)
  assert.equal(result.status,1)
  assert.equal(JSON.parse(result.stderr).event,'unhandled_rejection')
  assert.doesNotMatch(result.stderr,/test-private/)
})

test('a partial ingest acknowledgement reports only counts and never replays accepted records',()=>{
  const result=run(`
    import {log,flushLogs} from './src/log.ts'
    const batches=[]
    globalThis.fetch=async(_url,options)=>{
      const events=options.body.split('\\n').map(line=>JSON.parse(line).event)
      batches.push(events)
      return Response.json(batches.length===1?{ingested:1,failed:1,failures:[{error:'test-private'}]}:{ingested:events.length,failed:0})
    }
    log.info('accepted');log.info('rejected');await flushLogs()
    if(JSON.stringify(batches)!==JSON.stringify([['accepted','rejected'],['log_events_dropped']]))process.exitCode=1
  `,true)
  assert.equal(result.status,0,result.stderr)
  assert.doesNotMatch(result.stdout,/test-private/)
  const warning=JSON.parse(result.stdout.trim().split('\n').at(-1)!)
  assert.equal(warning.reason,'ingest_events_rejected');assert.equal(warning.count,1)
})
