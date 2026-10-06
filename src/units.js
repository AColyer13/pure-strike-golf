// Unit formatting for the yards / metres setting. Pure functions (no DOM) so they can be tested.
// Course data is authored in yards, feet and mph; the player's units setting decides what is shown.
const M_PER_YD = 0.9144, M_PER_FT = 0.3048, KMH_PER_MPH = 1.609344;

export const isMetric = (units) => units === 'm';
export const fmtWind = (mph, units) => (isMetric(units) ? `${Math.round(mph * KMH_PER_MPH)} km/h` : `${Math.round(mph)} mph`);
export const windUnit = (units) => (isMetric(units) ? 'km/h' : 'mph');
export const windValue = (mph, units) => Math.round(isMetric(units) ? mph * KMH_PER_MPH : mph);
// course-data distance in yards → "N yds" | "N m"
export const fmtYd = (yd, units) => (isMetric(units) ? `${Math.round(yd * M_PER_YD)} m` : `${Math.round(yd)} yds`);
// height difference in feet (always shown as a positive magnitude)
export const fmtElev = (ft, units) => {
  const a = Math.abs(ft);
  return isMetric(units) ? `${Math.max(1, Math.round(a * M_PER_FT))} m` : `${Math.round(a)} ft`;
};

// Rewrite "300-yard", "50–60 yards", "40 feet" etc. inside authored prose for the metric setting.
const MEASURE = /(\d[\d,]*)(?:\s?[–-]\s?(\d[\d,]*))?([\s-]?)(yards?|yds|feet|foot|ft)\b/gi;
export function localizeText(text, units) {
  if (!isMetric(units) || !text) return text;
  return text.replace(MEASURE, (all, a, b, sep, unit) => {
    const k = /^(f|F)/.test(unit) ? M_PER_FT : M_PER_YD;
    const conv = (s) => Math.round(+s.replace(/,/g, '') * k);
    return `${b ? `${conv(a)}–${conv(b)}` : conv(a)}${sep === '-' ? ' ' : sep || ' '}m`.replace(/ {2,}/g, ' ');
  });
}
