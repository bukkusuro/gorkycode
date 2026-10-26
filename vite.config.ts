import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { openRouterPlugin } from './server/openrouter.mjs';
import { speechPlugin } from './server/speech.mjs';
import { remindersPlugin } from './server/reminders.mjs';
export default defineConfig({
  plugins: [react(), openRouterPlugin(), speechPlugin(), remindersPlugin()],
  base: '/VoiceTask/',
  server: { watch: { ignored: ['**/.tools/**'] } },
});
