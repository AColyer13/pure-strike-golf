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

// Angus has been at the whisky: the odd hiccup, never so much that you can't follow him
export function drunk(text, r) {
  const i = text.indexOf('. ');
  return i > 0 && r() < 0.5 ? `${text.slice(0, i + 1)} *hic*${text.slice(i + 1)}` : text;
}

// A word about the situation, before the swing: the tee, a bad lie, a knee-knocker, the shot before going well or badly
const COLOR = {
  tech: {
    tee: ['Do find the fairway.', 'Smooth and unhurried off the tee.'],
    bunker: ['Mind the lip of the bunker.', 'Sand. Commit to it.'],
    rough: ['Rough lie. It will grab the club, so do allow for that.'],
    shortPutt: ['A short one. Do not hurry it.', 'Quite makeable. Quite.'],
    afterMiss: ['Never mind the last one. Reset.'],
    afterGreat: ['Rather good, the last one. Do repeat it.'],
  },
  south: {
    tee: ['Let’s hit it a country mile, partner!', 'Big old fairway out there. Find it!'],
    bunker: ['Sand’s just a beach with attitude. You got this!'],
    rough: ['A little rough never hurt nobody, friend.'],
    shortPutt: ['This one’s gonna drop, darlin’. I can feel it.', 'Short putt, big heart. Let ’er go!'],
    afterMiss: ['Forget the last one. This one’s all you!'],
    afterGreat: ['That last one was a beauty! Do it again!'],
  },
  scot: {
    tee: ['Keep it out of the heather, now. I’ve lost a few balls in there. And a few friends.', 'Big swing, big smile! The tee’s all yours.'],
    bunker: ['Bunker! Lovely. Open the face, hit behind the ball, and don’t you dare blame the sand.'],
    rough: ['The rough here eats clubs, but you’ve got the hands for it. Grip it firm!'],
    shortPutt: ['A wee short one. Easy as pie, as long as you don’t go and wobble it.', 'Short putt. I’ve a good feeling about this one!'],
    afterMiss: ['Forget the last one, that was all you. This one’s a beauty, I can feel it!'],
    afterGreat: ['That last one was grand! Do it again, and I’ll buy the first round.'],
    },
};

// What the caddie says before the swing. c = { club, dist, pct, full, putt, wind, elev, tip, seed, greet }
//   pct   – the right number, in steps of 5 (100 for a full swing); dist – "150 yds" or ''
//   color – a situation key for a word about it ('tee', 'bunker', 'rough', 'shortPutt', 'afterMiss', 'afterGreat')
//   short – just the club and number (the shot's advice was already spoken, this is a club change)
//   wind  – yards the wind adds (+ into it); elev – yards the slope adds (+ uphill); tip – a course note
// Returns { text, say, pct } where pct is the number the caddie gives (Nigel is sometimes a tad out)
// and err how far out he is.
export function advice(id, c) {
  const r = rngFor(`${id}|${c.seed}`);
  if (c.short) {
    const num = c.full ? 'All out' : `${c.pct}%`;
    const t = `${CADDIES[id].name}: ${c.club}${c.dist ? `, ${c.dist}` : ''}. ${num}.`;
    return { text: t, say: t.replace(`${CADDIES[id].name}: `, '').replace(/&/g, 'and'), pct: c.pct, err: 0 };
  }
  const colour = !c.tip && c.color && COLOR[id][c.color] && r() < 0.55 ? pick(r, COLOR[id][c.color]) : '';
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
    line = [`${open} ${c.club}${where}.`, c.putt ? '' : tech, how, colour, tail].filter(Boolean).join(' ');
  } else if (id === 'south') {
    const open = pick(r, ['Well now,', 'Alright, partner,', 'Hey there, sugar,', 'Lord have mercy,']);
    const cheer = pick(r, ['You got this, friend!', 'I believe in ya!', 'That ball’s gonna fly like a bald eagle!', 'Ain’t nobody better, darlin’!', 'Just swing pretty and let ’er rip!']);
    const how = c.full ? 'Reckon you can just lay into it – all out, friend!' : c.putt ? `Easy does it – around ${c.pct}% oughta do it.` : `Reckon around ${c.pct}% oughta do it.`;
    line = [`${open} ${c.club}${c.dist ? `, ${c.dist} out` : ''}. ${how}`, colour, cheer].filter(Boolean).join(' ');
  } else {
    const open = pick(r, ['Listen, pal.', 'Aye, right!', 'Come here, I’ll tell you something.', 'Now, I love you, but listen.']);
    const how = c.full ? 'Just give it laldy! You’ve got this!' : `${c.pct}%. Trust me, you’ll love it!`;
    const know = c.tip || (Math.abs(c.wind || 0) >= 3 ? `Wind’s ${c.wind > 0 ? 'in your face' : 'at your back'}.`
      : r() < 0.5 ? pick(r, ['I know every blade of grass on this course.', 'I’ve walked this hole drunk more times than you’ve had hot dinners.', 'Saw a man lose a ball in that rough in ’98. Never found it.', 'My brother-in-law hit one in there once. We don’t talk about him.']) : '');
    line = drunk([open, `${c.club}${where}.`, how, colour, know].filter(Boolean).join(' '), r);
  }
  const text = `${CADDIES[id].name}: ${line}`;
  const say = c.greet ? `${greeting(id)} ${line}` : line;
  return { text, say: say.replace(/\*hic\*/g, 'hic').replace(/&/g, 'and'), pct: shown, err };
}

