// The three caddies. Each one turns the game's numbers (club, plays-like distance, how hard to
// hit it) into a few lines in their own voice, and has something to say about the result.
// Pure functions of their inputs (a seed picks the wording) so a line stays put while it is on
// screen and the rules can be tested.

export const CADDIES = {
  tech: {
    id: 'tech', name: 'Nigel', title: 'The Technician',
    blurb: 'Nigel: a technical Englishman. Gives you the exact percentage – though, being human, he is a tad out now and then.',
    voice: { lang: /^en-GB/i, prefer: /daniel|george|ryan|google uk english male|oliver|arthur/i, pitch: 1, rate: 1 },
  },
  south: {
    id: 'south', name: 'Bobby Ray', title: 'The Southerner',
    blurb: 'Bobby Ray: a Southern gentleman. Tells you around how hard to hit it, and is your biggest fan.',
    voice: { lang: /^en-US/i, prefer: /david|guy|mark|google us english|alex/i, pitch: 0.8, rate: 0.88 },
  },
  scot: {
    id: 'scot', name: 'Angus', title: 'The Local',
    blurb: 'Angus: a Scottish drunk who knows the course better than anyone. If you miss, it was you.',
    voice: { lang: /^en-GB|^en-IE/i, prefer: /scot|fiona|moira|sean|george|daniel/i, pitch: 0.7, rate: 0.8 },
  },
};
export const CADDIE_IDS = ['tech', 'south', 'scot'];

// a string → a repeatable stream of 0..1 numbers
export function rngFor(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];

