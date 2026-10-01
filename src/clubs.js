// Club data. Tour numbers are TrackMan PGA Tour averages (club speed, ball speed,
// launch, spin, carry). Amateur profiles are derived from TrackMan / Arccos
// averages for scratch and ~15 handicap golfers.

// key, name, loft, club mph, smash, launch deg, spin rpm, spin loft, tour carry (yd)
const TOUR = [
  ['DR', 'Driver',        10.5, 113, 1.48, 10.9, 2686, 13,  275],
  ['3W', '3 Wood',        15,   107, 1.48, 9.2,  3655, 17,  243],
  ['5W', '5 Wood',        18,   103, 1.47, 9.4,  4350, 20,  230],
  ['3H', 'Hybrid',        20,   100, 1.46, 10.2, 4437, 21,  225],
  ['4I', '4 Iron',        23,    96, 1.43, 11.0, 4836, 24,  203],
  ['5I', '5 Iron',        26,    94, 1.40, 12.1, 5361, 27,  194],
  ['6I', '6 Iron',        29,    92, 1.38, 14.1, 6231, 30,  183],
  ['7I', '7 Iron',        33,    90, 1.33, 16.3, 7097, 33,  172],
  ['8I', '8 Iron',        37,    87, 1.32, 18.1, 7998, 37,  160],
  ['9I', '9 Iron',        41,    85, 1.28, 20.4, 8647, 41,  148],
  ['PW', 'Pitching Wedge',45,    83, 1.23, 24.2, 9304, 45,  136],
  ['GW', 'Gap Wedge',     50,    80, 1.19, 27.5, 9700, 50,  120],
  ['SW', 'Sand Wedge',    56,    77, 1.14, 31.0, 9900, 55,  103],
  ['LW', 'Lob Wedge',     60,    74, 1.10, 34.0, 10000, 58,  88],
];

export const PROFILES = {
  tour:    { name: 'Tour Pro',       desc: 'PGA Tour average: 113 mph driver swing, ~275 yd carry.', speed: 1.0, smash: 1.0, spin: 1.0, launch: 0 },
  scratch: { name: 'Scratch Golfer', desc: 'Low handicap amateur: ~105 mph driver, ~250 yd carry.',    speed: 0.93, smash: 0.99, spin: 0.98, launch: 0.5 },
  mid:     { name: '15 Handicap',    desc: 'Typical club golfer: ~93 mph driver, ~210 yd carry.',        speed: 0.83, smash: 0.96, spin: 1.08, launch: 1.0 },
  senior:  { name: 'Smooth Swinger', desc: 'Slower speed, same fundamentals: ~80 mph driver, ~175 yd carry.', speed: 0.72, smash: 0.95, spin: 1.1, launch: 2.0 },
};

export function buildBag(profileKey) {
  const p = PROFILES[profileKey] || PROFILES.tour;
  const bag = TOUR.map(([key, name, loft, speed, smash, launch, spin, spinLoft, tourCarry]) => ({
    key, name, loft,
    speed: speed * p.speed,
    smash: Math.min(smash * p.smash, 1.5),
    launch: launch + p.launch * (loft < 20 ? 1 : 0.6),
    spin: spin * p.spin * (0.9 + 0.1 * p.speed),
    spinLoft,
    faceWeight: Math.min(0.88, Math.max(0.68, 0.9 - loft * 0.0035)),
    tourCarry,
    putter: false,
  }));
  bag.push({ key: 'PT', name: 'Putter', loft: 3, putter: true, speed: 0, smash: 0, launch: 0, spin: 0, spinLoft: 0, faceWeight: 0.9 });
  return bag;
}
