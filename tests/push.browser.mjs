import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import assert from 'node:assert/strict';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
await mkdir('.tools', { recursive: true });
const origin = 'https://voxacode.online';
const scheduledTask = process.argv.includes('--scheduled');
const imported = process.argv.includes('--imported');
const profile = await mkdtemp(join(tmpdir(), 'voxa-push-e2e-'));
const chrome = spawn(
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--host-resolver-rules=MAP voxacode.online 10.40.50.200',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let ws,
  command,
  session,
  stage = 'launch';
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      break;
    } catch {
      await delay(300);
    }
  }
  assert.ok(port, 'Chrome debugger starts');
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = waiting.get(m.id);
      waiting.delete(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
  };
  command = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        waiting.delete(n);
        reject(Error(`Timed out: ${method}`));
      }, 65000);
      waiting.set(n, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const evaluate = async (expression, target = session) => {
    const r = await command(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      target,
    );
    if (r.exceptionDetails)
      throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async (expression, seconds = 45) => {
    for (let i = 0; i < seconds * 4; i++) {
      if (await evaluate(expression)) return;
      await delay(250);
    }
    throw Error('Condition timed out: ' + expression);
  };
  await command('Browser.grantPermissions', { origin, permissions: ['notifications'] });
  const created = await command('Target.createTarget', { url: 'about:blank' });
  session = (await command('Target.attachToTarget', { targetId: created.targetId, flatten: true }))
    .sessionId;
  await command('Page.enable', {}, session);
  await command(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `if(!localStorage.getItem('voxa.push.qa')){localStorage.setItem('voxa.push.qa','true');${imported ? '' : "localStorage.setItem('voicetask.entries.v1','[]');localStorage.setItem('voicetask.import.bundled.v1','qa');"}localStorage.setItem('voicetask.preferences.v2',JSON.stringify({zone:'Europe/Moscow',enabled:false,background:false,daily:false,lead:5}));}`,
    },
    session,
  );
  await command('Page.navigate', { url: origin + '/VoiceTask/' }, session);
  await wait(`document.readyState==='complete'&&!!document.querySelector('h1')`);
  if (imported)
    await wait(`JSON.parse(localStorage.getItem('voicetask.entries.v1')||'[]').length>=1000`);
  stage = 'settings';
  await evaluate(`document.querySelector('[aria-label="Настройки"]').click()`);
  await delay(200);
  await evaluate(
    `Array.from(document.querySelectorAll('.settings-sidebar button')).find(b=>b.textContent.includes('Уведомления')).click()`,
  );
  await delay(300);
  console.log(
    JSON.stringify({
      stage,
      permission: await evaluate('Notification.permission'),
      pushSupported: await evaluate(`'PushManager' in window`),
    }),
  );
  stage = 'subscribe';
  await evaluate(`document.querySelector('[aria-label="Фоновые уведомления"]').click()`);
  await wait(
    `document.querySelector('.background-reminders')?.textContent.includes('Запланировано:')||!!document.querySelector('.background-reminders [role=alert]')`,
    60,
  );
  const subscriptionError = await evaluate(
    `document.querySelector('.background-reminders [role=alert]')?.textContent||''`,
  );
  assert.equal(subscriptionError, '');
  const scheduledCount = await evaluate(
    `Number(document.querySelector('.background-reminders [role=status]').textContent.match(/Запланировано: (\\d+)/)?.[1]||0)`,
  );
  assert.ok(
    imported ? scheduledCount > 0 : scheduledCount === 0,
    'the complete calendar is scheduled',
  );
  if (imported) {
    const count = await evaluate(`JSON.parse(localStorage.getItem('voicetask.entries.v1')).length`);
    console.log(
      JSON.stringify({ stage: 'imported-calendar', records: count, scheduled: scheduledCount }),
    );
    await evaluate(
      `window.qaFetch=window.fetch.bind(window);window.fetch=(url,options)=>String(url).endsWith('/api/push-reminders')&&options?.body&&JSON.parse(options.body).action==='sync'?Promise.resolve(Response.json({error:'Некорректное напоминание.'},{status:400})):window.qaFetch(url,options);document.querySelector('[data-setting="lead"] input[value="15"]').click();`,
    );
    await wait(
      `document.querySelector('.background-reminders [role=alert]')?.textContent.includes('Некорректное напоминание')`,
    );
    assert.ok(
      await evaluate(
        `!Array.from(document.querySelectorAll('.background-reminders button')).find(b=>b.textContent==='Разрешить уведомления')`,
      ),
      'a schedule error does not request notification permission again',
    );
    assert.ok(
      await evaluate(
        `!Array.from(document.querySelectorAll('.background-reminders button')).find(b=>b.textContent==='Проверить уведомление').disabled`,
      ),
      'the test button remains available with permission',
    );
    await evaluate(
      `window.fetch=window.qaFetch;document.querySelector('[data-setting="lead"] input[value="5"]').click();`,
    );
    await wait(
      `document.querySelector('.background-reminders')?.textContent.includes('Запланировано: ${scheduledCount}')&&!document.querySelector('.background-reminders [role=alert]')`,
    );
  }
  await writeFile(
    '.tools/push-settings.png',
    Buffer.from(
      (await command('Page.captureScreenshot', { format: 'png' }, session)).data,
      'base64',
    ),
  );
  console.log(JSON.stringify({ stage, subscribed: true }));
  let dueAt = Date.now() + 6000;
  if (scheduledTask) {
    stage = 'schedule-calendar-task';
    dueAt = Math.ceil((Date.now() + 15000) / 60000) * 60000;
    await evaluate(
      `(()=>{const start=${dueAt}+300000;const parts=Object.fromEntries(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(start)).map(p=>[p.type,p.value]));const previous=${imported}?JSON.parse(localStorage.getItem('voicetask.entries.v1')):[];localStorage.setItem('voicetask.entries.v1',JSON.stringify([...previous,{id:${imported}? 'csv:qa-push' : crypto.randomUUID(),title:'Тест фоновой задачи',type:'task',date:parts.year+'-'+parts.month+'-'+parts.day,time:parts.hour+':'+parts.minute,duration:0,atTime:true,startAt:new Date(start).toISOString(),color:'#ddd8f5',description:'',important:false,completed:false}]));})()`,
    );
    await command('Page.reload', {}, session);
    await wait(`document.readyState==='complete'&&!!document.querySelector('h1')`);
    await evaluate(`document.querySelector('[aria-label="Настройки"]').click()`);
    await delay(200);
    await evaluate(
      `Array.from(document.querySelectorAll('.settings-sidebar button')).find(b=>b.textContent.includes('Уведомления')).click()`,
    );
    await wait(
      `document.querySelector('.background-reminders')?.textContent.includes('Запланировано: ${scheduledCount + 1}')`,
    );
    console.log(JSON.stringify({ stage, scheduled: scheduledCount + 1 }));
  } else {
    stage = 'schedule-test';
    await evaluate(
      `Array.from(document.querySelectorAll('.background-reminders button')).find(b=>b.textContent==='Проверить уведомление').click()`,
    );
    await wait(
      `document.querySelector('.background-reminders')?.textContent.includes('Тестовое уведомление запланировано')`,
    );
  }
  const closedAt = await evaluate('Date.now()');
  await command('Target.closeTarget', { targetId: created.targetId });
  const remaining = (await command('Target.getTargets')).targetInfos.filter(
    (t) => t.type === 'page' && t.url.startsWith(origin),
  );
  assert.equal(remaining.length, 0, 'all app tabs are closed');
  stage = 'background-delivery';
  console.log(JSON.stringify({ stage, appTabs: 0 }));
  await delay(scheduledTask ? Math.max(15000, dueAt - Date.now() + 15000) : 20000);
  const reopened = await command('Target.createTarget', { url: 'about:blank' });
  session = (await command('Target.attachToTarget', { targetId: reopened.targetId, flatten: true }))
    .sessionId;
  await command('Page.enable', {}, session);
  await command(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: 'window.qaOpenedAt=Date.now();' },
    session,
  );
  await command('Page.navigate', { url: origin + '/VoiceTask/' }, session);
  await wait(`document.readyState==='complete'&&!!document.querySelector('h1')`);
  const receipt = await evaluate(
    `(async()=>{const cache=await caches.open('voxa-push-delivered-v1');const keys=await cache.keys();const rows=await Promise.all(keys.map(async key=>(await cache.match(key)).json()));const registration=await navigator.serviceWorker.ready;const notifications=await registration.getNotifications();return {rows,openedAt:window.qaOpenedAt,titles:notifications.map(n=>n.title),entryIds:notifications.map(n=>n.data?.entryId)};})()`,
  );
  assert.ok(
    receipt.rows.some((row) => row.at >= closedAt && row.at < receipt.openedAt),
    'push was displayed while all app tabs were closed',
  );
  if (scheduledTask) assert.ok(receipt.titles.includes('Тест фоновой задачи'));
  if (scheduledTask && imported) assert.ok(receipt.entryIds.includes('csv:qa-push'));
  console.log(
    JSON.stringify({
      stage: scheduledTask
        ? 'CALENDAR_BACKGROUND_DELIVERY_CONFIRMED'
        : 'BACKGROUND_DELIVERY_CONFIRMED',
      receipts: receipt.rows.length,
      visibleNotifications: receipt.titles.length,
    }),
  );
  stage = 'cleanup';
  await evaluate(
    `(async()=>{await fetch('./api/push-reminders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:localStorage.getItem('voicetask.reminders.owner.v1'),token:localStorage.getItem('voicetask.push.token.v1'),action:'disable'})});const r=await navigator.serviceWorker.ready;const s=await r.pushManager.getSubscription();await s?.unsubscribe();for(const n of await r.getNotifications())n.close();})()`,
  );
} catch (error) {
  console.error('FAILED_STAGE', stage, error.message);
  if (session && command) {
    try {
      await writeFile(
        '.tools/push-failure.png',
        Buffer.from(
          (await command('Page.captureScreenshot', { format: 'png' }, session)).data,
          'base64',
        ),
      );
    } catch {}
  }
  process.exitCode = 1;
} finally {
  if (command)
    try {
      await command('Browser.close');
    } catch {}
  ws?.close();
  chrome.kill();
  if (basename(profile).startsWith('voxa-push-e2e-'))
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
