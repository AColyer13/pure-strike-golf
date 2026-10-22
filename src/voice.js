// The caddie's voice: the browser's speech synthesis, spoken at the player's volume.
// Does nothing where speech isn't available (older WebViews, headless test runs).
// A profile ({ lang, prefer, pitch, rate }) picks each caddie's voice and delivery from what the
// device has: the accent where there is one, a lower and slower voice for the heavier characters.
const picked = new Map();

const synth = () => (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined' ? speechSynthesis : null);

function voice(s, p) {
  const vs = s.getVoices();
  if (!vs.length) return null; // (the list loads late: ask again next time)
  if (!picked.has(p)) {
    const en = vs.filter((v) => /^en/i.test(v.lang));
    const lang = p.lang ? en.filter((v) => p.lang.test(v.lang)) : en;
    const pool = lang.length ? lang : en;
    picked.set(p, (p.prefer && pool.find((v) => p.prefer.test(v.name))) || pool.find((v) => v.default) || pool[0] || null);
  }
  return picked.get(p);
}

export function say(text, volume = 1, p = {}) {
  const s = synth();
  if (!s || !text || volume <= 0) return;
  s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = voice(s, p);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = p.rate ?? 0.98; u.pitch = p.pitch ?? 0.9; u.volume = Math.min(1, volume);
  s.speak(u);
}

export function hush() {
  const s = synth();
  if (s && (s.speaking || s.pending)) s.cancel();
}
