import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { openRouterPlugin } from './server/openrouter.mjs';
import { speechPlugin } from './server/speech.mjs';
import { remindersPlugin } from './server/reminders.mjs';
import { pushRemindersPlugin } from './server/push-reminders.mjs';
export default defineConfig({
  plugins: [react(), openRouterPlugin(), speechPlugin(), remindersPlugin(), pushRemindersPlugin()],
  base: '/VoiceTask/',
  server: { watch: { ignored: ['**/.tools/**'] } },
});
