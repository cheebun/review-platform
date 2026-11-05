import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as legacy from "../../lib/repos";
import * as next from "./authors";

const known = [...legacy.REVIEW_AUTHORS, legacy.OWN_REVIEW_AUTHOR];
const recase = (s: string) =>
  fc
    .array(fc.boolean(), { minLength: s.length, maxLength: s.length })
    .map((flags) => [...s].map((c, i) => (flags[i] ? c.toUpperCase() : c.toLowerCase())).join(""));
const arbLogin = fc.oneof(
  fc.constantFrom(...known).chain(recase),
  fc.stringMatching(/^[A-Za-z0-9-]{1,39}$/),
);

describe("authors: old src/lib/repos vs new domain", () => {
  it("constants are identical", () => {
    expect(next.REVIEW_AUTHORS).toEqual(legacy.REVIEW_AUTHORS);
    expect(next.REVIEW_AUTHOR_LABELS).toEqual(legacy.REVIEW_AUTHOR_LABELS);
    expect(next.OWN_REVIEW_AUTHOR).toBe(legacy.OWN_REVIEW_AUTHOR);
    expect(next.DEFAULT_OPEN_PR_OWNER).toBe(legacy.DEFAULT_OPEN_PR_OWNER);
    expect(next.DEFAULT_OPEN_PR_REPO).toBe(legacy.DEFAULT_OPEN_PR_REPO);
  });

  it("isOwnReviewAuthor and isReviewAuthor agree", () => {
    fc.assert(
      fc.property(
        arbLogin,
        (a) =>
          next.isOwnReviewAuthor(a) === legacy.isOwnReviewAuthor(a) &&
          next.isReviewAuthor(a) === legacy.isReviewAuthor(a),
      ),
      { numRuns: 1000 },
    );
  });

  it("buildOwnPrCopyText agrees", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        (u, t) => next.buildOwnPrCopyText(u, t) === legacy.buildOwnPrCopyText(u, t),
      ),
    );
  });

  it("the merge and review-list rules are removed (FR-SHIP-01, architecture §4.2)", () => {
    const exported = Object.keys(next);
    for (const gone of ["shouldMergeAfterShip", "SHIP_NO_MERGE_AUTHORS", "isReviewListAuthor"]) {
      expect(exported).not.toContain(gone);
    }
  });
});
