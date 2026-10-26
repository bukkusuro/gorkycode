import { useEffect, useRef, useState } from 'react';
import { speakRussian } from './speech';
import { type Recording, recordMicrophone } from './voiceRecorder';
export function useVoice(input: string, setInput: (s: string) => void) {
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle');
  const [speaking, setSpeaking] = useState(false),
    [error, setError] = useState('');
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem('voicetask.voice.v1') === 'true';
    } catch {
      return false;
    }
  });
  const recorder = useRef<Recording | null>(null),
    controller = useRef<AbortController | null>(null),
    pending = useRef<Promise<string> | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0),
    inputRef = useRef(input),
    base = useRef('');
  inputRef.current = input;
  const updateInput = (text: string) => {
    inputRef.current = text;
    setInput(text);
    return text;
  };
  const appendToBase = (text: string) =>
    updateInput([base.current, text].filter(Boolean).join(' '));
  const stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  };
  const cancel = () => {
    generation.current++;
    clearTimeout(timer.current);
    controller.current?.abort();
    controller.current = null;
    recorder.current?.cancel();
    recorder.current = null;
    pending.current = null;
    setPhase('idle');
  };
  const finish = (): Promise<string> => {
    if (pending.current) return pending.current;
    const current = recorder.current;
    if (!current) return Promise.resolve(inputRef.current);
    const token = generation.current,
      signal = controller.current!.signal;
    clearTimeout(timer.current);
    setPhase('transcribing');
    pending.current = (async () => {
      try {
        const audio = await current.stop();
        if (signal.aborted) return '';
        const response = await fetch('./api/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: audio,
          signal: AbortSignal.any([signal, AbortSignal.timeout(95000)]),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || typeof result?.text !== 'string')
          throw Error(result?.error || 'Распознавание недоступно. Попробуйте ещё раз.');
        if (token !== generation.current) return '';
        if (!result.text.trim())
          throw Error('Речь не распознана. Нажмите микрофон и повторите фразу.');
        return appendToBase(result.text.trim());
      } catch (error) {
        if (!signal.aborted && token === generation.current)
          setError(
            (error as Error).name === 'TypeError'
              ? 'Не удалось связаться с распознаванием речи. Проверьте, что сайт запущен через START.cmd.'
              : (error as Error).name === 'TimeoutError'
                ? 'Распознавание заняло слишком много времени. Повторите более короткую фразу.'
                : (error as Error).message,
          );
        return '';
      } finally {
        if (token === generation.current) {
          recorder.current = null;
          pending.current = null;
          setPhase('idle');
        }
      }
    })();
    return pending.current;
  };
  const toggleMic = async () => {
    if (phase === 'recording') {
      await finish();
      return;
    }
    if (phase === 'requesting') {
      cancel();
      return;
    }
    if (phase === 'transcribing') return;
    stopSpeaking();
    cancel();
    setError('');
    const token = generation.current;
    base.current = inputRef.current.trim();
    const current = new AbortController();
    controller.current = current;
    setPhase('requesting');
    try {
      const recording = await recordMicrophone(current.signal);
      if (token !== generation.current) {
        recording.cancel();
        return;
      }
      recorder.current = recording;
      setPhase('recording');
      timer.current = setTimeout(() => void finish(), 59000);
    } catch (error) {
      if (token !== generation.current) return;
      const name = (error as Error).name;
      setError(
        name === 'NotAllowedError'
          ? 'Разрешите доступ к микрофону в настройках этого сайта и нажмите кнопку ещё раз.'
          : name === 'NotFoundError'
            ? 'Микрофон не найден. Подключите его и повторите запись.'
            : name === 'NotReadableError'
              ? 'Микрофон занят. Закройте использующее его приложение и повторите запись.'
              : (error as Error).message,
      );
      setPhase('idle');
    }
  };
  const edit = (text: string) => {
    cancel();
    updateInput(text);
  };
  const toggleVoice = () => {
    const next = !enabled;
    setEnabled(next);
    if (!next) stopSpeaking();
    try {
      localStorage.setItem('voicetask.voice.v1', String(next));
    } catch {
      setError('Не удалось сохранить режим озвучивания.');
    }
  };
  const speak = (text: string) => {
    if (enabled) {
      cancel();
      speakRussian(
        text,
        window.speechSynthesis,
        (s) => new SpeechSynthesisUtterance(s),
        setSpeaking,
        setError,
      );
    }
  };
  useEffect(
    () => () => {
      generation.current++;
      clearTimeout(timer.current);
      controller.current?.abort();
      recorder.current?.cancel();
      window.speechSynthesis?.cancel();
    },
    [],
  );
  return {
    finish,
    edit,
    listening: phase === 'recording',
    requesting: phase === 'requesting',
    transcribing: phase === 'transcribing',
    speaking,
    enabled,
    error,
    toggleMic,
    cancel,
    toggleVoice,
    stopSpeaking,
    speak,
  };
}
