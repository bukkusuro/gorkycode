import { useRef, useState } from 'react';
function readSetting(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function useProfile(notify: (message: string) => void) {
  const [name, setName] = useState(() => readSetting('voicetask.name', 'Александр'));
  const [avatar, setAvatar] = useState(() => readSetting('voicetask.avatar', ''));
  const uploadVersion = useRef(0);
  function rename(value: string) {
    try {
      localStorage.setItem('voicetask.name', value);
      setName(value);
    } catch {
      notify('Не удалось сохранить имя');
    }
  }
  function removeAvatar() {
    try {
      localStorage.removeItem('voicetask.avatar');
      uploadVersion.current++;
      setAvatar('');
    } catch {
      notify('Не удалось удалить изображение');
    }
  }
  async function upload(file?: File) {
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      notify('Выберите JPG или PNG размером до 5 МБ.');
      return;
    }
    const version = ++uploadVersion.current;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw Error('Canvas unavailable');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (version !== uploadVersion.current) return;
      const data = canvas.toDataURL('image/png');
      localStorage.setItem('voicetask.avatar', data);
      setAvatar(data);
    } catch {
      if (version === uploadVersion.current)
        notify('Не удалось прочитать или сохранить изображение.');
    } finally {
      bitmap?.close();
    }
  }
  return { name, avatar, rename, removeAvatar, upload };
}
