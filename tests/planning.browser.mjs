import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const url = process.env.VOICETASK_URL || 'http://127.0.0.1:4173/VoiceTask/';
const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch((error) => {
  throw Error(`UI server is unavailable at ${url}. Start Vite before running browser checks.`, {
    cause: error,
  });
});
assert.ok(response.ok, `UI server returned HTTP ${response.status} at ${url}`);
let executable =
  process.env.CHROME_PATH ||
  process.env.EDGE_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined);
if (!executable) {
  for (const root of [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA,
  ].filter(Boolean)) {
    for (const browser of [
      'Microsoft/Edge/Application/msedge.exe',
      'Google/Chrome/Application/chrome.exe',
    ]) {
      const candidate = join(root, browser);
      try {
        await access(candidate);
        executable = candidate;
        break;
      } catch {}
    }
    if (executable) break;
  }
}
assert.ok(executable, 'Install Edge or Chrome, or set CHROME_PATH or EDGE_PATH.');
await mkdir('.tools', { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'voicetask-browser-'));
const chrome = spawn(
  executable,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { windowsHide: true, stdio: 'ignore' },
);
let ws, command, ev, launchError;
chrome.on('error', (error) => {
  launchError = error;
});
try {
  let target;
  for (let i = 0; i < 40; i++) {
    if (launchError) throw launchError;
    try {
      const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      target = await (
        await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      ).json();
      break;
    } catch {
      await delay(250);
    }
  }
  assert.ok(target, `${executable} started with remote debugging`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiting = new Map(),
    errors = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? p?.reject(m.error) : p?.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
  };
  ws.onclose = () => {
    for (const pending of waiting.values()) pending.reject(Error('Browser disconnected.'));
    waiting.clear();
  };
  command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timeout = setTimeout(() => {
        waiting.delete(i);
        reject(Error(`Browser command timed out: ${method}`));
      }, 15000);
      waiting.set(i, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  ev = async (expression) => {
    const r = await command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const waitFor = async (expression, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (await ev(expression)) return;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw Error(`Browser condition timed out: ${expression}`, { cause: lastError });
  };
  const click = async (selector) => {
    assert.ok(
      await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true;})()`,
      ),
      selector,
    );
    await delay(160);
  };
  const text = async (text) => {
    assert.ok(
      await ev(
        `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)return false;e.click();return true;})()`,
      ),
      text,
    );
    await delay(160);
  };
  const fill = async (selector, value) => {
    assert.ok(
      await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true;})()`,
      ),
      selector,
    );
    await delay(220);
  };
  const label = async (name, value) => {
    const groups = {
      Тема: 'theme',
      'Размер текста': 'text',
      'Подробность карточек': 'density',
      'Режим при следующем открытии': 'defaultPeriod',
    };
    if (
      groups[name] &&
      (await ev(`!!document.querySelector('[data-setting="${groups[name]}"]')`))
    ) {
      await click(`[data-setting="${groups[name]}"] input[value="${value}"]`);
      return;
    }
    const selector = await ev(
      `(()=>{const e=[...document.querySelectorAll('.modal label')].find(e=>e.firstChild?.textContent.trim()===${JSON.stringify(name)})?.querySelector('input,select,textarea');if(!e)throw Error('Missing field '+${JSON.stringify(name)});e.id='test-field';return '#test-field';})()`,
    );
    await fill(selector, value);
    await ev(`document.querySelector('#test-field').removeAttribute('id')`);
  };
  const check = async (name) => {
    await ev(
      `(()=>{const e=[...document.querySelectorAll('.modal input[type=checkbox]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}||e.closest('label')?.textContent.trim()===${JSON.stringify(name)});if(!e)throw Error('Missing checkbox');e.click();})()`,
    );
    await delay(150);
  };
  const stored = () => ev(`JSON.parse(localStorage.getItem('voicetask.entries.v1'))`);
  const close = () => click('[aria-label="Закрыть"]');
  const captureModal = async (name) => {
    const clip = await ev(
      `(()=>{const r=document.querySelector('.modal').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()`,
    );
    await writeFile(
      `.tools/${name}.png`,
      Buffer.from(
        (await command('Page.captureScreenshot', { format: 'png', clip })).data,
        'base64',
      ),
    );
  };
  const reload = async () => {
    const previous = await ev('performance.timeOrigin');
    await command('Page.reload');
    await waitFor(
      `performance.timeOrigin!==${previous}&&document.readyState==='complete'&&!!document.querySelector('h1')&&!!document.documentElement.dataset.theme`,
    );
  };
  await command('Runtime.enable');
  await command('Page.enable');

  const fixture = [
    {
      id: 'meeting-a',
      title: 'Встреча с командой',
      type: 'meeting',
      date: '2026-10-28',
      time: '09:00',
      duration: 60,
      color: '#d8eae2',
      important: false,
      description: '',
    },
    {
      id: 'meeting-b',
      title: 'Встреча с клиентом',
      type: 'meeting',
      date: '2026-10-28',
      time: '13:00',
      duration: 60,
      color: '#d8eae2',
      important: false,
      description: '',
    },
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `t-${i}`,
      title: `Задача ${i + 1}`,
      type: 'task',
      date: '2026-10-28',
      time: `${11 + i}:00`,
      duration: 30,
      color: '#ddd8f5',
      important: i === 4,
      description: '',
      completed: false,
    })),
    {
      id: 'future-day',
      title: 'Задача на выбранный день',
      type: 'task',
      date: '2027-06-14',
      time: '15:00',
      duration: 60,
      color: '#ddd8f5',
      important: true,
      description: '',
      completed: false,
    },
    {
      id: 'done',
      title: 'Уже готово',
      type: 'task',
      date: '2026-10-28',
      time: '08:00',
      duration: 30,
      color: '#ddd8f5',
      important: false,
      description: '',
      completed: true,
    },
  ];
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    const NativeDate=Date, offset=NativeDate.parse('2026-10-28T05:00:00Z')-NativeDate.now();
    window.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[NativeDate.now()+offset]));} static now(){return NativeDate.now()+offset;}};
    if(!sessionStorage.getItem('planning-init')){
      for(const key of ['voicetask.import.bundled.v1','voicetask.records.updated-2026-10-20.v1','voicetask.entries.at-time.v2'])localStorage.setItem(key,'test-fixture');
      localStorage.setItem('voicetask.entries.v1',${JSON.stringify(JSON.stringify(fixture))});
      localStorage.setItem('voicetask.preferences.v2',JSON.stringify({zone:'Europe/Moscow',enabled:false}));
      sessionStorage.setItem('planning-init','yes');
    }
    const realFetch=window.fetch.bind(window);
    window.fetch=(input,options)=>{
      if(!String(input).endsWith('/api/assistant'))return realFetch(input,options);
      if(!options?.method||options.method==='GET')return Promise.resolve(Response.json({configured:true,model:'test-provider'}));
      const body=JSON.parse(options.body);
      window.lastPlanningRequest=body;
      const day=body.text.match(/\\d{4}-\\d{2}-\\d{2}/)?.[0]||'2026-10-28';
      const command=body.text.includes('ерестрой')
        ? {intent:'plan_day',start:day,priorities:body.entries.filter(e=>e.type==='task'&&!e.completed&&e.date===day).sort((a,b)=>Number(b.important)-Number(a.important)).map(e=>e.id)}
        : {intent:'create_batch',items:[
          {type:'task',fields:{title:'Закончить презентацию',date:'2026-10-29',deadline:'2026-10-29',important:true}},
          {type:'task',fields:{title:'Сдать проект',date:'2026-10-30',deadline:'2026-10-30'}},
          {type:'task',fields:{title:'Сходить за продуктами'}},
          {type:'task',fields:{title:'Позвонить маме'}},
          {type:'task',fields:{title:'Подготовиться к экзамену'}}]};
      return Promise.resolve(Response.json({command}));
    };
  `,
  });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await command('Page.navigate', { url });
  await waitFor(`!!document.querySelector('h1')`);
  const send = async (value) => {
    await fill('[aria-label="Сообщение ассистенту"]', value);
    await click('[aria-label="Отправить сообщение"]');
    await waitFor(`!document.querySelector('.chat-request-status')`);
  };
  const latest = () =>
    ev(`document.querySelector('.messages').lastElementChild.previousElementSibling.innerText`);
  const planButton = async (value) => {
    await ev(
      `(()=>{const b=[...document.querySelectorAll('.plan-actions button')].find(b=>!b.disabled&&b.textContent===${JSON.stringify(value)});if(!b)throw Error('Missing active plan button');b.click();})()`,
    );
    await delay(220);
  };
  const dump =
    'Мне завтра нужно закончить презентацию, в пятницу сдать проект, ещё надо сходить за продуктами, позвонить маме и подготовиться к экзамену';
  await send(dump);
  assert.deepEqual(await stored(), fixture, 'a preview never mutates the calendar');
  assert.match(await latest(), /Позвонить маме/);
  assert.match(await latest(), /Дата предложена/);
  assert.equal(
    await ev(`document.querySelectorAll('.plan-actions button:not(:disabled)').length`),
    2,
  );
  await planButton('Отмена');
  assert.deepEqual(await stored(), fixture, 'cancellation leaves everything intact');
  await send('ВОКСА, ' + dump);
  await planButton('Применить план');
  assert.equal((await stored()).length, fixture.length + 5);
  await click('[aria-label="Отменить последнее действие"]');
  assert.deepEqual(await stored(), fixture, 'one undo cancels the entire batch');

  await send('Перестрой мой день так, чтобы я закончил самое важное');
  assert.deepEqual(await stored(), fixture);
  assert.match(await latest(), /было:/);
  assert.equal(await ev(`window.lastPlanningRequest.entries.find(e=>e.id==='t-4').duration`), 30);
  await planButton('Применить план');
  const replanned = await stored();
  assert.equal(replanned.find((e) => e.id === 't-4').time, '10:00');
  assert.deepEqual(
    replanned.find((e) => e.id === 'meeting-a'),
    fixture[0],
  );
  assert.deepEqual(
    replanned.find((e) => e.id === 'meeting-b'),
    fixture[1],
  );
  assert.deepEqual(
    replanned.find((e) => e.id === 'done'),
    fixture.at(-1),
  );
  await click('[aria-label="Отменить последнее действие"]');
  assert.deepEqual(await stored(), fixture);

  // Choose a day beyond the old two-week limit, with that day's tasks as AI context.
  await text('Перестроить день');
  await fill('[aria-label="Дата перепланирования"]', '2027-06-14');
  await text('Предложить план');
  await waitFor(`!document.querySelector('.chat-request-status')`);
  assert.equal(await ev(`window.lastPlanningRequest.calendar.start`), '2027-06-14');
  assert.ok(await ev(`window.lastPlanningRequest.entries.some(e=>e.id==='future-day')`));
  assert.deepEqual(await stored(), fixture, 'selected-day preview has no writes');
  await planButton('Применить план');
  assert.equal((await stored()).find((e) => e.id === 'future-day').time, '09:00');
  assert.deepEqual(
    (await stored()).filter((e) => e.date === '2026-10-28'),
    fixture.filter((e) => e.date === '2026-10-28'),
  );
  await click('[aria-label="Отменить последнее действие"]');
  assert.deepEqual(await stored(), fixture);
  await text('Перестроить день');
  assert.equal(
    await ev(`document.querySelector('[aria-label="Дата перепланирования"]').value`),
    '2027-06-14',
    'picker defaults to the selected calendar day',
  );
  await click('#planning-day-picker button[type="button"]');

  // A real completion through the UI must record time, including after reload.
  await fill('[aria-label="Поиск записей"]', 'Задача 1');
  await waitFor(`!!document.querySelector('.search-results button')`);
  await click('.search-results button');
  await check('Выполнено');
  const completed = (await stored()).find((e) => e.id === 't-0');
  assert.equal(completed.completed, true);
  assert.ok(completed.completedAt);
  await close();
  await click('[aria-label="Аналитика выполнения задач"]');
  assert.match(await ev(`document.querySelector('.analytics-panel').innerText`), /Среда/);
  assert.equal(await ev(`document.querySelectorAll('.analytics-table tbody tr').length`), 7);
  assert.equal(await ev(`document.querySelector('.analytics-details').open`), false);
  assert.match(
    await ev(`document.querySelector('.analytics-panel').innerText`),
    /Пока мало данных/,
  );
  assert.ok(
    !(await ev(`document.querySelector('.analytics-panel').innerText`)).includes(
      'Старые отметки без даты',
    ),
  );
  await captureModal('planning-analytics');
  await close();
  await reload();
  assert.equal((await stored()).find((e) => e.id === 't-0').completedAt, completed.completedAt);
  await send('Покажи недельный отчёт по выполнению задач');
  assert.match(await latest(), /Отчёт за/);
  assert.match(await latest(), /Среда: завершено 1/);

  // Reuse a plan with an intervening calendar change: an external write is caught by commit.
  await ev(
    `window.fetch=async(input,options)=>{if(!String(input).endsWith('/api/assistant'))throw Error('unexpected API');return Response.json(!options?.method?{configured:true,model:'test'}:{command:{intent:'plan_day',start:'2026-10-28',priorities:['t-4','t-1','t-2','t-3']}});}`,
  );
  await send('Перестрой расписание на сегодня');
  const beforeExternal = await stored();
  const external = [
    ...beforeExternal,
    { ...fixture[2], id: 'external', title: 'В другой вкладке' },
  ];
  await ev(
    `localStorage.setItem('voicetask.entries.v1',${JSON.stringify(JSON.stringify(external))})`,
  );
  await planButton('Применить план');
  assert.deepEqual(await stored(), external);
  assert.match(await latest(), /не сохранена/);
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await delay(150);
  assert.ok(
    await ev(`document.documentElement.scrollWidth<=innerWidth`),
    'no mobile horizontal overflow',
  );
  await click('[aria-label="Аналитика выполнения задач"]');
  await captureModal('planning-analytics-mobile');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log(
    'Planning browser checks passed: batch preview/cancel/confirm/undo; AI calendar context; day reshuffle/undo; arbitrary selected dates; fixed meetings; completion timestamp/reload; weekly analytics; stale cross-tab protection; desktop/mobile.',
  );
} catch (error) {
  if (ev) {
    try {
      console.error(
        'Browser failure state:',
        await ev(
          `({url:location.href,title:document.title,search:document.querySelector('[aria-label="Поиск записей"]')?.value,records:localStorage.getItem('voicetask.entries.v1'),body:document.body.innerText.slice(0,5000)})`,
        ),
      );
      await writeFile(
        '.tools/browser-failure.png',
        Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
      );
    } catch {}
  }
  throw error;
} finally {
  if (ws?.readyState === WebSocket.OPEN) await command('Browser.close').catch(() => {});
  ws?.close();
  chrome.kill();
  if (
    resolve(dirname(profile)) === resolve(tmpdir()) &&
    basename(profile).startsWith('voicetask-browser-')
  ) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
      () => {},
    );
  }
}
