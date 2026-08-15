import { describe, expect, it } from "vitest";
import { computeKeywordCoverage, normalizeTailoredResult, safeWebUrl } from "./App.jsx";

describe("safeWebUrl", () => {
  it("normalizes normal web links", () => expect(safeWebUrl("github.com/example")).toBe("https://github.com/example"));
  it("rejects script and malformed links", () => {
    expect(safeWebUrl("javascript:alert(1)")).toBe("");
    expect(safeWebUrl('http://example.com\" onclick=\"alert(1)')).toBe("");
  });
});

describe("normalizeTailoredResult", () => {
  it("bounds scores, arrays, and unsafe AI links", () => {
    const result = normalizeTailoredResult({
      summary: "Summary", skills: "SQL", matchScore: 140, matchVerdict: "unknown",
      experienceStructured: [{ role: "Analyst", bullets: ["Built reports", 7] }],
      projectsStructured: [{ name: "Demo", link: "javascript:alert(1)", bullets: [] }],
    });
    expect(result.matchScore).toBe(100);
    expect(result.matchVerdict).toBe("moderate");
    expect(result.experienceStructured[0].bullets).toEqual(["Built reports"]);
    expect(result.projectsStructured[0].link).toBe("");
  });
});

describe("keyword coverage", () => {
  it("returns reproducible matches for a job", () => {
    const result = computeKeywordCoverage({ skills: "Python, SQL, AWS" }, "We need Python, SQL, AWS, Docker and Kubernetes experience.");
    expect(result.pct).toBe(60);
    expect(result.missing).toEqual(expect.arrayContaining(["docker", "kubernetes"]));
  });
});