export function greeting(id) {
  return { tech: 'Good day to you. Nigel, at your service. Shall we?', south: 'Howdy, partner! Bobby Ray here. Let’s have us some fun!', scot: 'Morning! *hic* Angus. I know this course better than my own mother. Don’t tell her. Lovely day for it!' }[id];
}

const TEMPO = {
  tech: {
    quick: ['Bit hurried, that.', 'Rather rushed. Do let the club arrive on its own.', 'A touch eager at the top, I fancy.'],
    slow: ['Rather a leisurely backswing.', 'We do have other groups behind us, you know.', 'A tad long at the top. Mind the dawdling.'],
    pure: ['Lovely tempo.', 'Beautifully paced.', 'That, if I may say, was rhythm.'],
  },
  south: {
    quick: ['Easy now, darlin’, no rush!', 'Whoa there, slow down, sugar. That ball ain’t goin’ nowhere!', 'Take your time, friend. Let it breathe.'],
    slow: ['Come on, sugar, that ball ain’t gettin’ any younger!', 'You fixin’ to take a nap up there, partner?', 'Little quicker next time, darlin’. Don’t overthink it!'],
    pure: ['Smooth as sweet tea!', 'Now that’s what I call rhythm, friend!', 'Slow and sweet, just like Sunday mornin’.'],
  },
  scot: {
    quick: ['You rushed it, pal, but that’s alright, we’ll get ’em next time!', 'Slow down, man! You swing like you’re late for the bus!', 'Where’s the fire? Take it back nice and slow.'],
    slow: ['Did you fall asleep back there? Ha! Pick it up a wee bit.', 'I’ve seen glaciers move faster, but we’ll get there!', 'Och, come on, pal, give it a go!'],
    pure: ['Aye, that’s the rhythm! Lovely!', 'Smooth as a good single malt, that!', 'Now that’s a tempo. I’ll drink to that!'],
    },
};
// after the swing: 'quick' | 'slow' | 'pure'
export function tempoLine(id, kind, r = Math.random, avoid = []) {
  return pickNew(r, TEMPO[id]?.[kind] || [], avoid);
}

// a line that is not one of the ones just said (a caddie who repeats himself is a bore)
function pickNew(r, list, avoid = []) {
  if (!list.length) return '';
  const fresh = list.filter((l) => !avoid.includes(l));
  return pick(r, fresh.length ? fresh : list);
}

