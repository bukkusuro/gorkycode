import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { downloadAsset } from './download-asset.mjs';

const root = fileURLToPath(new URL('../.tools/speech/', import.meta.url));
const assets = [
  [
    'whisper.zip',
    'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip',
    'd824b1e37599f882b396e73f1ee0bfd5d0529f700314c48311dcbd00b803321d',
  ],
  [
    'ggml-small-q5_1.bin',
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin',
    'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  ],
  [
    'ggml-silero-v5.1.2.bin',
    'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
    '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
  ],
];
await mkdir(root, { recursive: true });
await Promise.all(
  assets.map(async ([name, url, checksum]) => {
    const path = join(root, name);
    if (existsSync(path)) return;
    console.log(`Downloading ${name}`);
    await downloadAsset(path, url, checksum, { timeoutMs: 600000 });
  }),
);
if (!existsSync(join(root, 'bin', 'Release', 'whisper-cli.exe'))) {
  await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:VOXA_VOICE_ARCHIVE, $env:VOXA_VOICE_TARGET)',
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        VOXA_VOICE_ARCHIVE: join(root, 'whisper.zip'),
        VOXA_VOICE_TARGET: join(root, 'bin'),
      },
    },
  );
}
console.log('Local speech recognition is ready.');
