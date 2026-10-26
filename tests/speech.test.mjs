import test from 'node:test';
import assert from 'node:assert/strict';
import { speakRussian } from '../.tools/test-build/speech.js';
test('synthesis uses Russian voice, cancels prior speech and retains text on errors', () => {
  let error = '',
    cancelled = 0,
    spoken,
    active = false;
  const synth = {
    cancel() {
      cancelled++;
    },
    getVoices() {
      return [{ lang: 'en-US' }, { lang: 'ru-RU' }];
    },
    speak(u) {
      spoken = u;
      u.onstart();
    },
  };
  speakRussian(
    'Текст',
    synth,
    (s) => ({ text: s }),
    (s) => (active = s),
    (s) => (error = s),
  );
  assert.equal(cancelled, 1);
  assert.equal(spoken.lang, 'ru-RU');
  assert.ok(active);
  spoken.onerror({ error: 'synthesis-failed' });
  assert.equal(active, false);
  assert.match(error, /Текст сохранён/);
  synth.getVoices = () => [];
  speakRussian(
    'Текст',
    synth,
    (s) => ({ text: s }),
    () => {},
    (s) => (error = s),
  );
  assert.match(error, /Русский голос не найден/);
});
