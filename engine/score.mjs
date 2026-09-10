/**
 * Readiness score.
 *
 * A percentage implies more precision than static checks can deliver — only
 * Google's own HTML5 validator and a policy reviewer decide acceptance. So the
 * number is defined in the simplest arguable way: start at 100, subtract a
 * fixed cost per finding, and never let a file with a blocker read as ready.
 *
 *   blocker  −25   rejected at upload, cannot click through, or a certain
 *                  policy disapproval
 *   warn      −8   accepted but frequently disapproved or measurably worse
 *   advice    −2   worth fixing when cheap
 *
 * The verdict is NOT just a function of the number. A blocker the converter
 * clears with one button is a different situation from one a person has to sit
 * down and solve, and saying "Will be rejected" about the first is how a tool
 * teaches people to ignore it. So blockers are split: `mustFix` counts the ones
 * with no automatic fix, and only those make a file read as rejected.
 */
export const PENALTY = { blocker: 25, warn: 8, advice: 2 };

export function score(findings) {
  const counts = { blocker: 0, warn: 0, advice: 0 };
  let cost = 0, mustFix = 0, autoFix = 0;
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
    cost += PENALTY[f.severity] || 0;
    if (f.severity !== 'blocker') continue;
    if (f.fix) autoFix++; else mustFix++;
  }
  const pct = Math.max(0, 100 - cost);

  let verdict;
  if (mustFix) verdict = { label: 'Will be rejected', tone: 'bad' };
  else if (autoFix) verdict = { label: 'Not uploadable as-is · Fix all clears it', tone: 'warn' };
  else if (pct >= 90) verdict = { label: counts.warn ? 'Ready, with warnings' : 'Ready to upload', tone: 'ok' };
  else if (counts.warn) verdict = { label: 'Uploadable · worth a look first', tone: 'warn' };
  else verdict = { label: 'Uploadable · minor notes', tone: 'ok' };

  return { pct, counts, verdict, cost, mustFix, autoFix };
}
