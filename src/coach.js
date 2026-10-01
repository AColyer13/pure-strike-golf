// Post-shot coaching: explains *why* the ball did what it did, using the same
// numbers a launch monitor or a coach would use. Each lesson is shown a
// limited number of times per round so the advice stays fresh.

const seen = new Map();
export function resetCoach() { seen.clear(); }

function pick(list, max = 2) {
  list.sort((a, b) => b.pri - a.pri);
  const out = [];
  for (const l of list) {
    const n = seen.get(l.id) || 0;
    if (n >= (l.limit ?? 2)) continue;
    out.push(l);
    seen.set(l.id, n + 1);
    if (out.length >= max) break;
  }
  return out;
}

const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const i0 = (x) => Math.round(x);

export function coachShot(s) {
  const L = [];
  if (s.putt) {
    const ft = s.afterFt;
    if (s.holed) {
      if (s.startFt > 20) L.push({ id: 'longmake', pri: 5, title: 'Drained it!', text: `A ${i0(s.startFt)}-footer. Tour pros make only ~15% from 20–25 ft – speed control gave it a chance.` });
      return pick(L);
    }
    if (s.shortFt > 0.2) {
      L.push({ id: 'short', pri: 8, limit: 3, title: 'Never up, never in', text: `Left ${f1(s.shortFt)} ft short. A putt that stops short has a 0% chance. Dave Pelz's research: the best speed rolls ~17 in (43 cm) past the cup – it holds its line through footprints and the lumpy area around the hole.` });
    } else if (ft > 5 && s.startFt > 25) {
      L.push({ id: 'lag', pri: 7, title: 'Lag putting', text: `From ${i0(s.startFt)} ft the goal is to two-putt: picture a 3-foot circle around the hole. Distance errors cost more than line errors on long putts.` });
    } else if (ft > 4) {
      L.push({ id: 'firm', pri: 6, title: 'Too firm', text: `Rolled ${f1(ft)} ft past. On fast greens (Stimp ${s.stimp}) a putt hit ~20% too hard runs several feet by – and takes less break, so it misses high.` });
    }
    if (Math.abs(s.lateralFt) > 0.4 && s.startFt < 30) {
      const low = s.missLow;
      L.push({ id: low ? 'lowside' : 'highside', pri: 5, title: low ? 'Missed on the low side' : 'Missed on the high side',
        text: low ? 'Most amateurs under-read break. A ball dying at the hole breaks the most – play more break and let it fall in from the high side.' : 'Too much break for the speed. Firmer putts break less; slower putts break more.' });
    }
    if (s.uphillIn != null && Math.abs(s.uphillIn) > 6) {
      L.push({ id: 'elevputt', pri: 3, title: s.uphillIn > 0 ? 'Uphill putt' : 'Downhill putt', text: `The hole was ${Math.abs(i0(s.uphillIn))} inches ${s.uphillIn > 0 ? 'above' : 'below'} the ball. Uphill putts need more pace and break less; downhill putts need a lighter touch and break more.` });
    }
    return pick(L);
  }

  const ld = s.ld;
  // penalty outcomes
  if (s.result === 'water') {
    L.push({ id: 'water', pri: 10, limit: 3, title: 'Penalty area', text: 'Red penalty area: 1 stroke. Options: replay from where you hit (stroke and distance), drop on the line back from the hole through where the ball crossed the edge, or drop within 2 club-lengths of the crossing point, no nearer the hole.' });
  } else if (s.result === 'ob') {
    L.push({ id: 'ob', pri: 10, limit: 3, title: 'Out of bounds', text: 'Stroke and distance: add a penalty stroke and replay from the original spot. That is effectively a 2-stroke penalty – why course management off the tee matters.' });
  }

  // curvature from face-to-path (D-plane)
  const f2p = ld.f2p;
  if (Math.abs(f2p) > 2.2) {
    const dir = f2p > 0 ? 'right' : 'left';
    const shape = Math.abs(f2p) > 6 ? (f2p > 0 ? 'slice' : 'hook') : (f2p > 0 ? 'fade' : 'draw');
    L.push({ id: 'dplane-' + shape, pri: Math.abs(f2p) > 5 ? 8 : 5, title: `Why it curved: ${shape}`,
      text: `Face ${f1(Math.abs(ld.face))}° ${ld.face >= 0 ? 'open' : 'closed'}, path ${f1(Math.abs(ld.path))}° ${ld.path >= 0 ? 'in-to-out' : 'out-to-in'} → face ${f1(Math.abs(f2p))}° ${f2p > 0 ? 'open' : 'closed'} to the path. The spin axis tilted ${f1(Math.abs(ld.axisTilt))}° and the ball curved ${dir}. (D-plane: the start line comes mostly from the face; the curve comes from face-to-path.)` });
  } else if (Math.abs(ld.hLaunch) > 3 && Math.abs(f2p) < 2) {
    L.push({ id: 'pushpull', pri: 5, title: ld.hLaunch > 0 ? 'Push' : 'Pull', text: `Started ${f1(Math.abs(ld.hLaunch))}° ${ld.hLaunch > 0 ? 'right' : 'left'} and flew straight: face and path pointed the same way, so there was no curve – only a wrong start line.` });
  }
  // strike quality
  if (s.club && !s.club.putter && (ld.strikeSmash ?? ld.smash) < s.club.smash * 0.93 && s.lie !== 'splash' && s.lie !== 'deep') {
    const lost = ld.clubMph * (s.club.smash - (ld.strikeSmash ?? ld.smash));
    L.push({ id: 'smash', pri: 6, title: 'Off-centre strike', text: `Smash factor ${ld.smash.toFixed(2)} (max for this club ≈ ${s.club.smash.toFixed(2)}). Missing the sweet spot cost ~${i0(lost)} mph of ball speed, about ${i0(lost * 2.2)} yards.` });
  }
  // lie
  if (s.lie === 'rough' || s.lie === 'second') {
    L.push({ id: 'flyer', pri: 5, title: 'Lie: rough', text: 'Grass trapped between the face and ball cut the spin sharply. Less spin = lower, knuckling flight that runs out on landing (a "flyer"). Plan for extra roll from the rough.' });
  } else if (s.lie === 'deep') {
    L.push({ id: 'deep', pri: 6, title: 'Lie: deep rough', text: 'Thick grass wraps the hosel and slows the club. Take a lofted club, get back in play, and accept a bogey at worst.' });
  } else if (s.lie === 'splash') {
    L.push({ id: 'splash', pri: 6, title: 'Explosion shot', text: 'From a greenside bunker the club enters the sand ~2 inches behind the ball and never touches it. The sand throws the ball out – so you swing about twice as hard as for a pitch of the same length.' });
  } else if (s.lie === 'bunker') {
    L.push({ id: 'fwbunker', pri: 4, title: 'Fairway bunker', text: 'Pick it clean: ball speed is reduced. Take one more club and make sure the loft clears the lip.' });
  }
  // sloping lie
  if (Math.abs(ld.lieFace) > 1.5) {
    L.push({ id: 'slopeface', pri: 5, title: ld.lieFace < 0 ? 'Ball above your feet' : 'Ball below your feet', text: `A lofted face on a sloping lie points ${ld.lieFace < 0 ? 'left' : 'right'} – here ~${f1(Math.abs(ld.lieFace))}°. The more loft, the bigger the effect: aim ${ld.lieFace < 0 ? 'right' : 'left'} of the target.` });
  }
  // approach distance control
  if (s.approach && s.result === 'ok') {
    if (s.shortYd > 8) L.push({ id: 'shortapp', pri: 6, title: 'Came up short', text: `Finished ${i0(s.shortYd)} yds short of the pin. Most amateur approach misses are short: they choose clubs by their best shot, not their average. Pick the club whose *average carry* reaches the middle of the green.` });
    else if (s.longYd > 12 && s.totalYd - s.carryYd > 12 && s.longYd - (s.totalYd - s.carryYd) < 8) L.push({ id: 'release', pri: 5, title: 'Flew it the right distance – then it ran', text: `It carried to about pin-high but released ${i0(s.totalYd - s.carryYd)} yds after landing at ${i0(s.descent)}°. On a raised or firm green, play for the finish, not the carry: land it short and let it feed on, or use more loft for a steeper landing.` });
    else if (s.longYd > 12) L.push({ id: 'longapp', pri: 4, title: 'Long', text: `Finished ${i0(s.longYd)} yds past the pin. Remember the plays-like number: downhill and downwind shots fly further.` });
  }
  if (s.windAdj != null && Math.abs(s.windAdj) >= 6) {
    L.push({ id: s.windAdj > 0 ? 'headwind' : 'tailwind', pri: 3, title: s.windAdj > 0 ? 'Into the wind' : 'Downwind', text: s.windAdj > 0 ? 'A headwind hurts more than a tailwind helps: it increases lift and drag, so the ball balloons. Swing smoother and take more club – a lower-spinning, lower shot holds its line better.' : 'Downwind the ball flies further, but the wind reduces the lift from backspin – it lands with less bite and releases more on firm ground.' });
  }
  if (s.elevAdj != null && Math.abs(s.elevAdj) >= 6) {
    L.push({ id: 'elev', pri: 3, title: s.elevAdj > 0 ? 'Uphill shot' : 'Downhill shot', text: `The target was ${Math.abs(i0(s.elevFt))} ft ${s.elevAdj > 0 ? 'above' : 'below'} you: that is worth ~${Math.abs(i0(s.elevAdj))} yards. Rule of thumb ≈ 1 yard per 3 feet of elevation.` });
  }
  if ((s.onGreen || s.approach) && s.descent != null && s.descent < 36 && !s.club.putter && s.carryYd > 120) {
    L.push({ id: 'descent', pri: 3, title: 'Shallow landing', text: `Descent angle ${i0(s.descent)}° – below ~40° a ball releases on firm greens. Higher launch and more spin produce steeper landings that stop quickly.` });
  }
  if (s.isTee && s.par >= 4 && s.result === 'ok') {
    if (s.after === 'fairway') L.push({ id: 'fir', pri: 2, limit: 1, title: 'Fairway hit', text: 'From the fairway tour players hit the green ~70% of the time from 150 yds; from the rough only ~55%. Position is worth strokes.' });
  }
  if (ld.launch && s.club?.key === 'DR' && ld.spinRpm > 3500 && s.result === 'ok') {
    L.push({ id: 'drspin', pri: 2, title: 'Driver spin', text: `Spin ${i0(ld.spinRpm)} rpm. The optimal driver window is ~2,200–2,700 rpm with 12–15° launch: excess spin makes the ball climb and lose carry and roll.` });
  }
  return pick(L);
}