// How the shot went, in the caddie's words. A situation (below) beats the general good / bad / ordinary pool.
const REACT = {
  tech: {
    great: ['Oh, well played!', 'Splendid. Absolutely splendid.', 'Textbook. Almost as if I planned it.'],
    miss: ['Ah. Unlucky, that.', 'Bit of a wobble, I fear.', 'Not quite what we discussed.'],
    ok: ['Perfectly serviceable.', 'Nothing to fret about there.', 'Carry on, then.', 'Tidy enough.'],
    sorry: ['Ah – that one’s on me. I was a touch out with the number. Terribly sorry.', 'I may have misjudged that percentage. Apologies.'],
    streak: ['That’s rather a run of them. Let us take a breath, shall we?', 'Three in a row is not a pattern, merely a suggestion. Reset.'],
    ace: ['A hole in one. I shall need to sit down.', 'Good heavens. I have never carried for one of those.'],
    birdie: ['A birdie! Quite the gentleman’s hole.', 'Under par. I shall make a note in the book.'],
    par: ['A sensible par. Steady as she goes.', 'Par. The backbone of any decent round.'],
    bogey: ['Well. We shall put that one behind us.', 'A bogey. Not our finest, but nor is it a catastrophe.'],
    holedLong: ['From that distance? Remarkable. Quite remarkable.', 'I would not have given that a prayer. Marvellous.'],
    water: ['Ah. Rather wet.', 'In the water. Do keep the clubs dry.', 'A swim, I’m afraid. Penalty stroke, and a fresh start.'],
    ob: ['Out of bounds. One must take the rough with the smooth, but not that rough.', 'Beyond the white stakes. Back to the tee, I fear.'],
    duff: ['That was not a contact I would have recommended.', 'Ah. We seem to have missed the ball, mostly.'],
    bunker: ['Into the sand. Delightful.', 'Bunker. Open the face, and do commit to it.'],
    nearpin: ['Oh, that is close. Properly close.', 'Splendid approach. A putt for a birdie, I should think.'],
    missShort: ['Ah. A short one, that. These are the cruel ones.', 'One does hate to see a short putt slip by.'],
    lagGood: ['Beautiful lag. Tap-in territory.', 'Well judged. Pace is everything.'],
    driveGood: ['Now that is a drive!', 'Down the middle and a long way. Capital.'],
    driveBad: ['Not the drive we had hoped for.', 'Ah. We shall be playing from somewhere interesting.'],
  },
  south: {
    great: ['Woo-wee, now THAT’S what I’m talkin’ about!', 'Pretty as a peach!', 'Lord, you hit that purdy!'],
    miss: ['Shake it off, partner. Next one’s yours.', 'Aw, that’s alright, darlin’. You’ll get ’em next time!', 'Chin up, friend. Ain’t nothin’ but a thing!'],
    ok: ['Solid, friend. Real solid.', 'That’ll do just fine, darlin’.', 'Keep on truckin’, partner!', 'Good swing, sugar. Keep it rollin’.'],
    streak: ['Hey now, we’re a couple bad ones in. Deep breath, friend. I still believe in ya!', 'Even Arnold hit ’em sideways. Next one’s a beauty, I can feel it!'],
    ace: ['A HOLE IN ONE?! Lord have mercy, I’m cryin’ here!', 'Friend, you just did the impossible! Drinks are on me!'],
    birdie: ['Birdie! Sing it with me, partner!', 'Under par! I knew it, I knew it, I KNEW it!'],
    par: ['Nice par, friend! Steady as a church bell.', 'Par! Can’t be mad at that, darlin’.'],
    bogey: ['Aw, one over ain’t the end of the world. On to the next, friend!', 'Bogey’s just a par that went to the bar. We’ll get it back!'],
    holedLong: ['Holy smokes, from way out there?! Pour me a sweet tea!', 'That’s a good one, sugar! The whole county heard that!'],
    water: ['Aw, shoot. The fish needed a golf ball, I reckon.', 'Splash! Well, they say the water’s fine. Next one clears it!'],
    ob: ['Out of bounds, friend. Happens to the best of us. Drop another!', 'Whoo, that one’s halfway to Georgia. Hit another!'],
    duff: ['Aw, that one got away from ya, darlin’. Shake it off!', 'Well, you made contact with something. That’s a start!'],
    bunker: ['Sand’s just a beach, partner. Splash it out of there!', 'In the bunker, huh? You’ve got the touch for this, I know it.'],
    nearpin: ['Look at that! You stuck it, friend!', 'Oh, that’s tasty. Right next to the flag, sugar!'],
    missShort: ['Aw, so close. These short ones are mean, darlin’.', 'That one lipped out of my heart, friend.'],
    lagGood: ['Pretty lag, sugar! Gonna be a gimme.', 'That’s dead weight, friend. Lovely touch!'],
    driveGood: ['Boom! That’ll play, darlin’. Hit it a mile!', 'Lord, that one’s still goin’!'],
    driveBad: ['That’s okay, partner. We’ll scramble it back!', 'Not our best, friend, but I got faith in your next one.'],
  },
  scot: {
    great: ['Aye, now THAT’S golf! I knew you had it in ye!', 'Ha ha, lovely! I’ll drink to that one!', 'That’s more like it! You must’ve been listening to me.'],
    miss: ['That wasn’t the club, that was you. But don’t worry, the next one’s a winner!', 'I gave you the perfect number, pal! Never mind, the next one’s ours.', 'Ah, you didnae listen. No bother, we’ll fix it!', 'I love you, but that was terrible. Great shot next, though, I can feel it!', 'My granny swings better than that, and she’s been dead years. Still, you’ll nail the next one!'],
    ok: ['Aye. Solid enough. On we go!', 'Could’ve been worse. Could’ve been better. Could’ve been a whisky!', 'Grand, pal. Keep it rolling.', 'Not bad at all. Carry on!'],
    streak: ['Two in a row, pal! That’s you, not me. But the next one’s coming, I know it!', 'Are you doing this on purpose? Never mind, a wee dram and we go again!'],
    ace: ['A HOLE IN ONE! Right, I’m drinking to that. Another one. And another!', 'In one! Forty years on this course and I’ve never seen it! Don’t tell the wife I’ve been crying!'],
    birdie: ['A birdie! That’s because you listened to me for once! Wee dram on that!', 'Under par! Aye, that’s the stuff!'],
    par: ['Par! Lovely, steady stuff. You’re a credit to me, pal.', 'Aye, a par. Good man! On to the next!'],
    bogey: ['A bogey, but it’s only one hole, pal. We’ll get it back!', 'One over. That was you, mind, but it’s no bother. Birdie next!'],
    holedLong: ['Och! From out there?! Ha ha! I’ll take the credit!', 'That went in?! Ha! I’ll never doubt you again. For about a minute!'],
    water: ['In the water! I told you about the water. Did I not tell you about the water? Never mind, drop another!', 'Splash! The fish got a free ball. Hit another, pal, you’ve got this!'],
    ob: ['Out of bounds! That was you, pal, not me. Hit another, you’ll get it!', 'That’s in the next county. Ha! Take another, the fresh air’s good for ye.'],
    duff: ['Was that a golf shot or a sneeze? Ha! Shake it off, pal.', 'You hit the ball with the wrong end of the club, did you? No bother, again!'],
    bunker: ['In the sand. That was you, pal, but you’ve got the touch for it. Open the face and hit behind it!', 'Bunker! Don’t worry, I’ve been in worse. Mostly at closing time.'],
    nearpin: ['Well, would you look at that! Next to the stick! Ha ha!', 'Aye, that’s a beauty! Birdie putt for you, pal!'],
    missShort: ['You missed THAT? My granny holes those, and she’s dead! Ah, never mind, we’ll get the next one.', 'A short one, and it slid by. That was you, pal! Chin up, it’s only golf.'],
    lagGood: ['That’ll do nicely! Tap-in, pal.', 'Lovely pace on that! I told you you could do it.'],
    driveGood: ['Now THAT’S a drive! Don’t you worry, the approach will be just as good!', 'Aye, that’s hit well! A wee dram for that one!'],
    driveBad: ['That drive was you, pal! But we’ll find it. Eventually. Probably.', 'Ach, the drive got away from ye. We’ll scramble it, I’ve done it drunk!'],
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

// What kind of moment it was, when it was a particular one (or '' for an ordinary shot).
// info is the shot's numbers; extra = { tee, par, strokes } from the game.
export function situationOf(info, extra = {}) {
  if (!info) return '';
  const holed = info.holed || info.result === 'holed';
  if (holed) {
    if (extra.strokes === 1) return 'ace';
    if (info.putt && info.startFt >= 15) return 'holedLong';
    const d = (extra.strokes ?? 0) - (extra.par ?? 0);
    return d < 0 ? 'birdie' : d === 0 ? 'par' : 'bogey';
  }
  if (info.result === 'water') return 'water';
  if (info.result === 'ob') return 'ob';
  if (info.putt) {
    if (info.startFt <= 6 && info.afterFt > 0.5) return 'missShort';
    if (info.startFt > 25 && info.afterFt < 3) return 'lagGood';
    return '';
  }
  if (info.duffed || (info.carryFrac != null && info.carryFrac < 0.3 && info.strikeQ < 0.85)) return 'duff';
  if (info.after === 'bunker') return 'bunker';
  if (info.onGreen && info.pinFt != null && info.pinFt < 10) return 'nearpin';
  if (extra.tee && (extra.par ?? 0) > 3) return info.after === 'fairway' && info.totalYd >= 230 ? 'driveGood' : ['rough', 'deep', 'bunker', 'straw'].includes(info.after) ? 'driveBad' : '';
  return '';
}

// The caddie's line for a shot: a particular moment first, then a run of misses, then the plain good / bad / ordinary
// pools. `err` is how far out Nigel's number was; `avoid` is what was said lately.
export function reaction(id, kind, { err = 0, situation = '', streak = 0, avoid = [] } = {}, r = Math.random) {
  const set = REACT[id];
  if (!set || !kind) return '';
  if (situation && set[situation]) return pickNew(r, set[situation], avoid);
  if (kind === 'miss' && streak >= 2 && set.streak) return pickNew(r, set.streak, avoid);
  if (id === 'tech' && kind === 'miss' && err) return pick(r, set.sorry);
  return pickNew(r, set[kind], avoid);
}
