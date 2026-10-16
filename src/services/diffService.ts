import { DiffSegment } from '../types';

/**
 * Computes character-level or clause-level diff between original and suggested text.
 * Returns contiguous segments of 'equal', 'removed' (original only), and 'added' (suggested only).
 */
export function computeTextDiff(original: string, suggested: string): DiffSegment[] {
  if (original === suggested) {
    return [{ type: 'equal', text: original }];
  }
  if (!original) {
    return [{ type: 'added', text: suggested }];
  }
  if (!suggested) {
    return [{ type: 'removed', text: original }];
  }

  const n = original.length;
  const m = suggested.length;

  // For very large texts, use clause-level fallback
  if (n * m > 250000) {
    return computeClauseDiff(original, suggested);
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (original[i - 1] === suggested[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = n;
  let j = m;
  const rawSegments: DiffSegment[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1] === suggested[j - 1]) {
      rawSegments.push({ type: 'equal', text: original[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawSegments.push({ type: 'added', text: suggested[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      rawSegments.push({ type: 'removed', text: original[i - 1] });
      i--;
    }
  }

  rawSegments.reverse();

  // Merge consecutive segments of same type
  const merged: DiffSegment[] = [];
  for (const seg of rawSegments) {
    if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
      merged[merged.length - 1].text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

function computeClauseDiff(original: string, suggested: string): DiffSegment[] {
  const regex = /([^，。；！？\n]+[，。；！？\n]?)/g;
  const clausesA = original.match(regex) || [original];
  const clausesB = suggested.match(regex) || [suggested];

  const n = clausesA.length;
  const m = clausesB.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (clausesA[i - 1] === clausesB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = n;
  let j = m;
  const rawSegments: DiffSegment[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && clausesA[i - 1] === clausesB[j - 1]) {
      rawSegments.push({ type: 'equal', text: clausesA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawSegments.push({ type: 'added', text: clausesB[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      rawSegments.push({ type: 'removed', text: clausesA[i - 1] });
      i--;
    }
  }

  rawSegments.reverse();

  const merged: DiffSegment[] = [];
  for (const seg of rawSegments) {
    if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
      merged[merged.length - 1].text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}
