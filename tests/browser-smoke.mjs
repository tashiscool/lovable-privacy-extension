import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { submitNativePrompt } from '../native-prompt.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightPath = process.env.PLAYWRIGHT_MODULE;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_MODULE to an existing Playwright index.mjs path.');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)).href);
const output = path.resolve(process.env.UI_EVIDENCE_DIR || path.join(root, 'test-results', 'browser'));
await mkdir(output, { recursive: true });
const fixtureProject = 'https://lovable.dev/projects/11111111-1111-4111-8111-111111111111';
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const allowed = new Set(['sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'theme.css', 'privacy-policy.js', 'native-prompt.js']);
const server = createServer(async (req, res) => {
  try {
    const resource = new URL(req.url, 'http://127.0.0.1').pathname.slice(1);
    if (!allowed.has(resource) && !/^assets\/icon(?:16|32|48|128)\.png$/.test(resource)) {
      res.writeHead(404); res.end(); return;
    }
    const type = resource.endsWith('.html') ? 'text/html' : resource.endsWith('.css') ? 'text/css' : resource.endsWith('.png') ? 'image/png' : 'text/javascript';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Security-Policy', manifest.content_security_policy.extension_pages);
    res.end(await readFile(path.join(root, resource)));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [];

async function panelFixture(page, { connected = true, sendError = null, delayed = false } = {}) {
  await page.addInitScript(({ connected, sendError, delayed, project }) => {
    const local = {}, listeners = [];
    const history = { messages: [], local, sendError, connected, delayed, historyFailure: false };
    window.testFixture = history;
    const emit = (key, oldValue, newValue) => listeners.forEach(fn => fn({ [key]: { oldValue, newValue } }, 'local'));
    const finish = (value, callback) => { if (callback) callback(value); return Promise.resolve(value); };
    const area = {
      get(keys, callback) {
        const value = keys == null ? { ...local } : typeof keys === 'string' ? { [keys]: local[keys] } : Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys)).map(key => [key, local[key] ?? keys[key]]));
        return finish(value, callback);
      },
      set(values, callback) { for (const [key, value] of Object.entries(values)) { const old = local[key]; local[key] = value; emit(key, old, value); } return finish(undefined, callback); },
      remove(keys, callback) { for (const key of Array.isArray(keys) ? keys : [keys]) { const old = local[key]; delete local[key]; emit(key, old, undefined); } return finish(undefined, callback); },
      clear(callback) { for (const key of Object.keys(local)) delete local[key]; return finish(undefined, callback); },
    };
    window.chrome = {
      runtime: {
        id: 'synthetic-extension',
        sendMessage(message, callback) {
          history.messages.push(structuredClone(message));
          let reply;
          if (message.action === 'getStatus') reply = { ok: true, connected: history.connected, projectUrl: project, projectId: project.split('/').pop(), tabId: 1 };
          else if (message.action === 'sendPrompt') reply = history.sendError ? { ok: false, error: history.sendError } : { ok: true };
          else if (message.action === 'setSettings') {
            const old = local.privacySettings;
            local.privacySettings = { historyEnabled: false, theme: 'dark', ...old, ...message.settings };
            if (!local.privacySettings.historyEnabled) { const prior = local.privacyHistory; delete local.privacyHistory; emit('privacyHistory', prior, undefined); }
            emit('privacySettings', old, local.privacySettings); reply = { ok: true };
          }
          else if (message.action === 'clearHistory') { const old = local.privacyHistory; delete local.privacyHistory; emit('privacyHistory', old, undefined); reply = { ok: true }; }
          else if (message.action === 'forget') {
            for (const key of Object.keys(local)) { const old = local[key]; delete local[key]; emit(key, old, undefined); }
            history.connected = false;
            listeners.forEach(fn => fn({ privacyBindings: { oldValue: { 7: {} }, newValue: undefined } }, 'session'));
            reply = { ok: true };
          }
          else reply = { ok: false, error: 'Unknown action' };
          const complete = () => {
            if (message.action === 'sendPrompt' && reply.ok && local.privacySettings?.historyEnabled) {
              if (history.historyFailure) reply.historySaved = false;
              else {
                const old = local.privacyHistory;
                local.privacyHistory = [...(old || []), { prompt: message.prompt, timestamp: new Date().toISOString() }].slice(-20);
                emit('privacyHistory', old, local.privacyHistory);
              }
            }
            return reply;
          };
          if (history.delayed && message.action === 'sendPrompt') return new Promise(resolve => setTimeout(() => { const value=complete(); callback?.(value); resolve(value); }, 250));
          complete();
          return finish(reply, callback);
        },
      },
      storage: { local: area, onChanged: { addListener(fn) { listeners.push(fn); } } },
    };
  }, { connected, sendError, delayed, project: fixtureProject });
}

try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }, { name: 'narrow-panel', width: 320, height: 780 }]) {
    const page = await browser.newPage({ viewport });
    page.on('dialog', dialog => dialog.accept());
    const errors = [], outbound = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === base) return route.continue(); outbound.push(url.origin); return route.abort(); });
    await panelFixture(page, { delayed: true });
    await page.goto(base + '/sidepanel.html?windowId=7');
    await page.getByRole('textbox', { name: 'Prompt for the connected Lovable project' }).waitFor();
    await page.waitForFunction(() => document.getElementById('connection-label').textContent === 'Connected');
    const editor = page.locator('#prompt-input'), send = page.locator('#send-button');
    assert.equal(await send.isDisabled(), true, 'empty prompt cannot send');
    await editor.fill('Synthetic privacy test prompt');
    await send.click();
    assert.equal(await send.isDisabled(), true, 'send disabled while in flight');
    await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send to Lovable' && document.getElementById('prompt-input').value === '');
    const messages = await page.evaluate(() => window.testFixture.messages);
    assert.equal(messages.filter(m => m.action === 'sendPrompt').length, 1);
    assert.equal(await page.evaluate(() => window.testFixture.local.privacyHistory?.length || 0), 0, 'history off by default');
    await page.locator('#history-toggle').check();
    await editor.fill('<img src=x onerror=alert(1)> Synthetic text');
    await send.click();
    await page.waitForFunction(() => window.testFixture.local.privacyHistory?.length === 1);
    assert.equal(await page.locator('#history-list img').count(), 0, 'history is rendered as text');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, viewport.name + '.png'), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, viewport.name + ' has no page horizontal overflow');
    await page.locator('#history-toggle').uncheck();
    assert.equal(await page.evaluate(() => window.testFixture.local.privacyHistory?.length || 0), 0, 'opt-out deletes history');
    await editor.fill('Draft retained on error');
    await page.evaluate(() => { window.testFixture.sendError = 'Native chat is disabled.'; });
    await send.click();
    await page.waitForFunction(() => document.getElementById('feedback').textContent.includes('disabled'));
    assert.equal(await editor.inputValue(), 'Draft retained on error');
    await page.locator('#history-toggle').check();
    await page.evaluate(() => { window.testFixture.sendError = null; window.testFixture.historyFailure = true; });
    await editor.fill('Sent even when history cannot save');
    await send.click();
    await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send to Lovable' && document.getElementById('prompt-input').value === '');
    assert.match(await page.locator('#feedback').innerText(), /sent.*history/i, 'history error never misreports native send');
    await page.locator('#theme-toggle').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.locator('#forget-button').click();
    await page.waitForFunction(() => document.getElementById('prompt-input').value === '');
    assert.equal(await page.evaluate(() => Object.keys(window.testFixture.local).length), 0);
    assert.equal(await send.isDisabled(), true);
    await editor.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement !== document.body), true, 'keyboard focus remains visible on a control');
    assert.deepEqual(outbound, [], 'no external requests');
    assert.deepEqual(errors, [], 'no browser runtime errors');
    results.push({ viewport, passed: true, externalRequests: outbound.length, runtimeErrors: errors.length });
    await page.close();
  }
  const disconnected = await browser.newPage({ viewport: { width: 390, height: 844 } });
  disconnected.on('dialog', dialog => dialog.accept());
  await panelFixture(disconnected, { connected: false });
  await disconnected.goto(base + '/sidepanel.html?windowId=7');
  await disconnected.locator('#prompt-input').fill('Should not send');
  assert.equal(await disconnected.locator('#send-button').isDisabled(), true);
  await disconnected.screenshot({ path: path.join(output, 'disconnected.png'), fullPage: true });
  await disconnected.close();

  const unbound = await browser.newPage();
  unbound.on('dialog', dialog => dialog.accept());
  await panelFixture(unbound, { connected: false });
  await unbound.goto(base + '/sidepanel.html');
  await unbound.locator('#prompt-input').waitFor();
  await unbound.evaluate(() => { window.testFixture.local.legacyCredential = 'synthetic-marker'; });
  await unbound.locator('#forget-button').click();
  await unbound.waitForFunction(() => Object.keys(window.testFixture.local).length === 0);
  assert.deepEqual(await unbound.evaluate(() => window.testFixture.messages.filter(m=>m.action==='forget')), [{ action: 'forget' }]);
  await unbound.close();

  const native = await browser.newPage();
  const nativeHtml = `<!doctype html><html><body><form id="chat-input"><div contenteditable="true" aria-label="Prompt"></div><button type="submit" id="chatinput-send-message-button" disabled>Send</button></form><script>const form=document.getElementById('chat-input'),editor=form.querySelector('[contenteditable]'),button=form.querySelector('button'); editor.addEventListener('input',()=>{if(!window.keepDisabled)button.disabled=!editor.innerText.trim();});form.addEventListener('submit',e=>{e.preventDefault();window.submittedText=editor.innerText;window.submitCount=(window.submitCount||0)+1;});</script></body></html>`;
  await native.route('**/*', route => route.request().url().startsWith('https://lovable.dev/projects/') ? route.fulfill({ contentType: 'text/html', body: nativeHtml }) : route.abort());
  const invoke = async(prompt,expected=fixtureProject)=>native.evaluate(({source,expected,prompt})=>(0,eval)(`(${source})`)(expected,prompt),{source:submitNativePrompt.toString(),expected,prompt});
  await native.goto(fixtureProject);
  assert.deepEqual(await invoke('Native synthetic prompt'), { ok: true });
  assert.equal(await native.evaluate(()=>window.submittedText), 'Native synthetic prompt');
  assert.equal(await native.evaluate(()=>window.submitCount), 1);
  await native.goto(fixtureProject);
  await native.locator('[contenteditable]').fill('Existing user draft');
  assert.equal((await invoke('Replacement must fail')).ok, false);
  assert.equal(await native.locator('[contenteditable]').innerText(), 'Existing user draft');
  await native.goto(fixtureProject);
  await native.evaluate(()=>{window.keepDisabled=true;});
  assert.equal((await invoke('Must respect disabled controls')).ok, false);
  assert.equal(await native.evaluate(()=>window.submitCount||0), 0);
  await native.goto(fixtureProject);
  await native.evaluate(()=>{const other=document.querySelector('[contenteditable]').cloneNode(true);document.getElementById('chat-input').append(other);});
  assert.equal((await invoke('Ambiguous editor must fail')).ok, false);
  await native.goto(fixtureProject + '?token=synthetic-marker');
  assert.equal((await invoke('Changed URL must fail')).ok, false);
  await native.close();
  results.push({ scenario: 'native-editor-delivery', passed: true, cases: ['normal send','existing draft','disabled control','ambiguous editor','changed URL'] });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.length, output }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

