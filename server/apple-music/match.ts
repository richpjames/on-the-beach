/**
 * Title/artist normalisation for Apple Music result matching.
 *
 * Deliberately weaker than `title-similarity.ts`: that one strips diacritics
 * and trailing qualifiers to decide whether two releases are the *same record*,
 * which is the right question for MusicBrainz suggestions and the wrong one
 * here. Apple's search already scopes the results; all this has to do is make
 * "Sign O' the Times" and "Sign O the Times" compare equal.
 *
 * `catalog.ts` and `scrape.ts` each carried a byte-identical private copy
 * before the two moved into this folder.
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
