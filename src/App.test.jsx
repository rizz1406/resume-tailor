import { describe, expect, it } from "vitest";
import { computeKeywordCoverage, normalizeProfile, normalizeSkills, normalizeTailoredResult, parseResumeTextLocally, safeWebUrl } from "./App.jsx";

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

describe("normalizeProfile", () => {
  it("turns malformed AI fields into safe form values", () => {
    const profile = normalizeProfile({ name: { unexpected: true }, email: null, skills: ["SQL"], experience: "Real experience" }, "Test");
    expect(profile).toMatchObject({ name: "", email: "", skills: "", experience: "Real experience", _label: "Test" });
  });
});

describe("local text resume parsing", () => {
  it("extracts a structured text resume without an API call", () => {
    const profile = parseResumeTextLocally("Jordan Lee\nData Analyst\njordan@example.com | +1 555-123-4567\n\nSKILLS\nSQL, Python\n\nEXPERIENCE\nData Analyst — Acme\n- Built reports");
    expect(profile).toMatchObject({ name: "Jordan Lee", title: "Data Analyst", email: "jordan@example.com", skills: "SQL, Python" });
    expect(profile.experience).toContain("Built reports");
    expect(profile.website).toBe("");
  });
});

describe("ATS skill formatting", () => {
  it("normalizes bullets, semicolons, duplicates, and newlines to commas", () => {
    expect(normalizeSkills("SQL; Python\nPower BI, SQL")).toBe("SQL, Python, Power BI");
  });
});

describe("keyword coverage", () => {
  it("returns reproducible matches for a job", () => {
    const result = computeKeywordCoverage({ skills: "Python, SQL, AWS" }, "We need Python, SQL, AWS, Docker and Kubernetes experience.");
    expect(result.pct).toBe(60);
    expect(result.missing).toEqual(expect.arrayContaining(["docker", "kubernetes"]));
  });
});