const profile = await mkdtemp(path.join(tmpdir(), 'lovable-extension-smoke-'));
let extensionContext;
try {
  extensionContext = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  let worker=extensionContext.serviceWorkers()[0];
  if(!worker) worker=await extensionContext.waitForEvent('serviceworker',{timeout:15000});
  const extensionId=new URL(worker.url()).hostname;
  const panel=await extensionContext.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?windowId=7`);
  const tabStatus=await panel.evaluate(()=>chrome.runtime.sendMessage({action:'getStatus',windowId:7}));
  assert.equal(tabStatus.ok,false,'extension tabs cannot impersonate a privileged side panel');
  const rejected=await panel.evaluate(()=>chrome.runtime.sendMessage({action:'proxyFetch',url:'https://example.invalid'}));
  assert.equal(rejected.ok,false,'unknown privileged messages rejected in real extension');

  const windowId=await panel.evaluate(async()=> (await chrome.windows.getCurrent()).id);
  await panel.evaluate(async id=> {
    await chrome.sidePanel.setOptions({path:`sidepanel.html?windowId=${id}`,enabled:true});
    const button=document.createElement('button');
    button.id='open-synthetic-sidepanel'; button.textContent='Open test panel';
    button.addEventListener('click',()=>chrome.sidePanel.open({windowId:id}));
    document.body.append(button);
  },windowId);
  await panel.locator('#open-synthetic-sidepanel').click();
  const sideContexts=await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}));
  assert.equal(sideContexts.length,1,'actual browser side-panel context is open');
  const cdp=await extensionContext.browser().newBrowserCDPSession();
  const {targetInfos}=await cdp.send('Target.getTargets');
  const target=targetInfos.find(info=>info.url===sideContexts[0].documentUrl);
  assert.ok(target,'side-panel browser target exists');
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
  let commandId=0;
  async function sideEvaluate(expression){
    const id=++commandId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{cdp.off('Target.receivedMessageFromTarget',received);reject(new Error('Side-panel evaluation timeout'));},5000);
      const received=event=>{
        if(event.sessionId!==sessionId)return;
        const result=JSON.parse(event.message);if(result.id!==id)return;
        clearTimeout(timer);cdp.off('Target.receivedMessageFromTarget',received);
        if(result.error||result.result?.exceptionDetails)reject(new Error(JSON.stringify(result.error||result.result.exceptionDetails)));
        else resolve(result.result?.result?.value);
      };
      cdp.on('Target.receivedMessageFromTarget',received);
      cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}})}).catch(error=>{clearTimeout(timer);cdp.off('Target.receivedMessageFromTarget',received);reject(error);});
    });
  }
  assert.deepEqual(await sideEvaluate(`chrome.runtime.sendMessage({action:'getStatus',windowId:${windowId}})`),{ok:true,connected:false},'actual side-panel sender is trusted; no target is implicitly selected');
  await sideEvaluate("chrome.storage.local.set({legacyCredential:'synthetic-marker'})");
  assert.deepEqual(await sideEvaluate("chrome.runtime.sendMessage({action:'forget'})"),{ok:true});
  assert.deepEqual(await sideEvaluate('chrome.storage.local.get(null)'),{});
  assert.equal(await sideEvaluate("fetch('https://example.invalid').then(()=>false).catch(()=>true)"),true,'real extension CSP blocks external network calls');
  await cdp.send('Target.detachFromTarget',{sessionId});
  console.log(JSON.stringify({scenario:'real-mv3-extension',passed:true,cases:['worker loads','tab sender rejected','real panel sender accepted','global data clear','CSP blocks external connection']}));
} finally {
  await extensionContext?.close();
  await rm(profile,{recursive:true});
}
