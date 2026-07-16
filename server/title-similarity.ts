// ---------------------------------------------------------------------------
// Title similarity
//
// Suggestion candidates from MusicBrainz must not duplicate releases already
// in the library, but MB titles rarely match ours byte-for-byte: edition
// qualifiers ("Amber (Deluxe Edition)"), punctuation/diacritic differences
// ("Selected Ambient Works 85–92" vs "85-92"), and reissue suffixes
// ("Tri Repetae++") are all the same record to a listener. These helpers bias
// towards treating titles as duplicates — a missed suggestion is cheap, a
// duplicate suggestion is the bug.
// ---------------------------------------------------------------------------

/**
 * Canonical form of a release title for duplicate detection: lowercased,
 * diacritics stripped, trailing bracketed qualifiers removed ("(Deluxe
 * Edition)", "[2009 Remaster]"), all remaining punctuation collapsed to
 * single spaces.
 */
export function normalizeTitleForMatch(title: string): string {
  let result = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

  // Strip trailing bracketed qualifiers, repeatedly — "Album (Deluxe) [2009]"
  // loses both. Brackets elsewhere in the title are part of the name and kept.
  let previous: string;
  do {
    previous = result;
    result = result.replace(/\s*[([{][^()[\]{}]*[)\]}]\s*$/, "");
  } while (result !== previous && result.length > 0);
  // A title that was nothing but brackets ("(Untitled)") keeps its content.
  if (result.length === 0) result = title.toLowerCase();

  return result
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const currentRow = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const substitution = previousRow[j] + (a[i] === b[j] ? 0 : 1);
      currentRow.push(Math.min(substitution, previousRow[j + 1] + 1, currentRow[j] + 1));
    }
    previousRow = currentRow;
  }
  return previousRow[b.length];
}

/**
 * Whether two release titles refer to the same record for duplicate-exclusion
 * purposes: identical after normalisation, one extends the other at a word
 * boundary ("Tri Repetae" vs "Tri Repetae Plus"), or the edit distance is
 * small relative to the title length (typos, punctuation-only variants).
 */
export function titlesMatchClosely(a: string, b: string): boolean {
  const na = normalizeTitleForMatch(a);
  const nb = normalizeTitleForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  // Word-boundary prefix: "amber" matches "amber live" but not "ambergris".
  // Very short titles ("ii", "x") extend into unrelated ones too easily.
  if (shorter.length >= 4 && longer.startsWith(`${shorter} `)) return true;

  const threshold = Math.max(1, Math.floor(longer.length * 0.2));
  // Levenshtein is O(len²); titles this different can't be within threshold.
  if (longer.length - shorter.length > threshold) return false;
  return levenshtein(na, nb) <= threshold;
}

/** Whether `title` matches, or is close to, any title in `existing`. */
export function titleMatchesAny(title: string, existing: Iterable<string>): boolean {
  for (const other of existing) {
    if (titlesMatchClosely(title, other)) return true;
  }
  return false;
}
