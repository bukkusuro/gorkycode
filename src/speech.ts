export function speakRussian(
  text: string,
  synth: SpeechSynthesis | undefined,
  makeUtterance: (s: string) => SpeechSynthesisUtterance,
  onState: (active: boolean) => void,
  onError: (s: string) => void,
) {
  if (!synth) {
    onError('Озвучивание недоступно в этом браузере. Ответ остаётся в чате.');
    return;
  }
  synth.cancel();
  const voice = synth.getVoices().find((v) => /^ru(?:-|_)/i.test(v.lang) || v.lang === 'ru');
  if (!voice) {
    onError(
      'Русский голос не найден. Установите русский голос в системе или используйте текстовый режим.',
    );
    return;
  }
  const utterance = makeUtterance(text.slice(0, 4000));
  utterance.lang = 'ru-RU';
  utterance.voice = voice;
  const fail = () => {
    onState(false);
    onError('Не удалось озвучить ответ. Текст сохранён в чате.');
  };
  utterance.onstart = () => onState(true);
  utterance.onend = () => onState(false);
  utterance.onerror = (e) => {
    if (e.error === 'canceled' || e.error === 'interrupted') onState(false);
    else fail();
  };
  try {
    synth.speak(utterance);
  } catch {
    fail();
  }
}
