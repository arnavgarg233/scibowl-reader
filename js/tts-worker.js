// Runs the Kokoro neural voice off the main thread so buzzing never lags.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
import { phonemize } from 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js';

// how long each word takes to say, in phonemes (used to line text up with audio)
async function wordWeights (words) {
  const out = [];
  for (const w of words) {
    if (!w) { out.push(0); continue; }
    try {
      const p = (await phonemize(w, 'en-us')).join(' ').replace(/[ˈˌ\s]/g, '');
      let n = 0;
      for (const ch of p) n += ch === 'ː' ? 0.5 : 1;
      out.push(Math.max(n, 1) / 2.5);
    } catch (e) { out.push(null); }
  }
  return out.includes(null) ? null : out;
}

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const files = {};
      tts = await KokoroTTS.from_pretrained(MODEL, {
        dtype: m.device === 'webgpu' ? 'fp32' : 'q8',
        device: m.device || 'wasm',
        progress_callback: (p) => {
          // p: { status, file, loaded, total }
          if (p.status === 'progress' && p.total) {
            files[p.file] = [p.loaded, p.total];
            let loaded = 0; let total = 0;
            for (const [l, t] of Object.values(files)) { loaded += l; total += t; }
            self.postMessage({ type: 'progress', loaded, total });
          }
        }
      });
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'gen') {
      const t0 = performance.now();
      const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
      const samples = out.audio;
      const weights = m.words && m.words.length ? await wordWeights(m.words) : null;
      self.postMessage({ type: 'audio', id: m.id, samples, rate: out.sampling_rate, weights, ms: performance.now() - t0 }, [samples.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};