// Angus has been at the whisky: his words slur and he hiccups
export function drunk(text, r) {
  let out = text
    .replace(/\bthe\b/gi, "th'").replace(/\byou\b/gi, 'ye').replace(/\byour\b/gi, 'yer')
    .replace(/\bto\b/gi, 'tae').replace(/\bno\b/gi, 'nae').replace(/\bof\b/gi, "o'").replace(/\bdon't\b/gi, 'dinnae');
  const i = out.indexOf('. ');
  if (i > 0 && r() < 0.6) out = `${out.slice(0, i + 1)} *hic*${out.slice(i + 1)}`;
  return out;
}

// What the caddie says before the swing. c = { club, dist, pct, full, putt, wind, elev, tip, seed, greet }
//   pct   – the right number, in steps of 5 (100 for a full swing); dist – "150 yds" or ''
//   wind  – yards the wind adds (+ into it); elev – yards the slope adds (+ uphill); tip – a course note
// Returns { text, say, pct } where pct is the number the caddie gives (Nigel is sometimes a tad out)
// and err how far out he is.
export function advice(id, c) {
  const r = rngFor(`${id}|${c.seed}`);
  const where = c.dist ? `, ${c.dist}${c.putt ? '' : ' to play'}` : '';
  let shown = c.pct, err = 0, line;
  if (id === 'tech') {
    if (!c.full && c.pct >= 15 && r() < 0.3) {
      err = pick(r, [-10, -5, 5, 10]);
      shown = Math.min(95, Math.max(5, c.pct + err)); err = shown - c.pct;
    }
    const open = pick(r, ['Right, then.', 'Ah, yes.', 'Quite.', 'Now then.', 'Splendid.']);
    const tail = pick(r, ['Mustn’t grumble.', 'Smooth and tidy, if you please.', 'Quite straightforward, really.', 'Do keep your head still.', 'Jolly good.']);
    const tech = Math.abs(c.wind || 0) >= 3 ? `Allowing for the ${c.wind > 0 ? 'headwind' : 'tailwind'}, ${Math.round(Math.abs(c.wind))} yds ${c.wind > 0 ? 'extra' : 'less'}.`
      : Math.abs(c.elev || 0) >= 4 ? `${c.elev > 0 ? 'Uphill' : 'Downhill'}, so ${Math.round(Math.abs(c.elev))} yds ${c.elev > 0 ? 'extra' : 'less'}.` : '';
    const how = c.full ? 'Give it everything, I should say.' : `I make it ${shown}%.`;
    line = [`${open} ${c.club}${where}.`, c.putt ? '' : tech, how, tail].filter(Boolean).join(' ');
  } else if (id === 'south') {
    const open = pick(r, ['Well now,', 'Alright, partner,', 'Hey there, sugar,', 'Lord have mercy,']);
    const cheer = pick(r, ['You got this, friend!', 'I believe in ya!', 'That ball’s gonna fly like a bald eagle!', 'Ain’t nobody better, darlin’!', 'Just swing pretty and let ’er rip!']);
    const how = c.full ? 'Reckon you can just lay into it – all out, friend!' : c.putt ? `Easy does it – around ${c.pct}% oughta do it.` : `Reckon around ${c.pct}% oughta do it.`;
    line = `${open} ${c.club}${c.dist ? `, ${c.dist} out` : ''}. ${how} ${cheer}`;
  } else {
    const open = pick(r, ['Listen tae me, laddie.', 'Och, aye.', 'Right, wee man.']);
    const how = c.full ? 'Gie it laldy!' : `${c.pct}%. Exactly.`;
    const know = c.tip || (Math.abs(c.wind || 0) >= 3 ? `Wind’s ${c.wind > 0 ? 'in yer face' : 'at yer back'}.`
      : r() < 0.5 ? pick(r, ['I ken every blade o’ grass on this course.', 'Walked this hole drunk mair times than ye’ve had hot dinners.', 'Saw a man lose a ball in that rough in ’98. Never found it.']) : '');
    line = drunk([open, `${c.club}${where}.`, how, know].filter(Boolean).join(' '), r);
  }
  const text = `${CADDIES[id].name}: ${line}`;
  const say = c.greet ? `${greeting(id)} ${line}` : line;
  return { text, say: say.replace(/\*hic\*/g, 'hic').replace(/&/g, 'and'), pct: shown, err };
}

export function greeting(id) {
  return { tech: 'Good day to you. Nigel, at your service. Shall we?', south: 'Howdy, partner! Bobby Ray here. Let’s have us some fun!', scot: 'Mornin’. *hic* Angus. I ken this course better than my ain mither.' }[id];
}

const TEMPO = {
  tech: { quick: 'Bit hurried, that.', slow: 'Rather a leisurely backswing.', pure: 'Lovely tempo.' },
  south: { quick: 'Easy now, darlin’, no rush!', slow: 'Come on, sugar, that ball ain’t gettin’ any younger!', pure: 'Smooth as sweet tea!' },
  scot: { quick: 'Ye rushed it, ye numpty!', slow: 'Did ye fall asleep back there?', pure: 'Hmph. Acceptable.' },
};
// after the swing: 'quick' | 'slow' | 'pure'
export const tempoLine = (id, kind) => TEMPO[id]?.[kind] || '';

const REACT = {
  tech: {
    great: ['Oh, well played!', 'Splendid. Absolutely splendid.', 'Textbook. Almost as if I planned it.'],
    miss: ['Ah. Unlucky, that.', 'Bit of a wobble, I fear.', 'Not quite what we discussed.'],
    sorry: ['Ah – that one’s on me. I was a touch out with the number. Terribly sorry.', 'I may have misjudged that percentage. Apologies.'],
  },
  south: {
    great: ['Woo-wee, now THAT’S what I’m talkin’ about!', 'Pretty as a peach!', 'Lord, you hit that purdy!'],
    miss: ['Shake it off, partner. Next one’s yours.', 'Aw, that’s alright, darlin’. You’ll get ’em next time!', 'Chin up, friend. Ain’t nothin’ but a thing!'],
  },
  scot: {
    great: ['Aye, no bad. Dinnae let it go tae yer heid.', 'Well, even a blind squirrel, eh?', 'That’s mair like it. Ye must’ve been listening.'],
    miss: ['That wasnae the club, that was YE!', 'I tellt ye! Did ye no listen?', 'Ye’ve the swing o’ a wet haggis.', 'Dinnae look at me, I gave ye the perfect number!', 'Ach, ye muppet!'],
  },
};

// How a shot went, for the caddie: 'great' | 'miss' | null (an ordinary shot gets no comment).
export function judgeShot(info, sg) {
  if (!info) return null;
  if (info.holed || info.result === 'holed') return 'great';
  if (info.result === 'water' || info.result === 'ob') return 'miss';
  const gain = sg?.sg;
  if (gain == null) return null;
  if (gain > 0.35) return 'great';
  if (gain < -0.4 || (!info.putt && ['bunker', 'deep', 'straw'].includes(info.after) && gain < -0.15)) return 'miss';
  return null;
}

// The caddie's line for a shot that was 'great' or a 'miss'. `err` is how far out Nigel's number was.
export function reaction(id, kind, { err = 0 } = {}, r = Math.random) {
  const set = REACT[id];
  if (!set || !kind) return '';
  if (id === 'tech' && kind === 'miss' && err) return pick(r, set.sorry);
  return pick(r, set[kind]);
}
