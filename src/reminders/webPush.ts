export function supportsPush() {
  return (
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}
export async function getPushRegistration() {
  await navigator.serviceWorker.register(new URL('./push-worker.js', window.location.href), {
    scope: new URL('./', window.location.href).pathname,
    updateViaCache: 'none',
  });
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Служба уведомлений не запустилась. Обновите страницу.')),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export async function subscribeToPush(publicKey: string, renew = false) {
  const registration = await getPushRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && renew) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (subscription) return subscription;
  const binary = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
  const applicationServerKey = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
}
