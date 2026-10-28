const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net')
const {spawn,spawnSync}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises')
const root=__dirname,temp=fs.mkdtempSync(path.join(root,'.standby-test-')),fake=path.join(root,'fake-native.cjs')
const token='7'.repeat(64),tokenFile=path.join(temp,'token'),routeFile=path.join(temp,'route.json')
fs.writeFileSync(tokenFile,token)
fs.writeFileSync(routeFile,JSON.stringify({model:'DeepSeek-Flash',effort:'off',maxTokens:32000,contextWindow:200000,tools:[{name:'read_file'}]}))
const native=fs.readFileSync(path.join(root,'native-worker.mjs'),'utf8').replace('(this.spawnProcess || spawn)',`(this.spawnProcess || ((cli,args,opts)=>spawn(process.execPath,[${JSON.stringify(fake)},...args],opts)))`)
fs.writeFileSync(path.join(temp,'native-worker.mjs'),native)
const proxy=fs.readFileSync(path.join(root,'qoder-cli-proxy.mjs'),'utf8').replace('spawn(CLI, buildLaunchArgs(plan),',`spawn(process.execPath, [${JSON.stringify(fake)}, ...buildLaunchArgs(plan)],`)
fs.writeFileSync(path.join(temp,'qoder-cli-proxy.mjs'),proxy)
fs.copyFileSync(path.join(root,'bridge-support.mjs'),path.join(temp,'bridge-support.mjs'))
const headers={Authorization:'Bearer '+token,'Content-Type':'application/json','x-session-id':'same-session'}
const tools=[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}]
let server,base,log=''
async function post(messages,purpose='chat'){
 const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{...headers,'x-qcp-purpose':purpose},signal:AbortSignal.timeout(10000),body:JSON.stringify({model:'deepseek-flash',reasoning_effort:'off',max_tokens:32000,messages,tools})})
 const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.choices[0].message
}
async function main(){
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));base=`http://127.0.0.1:${port}`
 server=spawn(process.execPath,[path.join(temp,'qoder-cli-proxy.mjs'),'--port',String(port)],{cwd:temp,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,QCP_CLI:process.execPath,QCP_TOKEN_FILE:tokenFile,QCP_ROUTE_FILE:routeFile,QCP_MAX_WORKERS:'3',QCP_TIMEOUT:'5000',FAKE_MODE:'stream'}})
 server.stdout.on('data',c=>{log+=c});server.stderr.on('data',c=>{log+=c})
 for(let i=0;i<100;i++){try{const h=await(await fetch(base+'/healthz')).json();if(h.standby_ready)break}catch{}await delay(100);if(i===99)throw Error('standby unavailable '+log)}
 const messages=[{role:'system',content:'System A'},{role:'user',content:'First question'}]
 const first=await post(messages);assert.equal(first.content,'hello world')
 const title=await post(messages,'session-title');assert.equal(title.content,'hello world')
 const compact1=await post(messages,'compaction');assert.equal(compact1.content,'hello world')
 for(let i=0;i<50;i++){if((await(await fetch(base+'/healthz')).json()).compaction_standby)break;await delay(50);if(i===49)throw Error('compaction standby unavailable '+log)}
 const compact2=await post(messages,'compaction');assert.equal(compact2.content,'hello world')
 const second=await post([...messages,first,{role:'user',content:'Second question'}]);assert.equal(second.content,'hello world')
 await delay(100)
 assert.match(log,/mode=prestarted .*purpose=chat/,'first chat claims only the compatible unused standby')
 assert.match(log,/mode=cold .*purpose=session-title/,'auxiliary title does not consume the chat standby')
 assert.match(log,/mode=prestarted .*purpose=compaction/,'later compaction claims its own standby')
 assert.match(log,/mode=warm .*purpose=chat/,'title does not disrupt the hot chat')
 const saved=JSON.parse(fs.readFileSync(routeFile,'utf8'));assert.equal(saved.maxTokens,32000);assert.deepEqual(saved.tools,[{name:'read_file'}])
 console.log('PASS: uninitialized standby is claimed by matching chat, auxiliary title remains isolated, hot session continues')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{
 if(server?.pid&&server.exitCode===null)spawnSync('taskkill',['/pid',String(server.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'})
 const resolved=path.resolve(temp);if(resolved.startsWith(path.resolve(root)+path.sep)&&path.basename(resolved).startsWith('.standby-test-'))try{fs.rmSync(resolved,{recursive:true,force:true})}catch{}
})
