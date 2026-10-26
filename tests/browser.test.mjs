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
let executable = process.env.CHROME_PATH || process.env.EDGE_PATH;
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
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `const realFetch=window.fetch.bind(window);window.fetch=(input,options)=>String(input).endsWith('/api/assistant')&&(!options?.method||options.method==='GET')?Promise.resolve(new Response(JSON.stringify({configured:false,model:'test-local'}),{headers:{'Content-Type':'application/json'}})):realFetch(input,options);`,
  });
  await command('Page.bringToFront');
  const fixture = [
    {
      id: 'legacy',
      title: 'Старая запись',
      type: 'task',
      date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      time: '23:00',
      duration: 180,
      color: '#123abc',
      important: true,
      description: 'Совместимость комментария',
      completed: false,
    },
    { id: 'unknown', newFormat: true },
  ];
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `if(location.origin===${JSON.stringify(new URL(url).origin)}&&!sessionStorage.getItem('v2-test-init')){localStorage.setItem('voicetask.import.bundled.v1','test-fixture');localStorage.setItem('voicetask.records.updated-2026-10-20.v1','test-fixture');localStorage.setItem('voicetask.entries.at-time.v2','test-fixture');localStorage.setItem('voicetask.entries.v1',${JSON.stringify(JSON.stringify(fixture))});localStorage.setItem('voicetask.preferences.v2',JSON.stringify({zone:'Europe/Moscow',enabled:false}));localStorage.setItem('voicetask.chat.v1',JSON.stringify([{role:'assistant',text:'Старая история чата'}]));sessionStorage.setItem('v2-test-init','yes');}`,
  });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const navigation = await command('Page.navigate', { url });
  assert.equal(
    navigation.errorText,
    undefined,
    `Cannot navigate to ${url}: ${navigation.errorText}`,
  );
  await delay(800);
  for (let i = 0; i < 50 && !(await ev(`!!document.querySelector('h1')`)); i++) await delay(200);
  assert.ok(await ev(`!!document.querySelector('h1')`), `Application did not load at ${url}`);
  if (errors.length) throw Error(JSON.stringify(errors));
  assert.equal(await ev(`document.querySelector('h1').textContent`), 'Ваш календарь.');
  assert.equal(await ev(`document.querySelectorAll('.day-header').length`), 7);
  assert.ok(
    await ev(`document.querySelector('.messages').textContent.includes('Старая история чата')`),
  );
  assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth`));

  await fill('[aria-label="Поиск записей"]', 'СОВМЕСТИМОСТЬ');
  await waitFor(`document.querySelectorAll('.search-results [role=option]').length===1`);
  assert.equal(await ev(`document.querySelectorAll('[role=option]').length`), 1);
  await ev(
    `(()=>{const e=document.querySelector('[role=combobox]');e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));})()`,
  );
  await delay(80);
  await ev(
    `document.querySelector('[role=combobox]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
  );
  await delay(200);
  assert.equal(await ev(`document.querySelectorAll('[role=dialog]').length`), 1);
  assert.ok(
    await ev(`document.querySelector('.modal').textContent.includes('Совместимость комментария')`),
  );
  await close();
  await fill('[aria-label="Поиск записей"]', 'нет совпадений');
  assert.ok(
    await ev(`document.querySelector('.search-results').textContent.includes('Ничего не найдено')`),
  );
  await ev(
    `document.querySelector('[role=combobox]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
  );
  await delay(100);
  assert.equal(await ev(`!!document.querySelector('.search-results')`), false);
  await click('[aria-label="Очистить поиск"]');

  await text('Создать запись');
  await check('Только на указанное время, без длительности');
  await label('Название', 'Многодневная проверка');
  await label('Дата начала', '2026-12-31');
  await label('Время начала', '23:00');
  await label('Дата окончания', '2027-01-02');
  await label('Время окончания', '02:00');
  await label('Комментарий', 'Полный комментарий\nВторая строка');
  await fill('[aria-label="Свой цвет"]', '#3579ab');
  await check('Важная запись');
  await text('Сохранить');
  let entries = await stored();
  const task = entries.find((e) => e.title === 'Многодневная проверка');
  assert.ok(task.startAt && task.endAt);
  assert.equal(task.duration, 1620);
  assert.equal(task.color, '#3579ab');
  assert.ok(task.important);
  assert.deepEqual(
    entries.find((e) => e.id === 'unknown'),
    fixture[1],
  );
  assert.equal(
    await ev(`localStorage.getItem('voicetask.entries.backup.v1')`),
    JSON.stringify(fixture),
  );
  await text('Редактировать');
  await label('Способ задания окончания', 'duration');
  assert.equal(await ev(`document.querySelector('input[type=number]').value`), '27');
  await label('Часы', 48);
  await label('Минуты', 0);
  await text('Сохранить');
  assert.equal((await stored()).find((e) => e.id === task.id).duration, 2880);
  await close();
  await fill('[aria-label="Поиск записей"]', 'Многодневная');
  await click('[role=option]');
  await close();
  await click('[aria-label="Очистить поиск"]');
  await fill('[aria-label="Режим календаря"]', 'День');
  assert.equal(await ev(`document.querySelectorAll('.day-header').length`), 1);
  assert.ok(await ev(`document.querySelector('.event-card').textContent.includes('Многодневная')`));
  await click('.completion');
  assert.equal((await stored()).find((e) => e.id === task.id).completed, true);
  assert.equal(
    await ev(`document.querySelectorAll('[role=dialog]').length`),
    0,
    'completion opens no dialog',
  );
  await click('.completion');
  assert.equal((await stored()).find((e) => e.id === task.id).completed, false);
  assert.equal(
    await ev(`document.querySelectorAll('[role=dialog]').length`),
    0,
    'reopening opens no dialog',
  );
  await fill('[aria-label="Категория записей"]', 'Встречи');
  assert.equal(await ev(`document.querySelectorAll('.event-card').length`), 0);
  await fill('[aria-label="Категория записей"]', 'Все');
  await click('[aria-label="Следующий период"]');
  assert.ok(await ev(`document.querySelector('.event-card').textContent.includes('Многодневная')`));
  await click('.day-header');
  assert.ok(await ev(`document.querySelector('.day-list').textContent.includes('Вторая строка')`));
  await click('.day-entry-title');
  assert.equal(await ev(`document.querySelectorAll('[role=dialog]').length`), 1);
  await close();
  await fill('[aria-label="Режим календаря"]', 'Месяц');
  assert.equal(await ev(`document.querySelectorAll('.month-cell').length`), 42);
  await fill('[aria-label="Режим календаря"]', 'Год');
  assert.equal(await ev(`document.querySelectorAll('.mini-month').length`), 12);
  assert.ok(await ev(`document.querySelectorAll('.event-dots i').length>=2`));
  await click('.event-dots i');
  assert.ok(await ev(`!!document.querySelector('.day-list')`));
  await close();
  await fill('[aria-label="Режим календаря"]', 'День');

  await click('[aria-label="Настройки"]');
  assert.equal(await ev(`document.querySelectorAll('.settings-layout nav button').length`), 3);
  await captureModal('settings-appearance');
  assert.ok(
    await ev(
      `(()=>{const e=document.querySelector('.settings-content');return e.scrollWidth<=e.clientWidth+1;})()`,
    ),
    'settings have no horizontal overflow',
  );
  await ev(`document.querySelector('[data-setting=theme] input[value=light]').focus()`);
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  });
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  });
  await delay(100);
  assert.equal(
    await ev(`document.documentElement.dataset.theme`),
    'dark',
    'theme cards work with keyboard',
  );
  await fill('[aria-label="Свой основной цвет"]', '#267ac1');
  assert.equal(await ev(`document.documentElement.style.getPropertyValue('--accent')`), '#267ac1');
  await click('[aria-label="Акцент #7850ec"]');
  assert.equal(
    await ev(`JSON.parse(localStorage.getItem('voicetask.preferences.v2')).accent`),
    '#7850ec',
  );
  await label('Тема', 'dark');
  assert.equal(await ev(`document.documentElement.dataset.theme`), 'dark');
  await label('Размер текста', 'large');
  assert.equal(await ev(`document.documentElement.dataset.text`), 'large');
  await label('Подробность карточек', 'brief');
  assert.ok(await ev(`!!document.querySelector('.card-comment.brief')`));
  await label('Подробность карточек', 'standard');
  assert.equal(await ev(`document.querySelectorAll('.card-comment').length`), 0);
  await label('Подробность карточек', 'full');
  assert.ok(await ev(`!!document.querySelector('.card-comment.full')`));
  await text('Календарь');
  await label('Формат даты', 'YYYY-MM-DD');
  await label('Режим при следующем открытии', 'Месяц');
  await label('Часовой пояс', 'Asia/Tokyo');
  await check('Показывать номера недель');
  await close();
  await reload();
  assert.equal(await ev(`document.documentElement.dataset.theme`), 'dark');
  assert.equal(await ev(`document.querySelector('[aria-label="Режим календаря"]').value`), 'Месяц');
  assert.ok((await stored()).some((e) => e.id === task.id));
  assert.equal((await stored()).find((e) => e.id === 'legacy').date, fixture[0].date);
  await click('[aria-label="Настройки"]');
  await text('Календарь');
  await label('Начало дня', 8);
  await label('Конец дня', 22);
  await fill('[aria-label="Цвет задач"]', '#e4c5f2');
  await fill('[aria-label="Цвет встреч"]', '#c5def2');
  assert.ok(
    await ev(
      `document.querySelector('.calendar-additional').getBoundingClientRect().top-document.querySelector('.calendar-color-row').getBoundingClientRect().bottom<=16`,
    ),
    'no large gap after record colors',
  );
  await close();
  assert.equal(
    (await stored()).find((e) => e.id === task.id).color,
    '#e4c5f2',
    'type color updates existing entries',
  );
  await fill('[aria-label="Режим календаря"]', 'День');
  assert.equal(await ev(`document.querySelectorAll('.hour-slot').length`), 14);
  await fill('[aria-label="Режим календаря"]', 'Месяц');

  await text('Создать запись');
  await text('Сохранить');
  assert.ok(await ev(`!!document.querySelector('.field-error')`));
  await label('Название', 'Встреча для удаления');
  await label('Тип', 'meeting');
  await text('Сохранить');
  assert.equal((await stored()).find((e) => e.title === 'Встреча для удаления').type, 'meeting');
  await text('Удалить');
  assert.equal(await ev(`document.querySelectorAll('[role=dialog]').length`), 1);
  await text('Отмена');
  assert.ok((await stored()).some((e) => e.title === 'Встреча для удаления'));
  await text('Удалить');
  await text('Удалить');
  assert.ok(!(await stored()).some((e) => e.title === 'Встреча для удаления'));

  await click('.profile-button');
  await text('Мой профиль');
  await label('Отображаемое имя', 'Тестовый профиль');
  await captureModal('profile-dark');
  await close();
  await reload();
  assert.ok(
    await ev(`document.querySelector('.profile-button').textContent.includes('Тестовый профиль')`),
  );
  await click('.profile-button');
  await text('Мой профиль');
  await ev(
    `(()=>{const canvas=document.createElement('canvas');canvas.width=512;canvas.height=256;canvas.getContext('2d').fillRect(0,0,512,256);const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));const d=new DataTransfer();d.items.add(new File([bytes],'avatar.png',{type:'image/png'}));const input=document.querySelector('input[type=file]');input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await delay(400);
  assert.ok(await ev(`localStorage.getItem('voicetask.avatar')?.startsWith('data:image/png')`));
  await close();
  await reload();
  assert.ok(await ev(`!!document.querySelector('.profile-button img')`));
  assert.equal(await ev(`document.querySelector('.profile-button img').naturalWidth`), 256);
  await click('.profile-button');
  await text('Мой профиль');
  await text('Удалить изображение');
  assert.equal(await ev(`localStorage.getItem('voicetask.avatar')`), null);
  await ev(
    `(()=>{const d=new DataTransfer();d.items.add(new File(['bad'],'bad.txt',{type:'text/plain'}));const input=document.querySelector('input[type=file]');input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await delay(100);
  assert.ok(await ev(`document.querySelector('.toast').textContent.includes('JPG')`));
  await close();

  const beforeStandard = await stored();
  const prefsBeforeStandard = await ev(
    `JSON.parse(localStorage.getItem('voicetask.preferences.v2'))`,
  );
  await click('[aria-label="Настройки"]');
  await label('Тема', 'system');
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await delay(100);
  assert.equal(await ev(`document.documentElement.dataset.theme`), 'light');
  const standardPrefs = await ev(`JSON.parse(localStorage.getItem('voicetask.preferences.v2'))`);
  assert.deepEqual(standardPrefs, {
    ...prefsBeforeStandard,
    theme: 'system',
    accent: '#805039',
    text: 'medium',
    density: 'standard',
  });
  assert.deepEqual(await stored(), beforeStandard);
  await close();

  await fill('[aria-label="Режим календаря"]', 'Год');
  await click('.period-trigger');
  const currentYear = await ev(
    `Number(document.querySelector('[aria-label="Год"] [aria-selected=true]').textContent)`,
  );
  await ev(
    `document.querySelector('[aria-label="Год"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`,
  );
  await text('Применить');
  assert.equal(
    await ev(`document.querySelector('.period-trigger').textContent`),
    String(currentYear + 1),
  );
  await click('.period-trigger');
  await text('Отмена');
  assert.equal(
    await ev(`document.querySelector('.period-trigger').textContent`),
    String(currentYear + 1),
  );
  for (const mode of ['Неделя', 'Месяц']) {
    await fill('[aria-label="Режим календаря"]', mode);
    await click('.period-trigger');
    assert.equal(await ev(`document.querySelectorAll('.period-wheel').length`), 2);
    await text('Отмена');
  }
  await fill('[aria-label="Режим календаря"]', 'День');
  await click('.period-trigger');
  assert.equal(await ev(`document.querySelectorAll('.picker-days button').length`), 42);
  await click('.picker-days button');
  assert.equal(await ev(`document.querySelectorAll('[role=dialog]').length`), 0);

  await fill('[aria-label="Сообщение ассистенту"]', 'встреча Из чата; 2027-02-01; 23:00; 2880');
  await click('[aria-label="Отправить сообщение"]');
  assert.ok((await stored()).some((e) => e.title === 'Из чата' && e.duration === 2880));
  await reload();
  assert.ok(await ev(`document.querySelector('.messages').textContent.includes('Из чата')`));

  const chat = async (value) => {
    await fill('[aria-label="Сообщение ассистенту"]', value);
    await click('[aria-label="Отправить сообщение"]');
  };
  await chat('Создай задачу Браузерная проверка завтра');
  let natural = (await stored()).find((e) => e.title === 'браузерная проверка');
  assert.ok(natural.allDay);
  assert.equal(natural.startAt, undefined);
  await fill('[aria-label="Режим календаря"]', 'День');
  assert.ok(
    await ev(`document.querySelector('.untimed-row').textContent.includes('браузерная проверка')`),
  );
  await chat('Перенеси её на послезавтра');
  natural = (await stored()).find((e) => e.id === natural.id);
  assert.ok(natural.allDay);
  await chat('Я закончила браузерную проверку');
  assert.equal((await stored()).find((e) => e.id === natural.id).completed, true);
  await chat('Верни задачу в невыполненные');
  assert.equal((await stored()).find((e) => e.id === natural.id).completed, false);
  await chat('Поставь встречу Голосовой тест завтра');
  assert.ok(!(await stored()).some((e) => e.title === 'голосовой тест'));
  await chat('На 15:00');
  assert.equal((await stored()).find((e) => e.title === 'голосовой тест').time, '15:00');
  await chat('Удали встречу Голосовой тест');
  assert.ok((await stored()).some((e) => e.title === 'голосовой тест'));
  await chat('Нет');
  assert.ok((await stored()).some((e) => e.title === 'голосовой тест'));
  await chat('Удали встречу Голосовой тест');
  await chat('Да');
  assert.ok(!(await stored()).some((e) => e.title === 'голосовой тест'));
  await chat('Напоминай Браузерная серия каждый день в 12');
  const series = (await stored()).find((e) => e.title === 'браузерная серия');
  assert.equal(series.recurrence.frequency, 'daily');
  assert.equal((await stored()).filter((e) => e.title === 'браузерная серия').length, 1);
  await chat('Удали Браузерная серия');
  await chat('Только это повторение');
  await chat('Да');
  assert.equal((await stored()).find((e) => e.id === series.id).recurrence.exceptions.length, 1);
  const beforeSpeech = await stored();
  await ev(
    `(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = (url, options) => String(url).endsWith('/api/speech') ? Promise.resolve(new Response(JSON.stringify({text: 'Создай задачу из голоса завтра'}))) : fetch(url, options);
      navigator.mediaDevices.getUserMedia = async () => {
        if (window.denyTestMicrophone) throw new DOMException('denied', 'NotAllowedError');
        const track = {readyState: 'live', stop() {this.readyState = 'ended'}};
        return window.testMicrophoneStream = {getTracks: () => [track]};
      };
      window.AudioContext = class {
        sampleRate = 16000;
        audioWorklet = {addModule: async () => {}};
        createMediaStreamSource() {return {connect: node => node, disconnect() {}}}
        resume() {return Promise.resolve()}
        close() {return Promise.resolve()}
      };
      window.AudioWorkletNode = class {
        port = {onmessage: null, close() {}, postMessage() {queueMicrotask(() => {this.onmessage?.({data: new Float32Array(16000)}); this.onmessage?.({data: 'stopped'})})}};
        connect() {return this}
        disconnect() {}
      };
    })()`,
  );
  await click('[aria-label="Голосовой ввод"]');
  await waitFor(
    `document.querySelector('[aria-label="Остановить запись"]')?.getAttribute('aria-pressed')==='true'`,
  );
  await click('[aria-label="Остановить запись"]');
  await waitFor(
    `document.querySelector('[aria-label="Сообщение ассистенту"]').value === 'Создай задачу из голоса завтра'`,
  );
  assert.equal(
    await ev(`document.querySelector('[aria-label="Сообщение ассистенту"]').value`),
    'Создай задачу из голоса завтра',
  );
  assert.ok(
    await ev(
      `window.testMicrophoneStream.getTracks().every(track => track.readyState === 'ended')`,
    ),
  );
  assert.deepEqual(await stored(), beforeSpeech, 'speech does not auto execute');
  await fill('[aria-label="Сообщение ассистенту"]', 'Создай задачу Исправленный голос завтра');
  await click('[aria-label="Отправить сообщение"]');
  assert.ok((await stored()).some((e) => e.title === 'исправленный голос'));
  await ev(`window.denyTestMicrophone = true`);
  await click('[aria-label="Голосовой ввод"]');
  await delay(100);
  assert.ok(
    await ev(
      `document.querySelector('.chat-compose [role=alert]').textContent.includes('Разрешите доступ к микрофону')`,
    ),
  );
  const beforeClear = await stored();
  await click('[aria-label="Очистить историю чата"]');
  await text('Отмена');
  assert.ok(
    await ev(`document.querySelector('.messages').textContent.includes('Исправленный голос')`),
  );
  await click('[aria-label="Очистить историю чата"]');
  await text('Очистить');
  assert.deepEqual(await stored(), beforeClear);
  assert.equal(await ev(`JSON.parse(localStorage.getItem('voicetask.chat.v1')).length`), 1);
  await fill('[aria-label="Сообщение ассистенту"]', 'Создай задачу Защита от дубля завтра');
  await ev(
    `(()=>{const b=document.querySelector('[aria-label="Отправить сообщение"]');b.click();b.click();document.querySelector('.chat-compose form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`,
  );
  await delay(200);
  assert.equal((await stored()).filter((e) => e.title === 'защита от дубля').length, 1);
  await reload();
  assert.ok((await stored()).some((e) => e.id === series.id));
  assert.ok(await ev(`document.querySelector('.messages time')?.dateTime`));

  await click('[aria-label="Настройки"]');
  await text('Уведомления');
  await check('Включить уведомления');
  await close();
  await click('[aria-label="Уведомления"]');
  assert.ok(
    await ev(
      `document.querySelector('.notification-popover').textContent.includes('Просроченная задача')`,
    ),
  );
  assert.ok(
    await ev(
      `!document.querySelector('.notification-popover').textContent.includes('Запись сохранена')`,
    ),
  );
  await reload();
  await click('[aria-label="Уведомления"]');
  assert.ok(
    await ev(
      `document.querySelector('.notification-popover').textContent.includes('Новых напоминаний нет')`,
    ),
  );
  await click('[aria-label="Уведомления"]');
  const futureWall = await ev(
    `new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(Date.now()+600000)).split(' ')`,
  );
  await fill(
    '[aria-label="Сообщение ассистенту"]',
    `задача Будущее напоминание; ${futureWall[0]}; ${futureWall[1]}; 60`,
  );
  await click('[aria-label="Отправить сообщение"]');
  await click('[aria-label="Уведомления"]');
  assert.ok(
    await ev(
      `document.querySelector('.notification-popover').textContent.includes('Скоро задача: Будущее напоминание')`,
    ),
  );
  await reload();
  await click('[aria-label="Уведомления"]');
  assert.ok(
    await ev(
      `document.querySelector('.notification-popover').textContent.includes('Будущее напоминание')`,
    ),
  );
  await click('[aria-label="Уведомления"]');

  await click('[aria-label="Настройки"]');
  await text('Календарь');
  await label('Конец дня', 24);
  await close();
  await fill('[aria-label="Режим календаря"]', 'День');
  for (let i = 0; i < 5; i++) await chat(`задача Короткая ${i}; ${futureWall[0]}; 23:55; 5`);
  const bounds = await ev(
    `(()=>{const scroll=document.querySelector('.time-scroll');scroll.scrollTop=scroll.scrollHeight;return [...document.querySelectorAll('.event-position')].filter(e=>e.textContent.includes('Короткая')).map(e=>{const r=e.getBoundingClientRect(),g=document.querySelector('.time-grid').getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,height:r.height,gridBottom:g.bottom};});})()`,
  );
  assert.equal(bounds.length, 2);
  assert.ok(bounds.every((b) => b.height >= 88 && b.bottom <= b.gridBottom + 1));
  for (let i = 0; i < bounds.length; i++)
    for (let j = i + 1; j < bounds.length; j++)
      assert.ok(bounds[i].right <= bounds[j].x || bounds[j].right <= bounds[i].x);
  assert.ok(await ev(`document.querySelector('.timed-more').textContent.includes('Ещё 3')`));
  await click('.timed-more');
  assert.equal(
    await ev(
      `[...document.querySelectorAll('.day-list article')].filter(e=>e.textContent.includes('Короткая')).length`,
    ),
    5,
  );
  await text('Короткая 4');
  assert.ok(await ev(`document.querySelector('.modal').textContent.includes('23:55')`));
  await close();

  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(100);
  await writeFile(
    '.tools/desktop-v2.png',
    Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await delay(200);
  assert.ok(
    await ev(`document.documentElement.scrollWidth<=innerWidth`),
    'mobile has no horizontal page overflow',
  );
  await writeFile(
    '.tools/mobile-v2.png',
    Buffer.from(
      (await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }))
        .data,
      'base64',
    ),
  );

  const beforeFailure = await stored();
  await ev(
    `window.savedSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='voicetask.entries.v1')throw new DOMException('Quota exceeded','QuotaExceededError');return window.savedSetItem.call(this,k,v);}`,
  );
  await fill('[aria-label="Сообщение ассистенту"]', 'задача Не сохранится; сегодня; 12:00');
  await click('[aria-label="Отправить сообщение"]');
  assert.deepEqual(await stored(), beforeFailure);
  assert.equal(
    await ev(`document.querySelector('[aria-label="Сообщение ассистенту"]').value`),
    'задача Не сохранится; сегодня; 12:00',
  );
  assert.ok(
    await ev(
      `document.querySelector('.messages').lastElementChild.previousElementSibling.textContent.includes('не сохранена')`,
    ),
  );
  await ev(`Storage.prototype.setItem=window.savedSetItem`);
  await ev(`localStorage.setItem('voicetask.chat.v1','broken-chat')`);
  await reload();
  assert.equal(await ev(`localStorage.getItem('voicetask.chat.v1')`), 'broken-chat');
  assert.ok(
    await ev(
      `document.querySelector('.chat-compose [role=alert]').textContent.includes('Исходные данные')`,
    ),
  );
  await ev(`localStorage.setItem('voicetask.entries.v1','broken-json')`);
  await reload();
  assert.equal(await ev(`localStorage.getItem('voicetask.entries.v1')`), 'broken-json');
  assert.ok(
    await ev(`document.querySelector('.error').textContent.includes('Исходные данные сохранены')`),
  );
  await ev(
    `localStorage.setItem('voicetask.entries.v1',${JSON.stringify(JSON.stringify(beforeFailure))})`,
  );
  assert.deepEqual(errors, [], 'no runtime errors');
  console.log(
    'Browser checks passed: 4 calendar modes, task/meeting CRUD, validation, custom color, multiday segments, completion toggle, global search/comments/keyboard/Escape, day/detail dialogs, year dots, filters, settings/date format/timezone/theme/text/density/reload, profile name, chat persistence, legacy backup/unknown record, overdue once and bell, desktop/mobile overflow.',
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
