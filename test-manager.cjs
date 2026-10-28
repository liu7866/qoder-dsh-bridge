const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { spawn } = require('node:child_process')
if (process.platform !== 'win32') { console.log('SKIP: Windows model manager'); process.exit(0) }
const root = __dirname, dir = fs.mkdtempSync(path.join(root, '.manager-test-')), token = 'd'.repeat(64)
const authDir = path.join(dir, '.dsh', 'qoder-bridge-v2'); fs.mkdirSync(authDir, { recursive: true }); fs.writeFileSync(path.join(authDir, 'token'), token)
const server = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer ' + token)
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'auto' }, { id: 'deepseek-flash' }] }))
})
server.listen(0, '127.0.0.1', () => {
  const script = fs.readFileSync(path.join(root, 'model-manager.ps1'), 'utf8').replace('http://127.0.0.1:18082/v1/models', `http://127.0.0.1:${server.address().port}/v1/models`)
  const scriptPath = path.join(dir, 'manager.ps1'); fs.writeFileSync(scriptPath, script, 'utf8')
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { env: { ...process.env, USERPROFILE: dir }, windowsHide: true })
  let output = ''; child.stdout.on('data', x => output += x.toString('utf8')); child.stderr.on('data', x => output += x.toString('utf8'))
  child.stdin.end('2\nS\n')
  child.on('close', code => {
    try {
      assert.equal(code, 0, output)
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(authDir, 'model-visibility.json'), 'utf8')).hidden_models, ['deepseek-flash'])
      assert(!output.includes(token)); console.log('PASS: model manager saves the selected hidden model without revealing the token')
    } catch (error) { console.error(error); process.exitCode = 1 }
    finally { server.close(); const resolved = path.resolve(dir); if (resolved.startsWith(path.resolve(root) + path.sep) && path.basename(resolved).startsWith('.manager-test-')) fs.rmSync(resolved, { recursive: true, force: true }) }
  })
})
