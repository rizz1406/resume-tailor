import React, { useState, useRef, useEffect } from "react";
import html2pdf from "html2pdf.js";

// ─── Persistence (localStorage) ─────────────────────────────────────────────
const LS_KEY = "resumeTailor.apiKey";
const LS_PROFILE = "resumeTailor.myProfile";   // the user's own saved profile
const LS_HISTORY = "resumeTailor.history";
const loadLS = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const saveLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const DEFAULT_PROFILE = {
  name: "", title: "", email: "", phone: "", location: "",
  linkedin: "", github: "", website: "",
  skills: "", experience: "", projects: "", education: "", certifications: "",
};

// ─── LaTeX (with per-item links) ─────────────────────────────────────────────
function esc(s = "") {
  return String(s)
    .replace(/\\/g, "\\textbackslash{}").replace(/&/g, "\\&").replace(/%/g, "\\%")
    .replace(/\$/g, "\\$").replace(/#/g, "\\#").replace(/_/g, "\\_")
    .replace(/\{/g, "\\{").replace(/\}/g, "\\}")
    .replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
}
const urlize = (u = "") => (u.startsWith("http") ? u : "https://" + u);

function buildLatex(r) {
  const contactBits = [
    r.email && `\\href{mailto:${esc(r.email)}}{${esc(r.email)}}`,
    r.phone && esc(r.phone),
    r.location && esc(r.location),
    r.linkedin && `\\href{${esc(urlize(r.linkedin))}}{LinkedIn}`,
    r.github && `\\href{${esc(urlize(r.github))}}{GitHub}`,
    r.website && `\\href{${esc(urlize(r.website))}}{Website}`,
  ].filter(Boolean);
  const bulletList = (items) => items && items.length
    ? `\\begin{itemize}[leftmargin=1.2em, itemsep=1pt, topsep=2pt, parsep=0pt]\n${items.map((b) => `  \\item ${esc(b)}`).join("\n")}\n\\end{itemize}` : "";
  const expBody = (r.experienceStructured || []).map((e) =>
    `\\textbf{${esc(e.role || "")}} \\hfill ${esc(e.dates || "")}\\\\\n\\textit{${esc(e.company || "")}${e.location ? ", " + esc(e.location) : ""}}\n` + bulletList(e.bullets)
  ).join("\n\\vspace{4pt}\n");
  const projBody = (r.projectsStructured || []).map((p) => {
    const nameLatex = p.link ? `\\href{${esc(urlize(p.link))}}{${esc(p.name || "")}}` : `\\textbf{${esc(p.name || "")}}`;
    const nm = p.link ? `\\textbf{${nameLatex}}` : nameLatex;
    return `${nm}${p.tech ? " \\textnormal{\\small(" + esc(p.tech) + ")}" : ""}\n` + bulletList(p.bullets);
  }).join("\n\\vspace{3pt}\n");
  const eduBody = (r.educationStructured || []).map((ed) =>
    `\\textbf{${esc(ed.degree || "")}} \\hfill ${esc(ed.dates || "")}\\\\\n\\textit{${esc(ed.school || "")}${ed.location ? ", " + esc(ed.location) : ""}}`
  ).join("\\\\[3pt]\n");
  const certBody = (r.certificationsStructured || []).length
    ? "\\begin{itemize}[leftmargin=1.2em, itemsep=1pt, topsep=2pt, parsep=0pt]\n" +
      r.certificationsStructured.map((c) => `  \\item ${c.link ? `\\href{${esc(urlize(c.link))}}{${esc(c.name || "")}}` : esc(c.name || "")}`).join("\n") +
      "\n\\end{itemize}"
    : (r.certifications ? esc(r.certifications) : "");
  const plain = (title, body) => body && body.trim() ? `\\section{${esc(title)}}\n${esc(body)}\n` : "";
  return `\\documentclass[11pt,letterpaper]{article}
\\usepackage[margin=0.65in]{geometry}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\pagestyle{empty}
\\renewcommand{\\section}[1]{\\vspace{6pt}\\noindent\\textbf{\\large #1}\\vspace{2pt}\\hrule\\vspace{4pt}}
\\setlength{\\parindent}{0pt}
\\begin{document}
\\begin{center}
  {\\LARGE \\textbf{${esc(r.name || "Your Name")}}}\\\\[2pt]
  ${r.title ? `{\\large ${esc(r.title)}}\\\\[3pt]` : ""}
  ${contactBits.join(" $\\bullet$ ")}
\\end{center}
\\vspace{4pt}
${plain("Summary", r.summary)}
${plain("Skills", r.skills)}
${expBody ? `\\section{Experience}\n${expBody}\n` : ""}
${projBody ? `\\section{Projects}\n${projBody}\n` : ""}
${eduBody ? `\\section{Education}\n${eduBody}\n` : ""}
${certBody ? `\\section{Certifications}\n${certBody}\n` : ""}
\\end{document}`;
}

// ─── Gemini ──────────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-3.5-flash";
const geminiURL = (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
async function geminiCall(key, parts) {
  const res = await fetch(geminiURL(key), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts }] }) });
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 400 && /API key not valid/i.test(t)) throw new Error("Invalid API key.");
    if (res.status === 404) throw new Error("Model unavailable — Google may have retired it. Update GEMINI_MODEL.");
    if (res.status === 429) throw new Error("Rate limit reached — wait a minute and retry.");
    throw new Error(`Gemini error ${res.status}: ${t.slice(0, 120)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) throw new Error("Empty response from Gemini.");
  return text;
}
const stripJson = (t) => t.replace(/```json/gi, "").replace(/```/g, "").trim();

async function extractJDFromImage(key, base64, mimeType) {
  return geminiCall(key, [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: "Extract the full job description text from this screenshot. Return only the raw text, no commentary." }]);
}
async function parseResumeToProfile(key, text) {
  const prompt = `Extract this resume text into a structured profile. Copy contact details (name, email, phone, links) EXACTLY as they appear in the text — never reformat, complete, or "professionalize" an email or any contact field. If a field is absent, leave it as an empty string. Return ONLY valid JSON (no markdown):
{"name":"","title":"","email":"","phone":"","location":"","linkedin":"","github":"","website":"","skills":"comma separated","experience":"free text of roles/companies/dates/bullets","projects":"free text","education":"free text","certifications":"comma separated"}

RESUME TEXT:
${text}`;
  return JSON.parse(stripJson(await geminiCall(key, [{ text: prompt }])));
}
async function tailorResume(key, profile, jd) {
  const prompt = `You are an expert ATS resume writer. Given a candidate's raw profile and a target job description, produce a tailored, ATS-friendly resume. Rewrite experience/project bullets to emphasize achievements and keywords relevant to the job (strong action verbs, quantify only where the source supports it — NEVER fabricate metrics, companies, dates, or skills). Reorder skills so the most job-relevant come first. Stay strictly truthful.

For projects and certifications, if the source profile contains a URL for an item, put it in the "link" field; otherwise leave "link" empty.

Return ONLY valid JSON (no markdown):
{
  "summary": "2-3 line summary tailored to the job",
  "skills": "comma-separated, most relevant first",
  "experienceStructured": [{"role":"","company":"","location":"","dates":"","bullets":["",""]}],
  "projectsStructured": [{"name":"","tech":"","link":"","bullets":[""]}],
  "educationStructured": [{"degree":"","school":"","location":"","dates":""}],
  "certificationsStructured": [{"name":"","link":""}],
  "keywordsMatched": ["keywords reflected"],
  "keywordsMissing": ["important job keywords NOT in the background"],
  "matchScore": 0-100 integer,
  "fabricationWarnings": ["claims not grounded in the profile — empty if none"],
  "notes": "1-2 sentences on what you emphasized"
}

CANDIDATE PROFILE (raw):
${JSON.stringify(profile, null, 2)}

TARGET JOB DESCRIPTION:
${jd}`;
  return JSON.parse(stripJson(await geminiCall(key, [{ text: prompt }])));
}
async function writeCoverLetter(key, profile, jd, result) {
  const prompt = `Write a concise professional cover letter (3 short paragraphs, ~200 words) for this candidate applying to this job. Warm but not flowery. Reference 2-3 real achievements from the profile that match the job. Invent nothing. Start "Dear Hiring Manager," if no name known; sign off with the candidate's name. Return ONLY the letter text.
CANDIDATE: ${JSON.stringify(profile)}
HIGHLIGHTS: ${JSON.stringify(result?.notes || "")}
JOB: ${jd}`;
  return geminiCall(key, [{ text: prompt }]);
}

// ─── Theme: soft liquid-glass on a rich dark purple base ─────────────────────
const P = {
  ink: "#f2eefc", muted: "#b6acd6", faint: "#8b81ad",
  accent: "#b39dff", accentDeep: "#c9b8ff", accentSoft: "rgba(150,120,255,0.18)",
  glass: "rgba(255,255,255,0.07)", glassBorder: "rgba(255,255,255,0.14)",
  glassHi: "rgba(255,255,255,0.12)",
  danger: "#ff9b8a", dangerSoft: "rgba(255,90,70,0.15)",
  warn: "#f2c879", warnSoft: "rgba(240,180,60,0.14)", ok: "#7fe0ad",
  field: "rgba(255,255,255,0.06)", fieldBorder: "rgba(255,255,255,0.16)",
};
const font = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// Background options for the toggle. Photos are stable Unsplash CDN URLs (free, no key).
// "gradient" always works offline as a fallback.
const BACKGROUNDS = [
  { id: "forest", label: "Autumn forest", type: "photo", url: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1920&q=80" },
  { id: "mountain", label: "Misty mountains", type: "photo", url: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80" },
  { id: "ocean", label: "Ocean dusk", type: "photo", url: "https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=1920&q=80" },
  { id: "aurora", label: "Aurora", type: "photo", url: "https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=1920&q=80" },
  { id: "gradient", label: "Soft gradient", type: "gradient" },
];
const glassCard = {
  background: "rgba(255,255,255,0.07)", backdropFilter: "blur(25px) saturate(200%)", WebkitBackdropFilter: "blur(25px) saturate(200%)",
  border: "2px solid rgba(255,255,255,0.15)", borderRadius: 20, padding: 24,
  boxShadow: "0 10px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.14)",
};

function Field({ label, value, onChange, placeholder, area, rows = 3, half, type = "text" }) {
  const shared = { width: "100%", marginTop: 5, padding: "9px 11px", fontSize: 13, fontFamily: font, border: `1px solid ${P.fieldBorder}`, borderRadius: 11, background: P.field, boxSizing: "border-box", color: P.ink, outline: "none" };
  return (
    <label style={{ display: "block", marginBottom: 13, flex: half ? "1 1 45%" : "1 1 100%" }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: P.muted, letterSpacing: 0.2 }}>{label}</span>
      {area
        ? <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{ ...shared, resize: "vertical" }} />
        : <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={shared} />}
    </label>
  );
}

export default function App() {
  const [tab, setTab] = useState("profile");
  const [apiKey, setApiKey] = useState(() => loadLS(LS_KEY, ""));
  const [showKey, setShowKey] = useState(false);
  const [myProfile, setMyProfile] = useState(() => loadLS(LS_PROFILE, DEFAULT_PROFILE));
  const [mode, setMode] = useState("me"); // "me" | "other"
  const [otherProfile, setOtherProfile] = useState(DEFAULT_PROFILE);
  const [jd, setJd] = useState("");
  const [jobLabel, setJobLabel] = useState("");
  const [jdImgName, setJdImgName] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [tex, setTex] = useState("");
  const [coverLetter, setCoverLetter] = useState("");
  const [clLoading, setClLoading] = useState(false);
  const [history, setHistory] = useState(() => loadLS(LS_HISTORY, []));
  const [profileSaved, setProfileSaved] = useState(false);
  const [bgId, setBgId] = useState(() => loadLS("resumeTailor.bg", "forest"));
  useEffect(() => saveLS("resumeTailor.bg", bgId), [bgId]);
  const bg = BACKGROUNDS.find((b) => b.id === bgId) || BACKGROUNDS[0];
  const cycleBg = () => { const i = BACKGROUNDS.findIndex((b) => b.id === bgId); setBgId(BACKGROUNDS[(i + 1) % BACKGROUNDS.length].id); };
  const jdFileRef = useRef();
  const resumeFileRef = useRef();
  const previewRef = useRef();

  useEffect(() => saveLS(LS_KEY, apiKey), [apiKey]);
  useEffect(() => saveLS(LS_PROFILE, myProfile), [myProfile]);
  useEffect(() => saveLS(LS_HISTORY, history), [history]);

  const profile = mode === "me" ? myProfile : otherProfile;
  const setProfileField = (k) => (v) => {
    if (mode === "me") setMyProfile((p) => ({ ...p, [k]: v }));
    else setOtherProfile((p) => ({ ...p, [k]: v }));
  };
  const profileFilled = profile.name && profile.experience && profile.email;
  const hasKey = apiKey.trim().length > 10;

  async function handleJDImage(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (!hasKey) { setStatus("Add your free Gemini API key first."); return; }
    setJdImgName(file.name); setStatus("Reading screenshot…"); setLoading(true);
    try {
      const base64 = await fileToBase64(file);
      setJd(await extractJDFromImage(apiKey, base64, file.type || "image/png"));
      setStatus("Extracted job description. Review below, then generate.");
    } catch (err) { setStatus("Couldn't read image: " + err.message); }
    finally { setLoading(false); }
  }
  async function handleResumeUpload(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (!hasKey) { setStatus("Add your Gemini API key first."); return; }
    setStatus("Reading your resume…"); setLoading(true);
    try {
      let parsed;
      if (file.type.startsWith("image/")) {
        const base64 = await fileToBase64(file);
        const text = await extractJDFromImage(apiKey, base64, file.type);
        parsed = await parseResumeToProfile(apiKey, text);
      } else if (file.type === "application/pdf") {
        const base64 = await fileToBase64(file);
        const raw = await geminiCall(apiKey, [{ inline_data: { mime_type: "application/pdf", data: base64 } }, { text: "Extract all text from this resume PDF, raw text only." }]);
        parsed = await parseResumeToProfile(apiKey, raw);
      } else {
        const text = await file.text();
        parsed = await parseResumeToProfile(apiKey, text);
      }
      const cleaned = { ...DEFAULT_PROFILE, ...parsed };
      if (mode === "me") setMyProfile(cleaned); else setOtherProfile(cleaned);
      setStatus("Filled from your resume — review the fields, tweak anything, then add a job.");
    } catch (err) { setStatus("Couldn't parse resume: " + err.message); }
    finally { setLoading(false); }
  }

  async function generate() {
    if (!hasKey) { setStatus("Add your free Gemini API key first."); return; }
    if (!profileFilled) { setTab("profile"); setStatus("Fill in at least name, email, and experience."); return; }
    if (!jd.trim()) { setStatus("Add a job description."); return; }
    setLoading(true); setStatus("Tailoring the resume…"); setCoverLetter("");
    try {
      const tailored = await tailorResume(apiKey, profile, jd);
      const merged = { name: profile.name, title: profile.title, email: profile.email, phone: profile.phone, location: profile.location, linkedin: profile.linkedin, github: profile.github, website: profile.website, ...tailored };
      const t = buildLatex(merged);
      setResult(merged); setTex(t); setTab("result"); setStatus("Done — review, then download.");
      setHistory((h) => [{ id: uid(), label: jobLabel || deriveLabel(jd), person: mode === "me" ? "Me" : (profile.name || "Someone else"), date: new Date().toISOString(), jd, result: merged, tex: t }, ...h].slice(0, 50));
    } catch (err) { setStatus("Generation failed: " + err.message); }
    finally { setLoading(false); }
  }
  async function genCoverLetter() {
    if (!hasKey || !result) return; setClLoading(true);
    try { setCoverLetter(await writeCoverLetter(apiKey, profile, jd, result)); }
    catch (err) { setStatus("Cover letter failed: " + err.message); }
    finally { setClLoading(false); }
  }
  function openHistory(e) { setResult(e.result); setTex(e.tex); setJd(e.jd); setCoverLetter(""); setTab("result"); setStatus(`Loaded: ${e.label}`); }
  function deleteHistory(id) { setHistory((h) => h.filter((e) => e.id !== id)); }
  function downloadTex() {
    const blob = new Blob([tex], { type: "text/plain" }); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${(result?.name || "resume").replace(/\s+/g, "_")}.tex`; a.click(); URL.revokeObjectURL(url);
  }
  function downloadPdf() {
    if (!previewRef.current) return; setStatus("Building PDF…");
    html2pdf().set({ margin: [0.5, 0.55, 0.5, 0.55], filename: `${(result?.name || "resume").replace(/\s+/g, "_")}.pdf`, image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: "in", format: "letter", orientation: "portrait" }, enableLinks: true }).from(previewRef.current).save().then(() => setStatus("PDF downloaded."));
  }

  const tabBtn = (active, extra = {}) => ({ padding: "7px 15px", fontSize: 13, fontWeight: 600, fontFamily: font, border: `1px solid ${active ? "transparent" : P.glassBorder}`, background: active ? "linear-gradient(135deg,#8b6bff,#a855f7)" : P.glassHi, color: active ? "#fff" : P.ink, borderRadius: 11, cursor: "pointer", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", ...extra });
  const score = result?.matchScore;
  const scoreColor = score >= 75 ? P.ok : score >= 50 ? P.warn : P.danger;

  return (
    <div style={{ fontFamily: font, minHeight: "100vh", color: P.ink, position: "relative", overflow: "hidden", background: "#0f0a1e" }}>
      {/* Background layer — photo or gradient, with liquid refraction. */}
      <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}>
        {bg.type === "photo" ? (
          <div style={{ position: "absolute", inset: "-40px", backgroundImage: `url(${bg.url})`, backgroundSize: "cover", backgroundPosition: "center", filter: "url(#liquid-refraction)" }} />
        ) : (
          <div style={{ position: "absolute", inset: "-40px", filter: "url(#liquid-refraction)" }}>
            <div style={{ position: "absolute", top: "-8%", left: "-5%", width: 520, height: 520, borderRadius: "50%", background: "radial-gradient(circle, #7b5cff, transparent 65%)", filter: "blur(40px)", opacity: 0.7 }} />
            <div style={{ position: "absolute", top: "20%", right: "-10%", width: 560, height: 560, borderRadius: "50%", background: "radial-gradient(circle, #b84dff, transparent 65%)", filter: "blur(48px)", opacity: 0.55 }} />
            <div style={{ position: "absolute", bottom: "-15%", left: "25%", width: 620, height: 620, borderRadius: "50%", background: "radial-gradient(circle, #3d7bff, transparent 65%)", filter: "blur(52px)", opacity: 0.5 }} />
          </div>
        )}
        {/* readability veil so light text stays legible over any photo */}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(15,10,30,0.55), rgba(15,10,30,0.68))" }} />
      </div>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "34px 20px 70px", position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: -0.6, background: `linear-gradient(90deg, #d9ccff, #b39dff)`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Resume Tailor</h1>
            <p style={{ color: P.muted, fontSize: 14, marginTop: 5 }}>Paste a job → a tailored, ATS-friendly resume with a match score, cover letter, and clickable links.</p>
          </div>
          <button onClick={cycleBg} title="Change background" style={{ ...tabBtn(false), whiteSpace: "nowrap" }}>🖼 {bg.label}</button>
        </div>

        <div style={{ ...glassCard, padding: "12px 16px", margin: "18px 0" }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: P.accentDeep, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 7 }}>Gemini API key {hasKey ? "✓ saved" : "— required"}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste your free Gemini API key…" style={{ flex: "1 1 260px", padding: "9px 11px", fontSize: 13, fontFamily: font, border: `1px solid ${P.fieldBorder}`, borderRadius: 11, background: P.field, color: P.ink, outline: "none" }} />
            <button style={tabBtn(false)} onClick={() => setShowKey((s) => !s)}>{showKey ? "Hide" : "Show"}</button>
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ ...tabBtn(false), textDecoration: "none" }}>Get a free key ↗</a>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, margin: "16px 0", flexWrap: "wrap" }}>
          <button style={tabBtn(tab === "profile")} onClick={() => setTab("profile")}>1 · Profile</button>
          <button style={tabBtn(tab === "job")} onClick={() => setTab("job")}>2 · Job</button>
          <button style={tabBtn(tab === "result")} onClick={() => setTab("result")} disabled={!result}>3 · Result</button>
          <button style={tabBtn(tab === "history")} onClick={() => setTab("history")}>History ({history.length})</button>
        </div>

        {status && <div style={{ ...glassCard, padding: "9px 14px", fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>{loading && <Spinner />}{status}</div>}

        {tab === "profile" && (
          <div style={glassCard}>
            <div style={{ display: "flex", gap: 6, marginBottom: 16, background: P.field, padding: 5, borderRadius: 13, width: "fit-content", border: `1px solid ${P.glassBorder}` }}>
              <button onClick={() => setMode("me")} style={{ ...tabBtn(mode === "me"), border: "none" }}>This is me</button>
              <button onClick={() => setMode("other")} style={{ ...tabBtn(mode === "other"), border: "none" }}>Someone else</button>
            </div>
            <div style={{ fontSize: 12.5, color: P.muted, marginBottom: 16 }}>
              {mode === "me"
                ? "Your saved profile. Fill it once (or auto-fill from a resume below) and hit Save — it loads automatically every visit."
                : "A blank profile for making a resume for someone else. Your own saved profile stays untouched."}
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
              <button style={{ ...tabBtn(false), background: P.accentSoft, borderColor: "transparent", color: P.accentDeep }} onClick={() => resumeFileRef.current?.click()}>⬆ Auto-fill from an existing resume</button>
              {mode === "me" && (
                <button style={{ ...tabBtn(false) }} onClick={() => { saveLS(LS_PROFILE, myProfile); setProfileSaved(true); setStatus("Profile saved — it'll load automatically next time."); setTimeout(() => setProfileSaved(false), 2500); }}>
                  {profileSaved ? "✓ Saved" : "💾 Save my profile"}
                </button>
              )}
              <input ref={resumeFileRef} type="file" accept=".pdf,.txt,.md,image/*" hidden onChange={handleResumeUpload} />
            </div>

            <SectionLabel>Contact</SectionLabel>
            <Row>
              <Field half label="Full name *" value={profile.name} onChange={setProfileField("name")} placeholder="Jane Doe" />
              <Field half label="Target title" value={profile.title} onChange={setProfileField("title")} placeholder="Senior Data Engineer" />
            </Row>
            <Row>
              <Field half label="Email *" value={profile.email} onChange={setProfileField("email")} placeholder="jane@email.com" />
              <Field half label="Phone" value={profile.phone} onChange={setProfileField("phone")} placeholder="+1 555 123 4567" />
            </Row>
            <Row>
              <Field half label="Location" value={profile.location} onChange={setProfileField("location")} placeholder="Austin, TX" />
              <Field half label="LinkedIn URL" value={profile.linkedin} onChange={setProfileField("linkedin")} placeholder="linkedin.com/in/…" />
            </Row>
            <Row>
              <Field half label="GitHub URL" value={profile.github} onChange={setProfileField("github")} placeholder="github.com/…" />
              <Field half label="Website" value={profile.website} onChange={setProfileField("website")} placeholder="janedoe.dev" />
            </Row>
            <SectionLabel>Your material (AI structures & tailors this)</SectionLabel>
            <Field area rows={4} label="Experience * — roles, companies, dates, what you did" value={profile.experience} onChange={setProfileField("experience")} placeholder={"Data Engineer, Acme Corp (2021–present)\n- Built GCP data pipelines...\n- Cut costs 30%..."} />
            <Field area rows={3} label="Skills" value={profile.skills} onChange={setProfileField("skills")} placeholder="Python, SQL, BigQuery, dbt, Airflow, GCP…" />
            <Field area rows={3} label="Projects — add a repo URL after each for a clickable link" value={profile.projects} onChange={setProfileField("projects")} placeholder={"Syndication Pipeline — dbt + BigQuery — github.com/you/syndication\nMarfeel ETL — Cloud Run — github.com/you/marfeel"} />
            <Field area rows={2} label="Education" value={profile.education} onChange={setProfileField("education")} placeholder="B.S. Computer Science, State University (2019)" />
            <Field area rows={2} label="Certifications — add a verify URL for a clickable link" value={profile.certifications} onChange={setProfileField("certifications")} placeholder="GCP Professional Data Engineer — credential.net/abc123" />
            <button style={{ ...tabBtn(true), padding: "11px 22px", marginTop: 8 }} onClick={() => setTab("job")}>Next: add a job →</button>
          </div>
        )}

        {tab === "job" && (
          <div style={glassCard}>
            <Field label="Job label (optional — for your history)" value={jobLabel} onChange={setJobLabel} placeholder="e.g. Google — Data Engineer" />
            <SectionLabel>Upload a screenshot of the job posting</SectionLabel>
            <div onClick={() => jdFileRef.current?.click()} style={{ border: `2px dashed ${P.fieldBorder}`, borderRadius: 14, padding: 24, textAlign: "center", cursor: "pointer", background: P.field, marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{jdImgName ? `📎 ${jdImgName}` : "Click to upload a screenshot"}</div>
              <div style={{ fontSize: 12, color: P.muted, marginTop: 4 }}>PNG / JPG — the AI reads it automatically</div>
              <input ref={jdFileRef} type="file" accept="image/*" hidden onChange={handleJDImage} />
            </div>
            <div style={{ textAlign: "center", color: P.muted, fontSize: 12, margin: "10px 0" }}>— or —</div>
            <SectionLabel>Paste the job description</SectionLabel>
            <textarea value={jd} onChange={(e) => setJd(e.target.value)} rows={10} placeholder="Paste the full job description here…" style={{ width: "100%", padding: "11px 13px", fontSize: 13, fontFamily: font, border: `1px solid ${P.fieldBorder}`, borderRadius: 12, background: P.field, boxSizing: "border-box", resize: "vertical", color: P.ink, outline: "none" }} />
            <button style={{ ...tabBtn(true), padding: "12px 24px", marginTop: 12, opacity: loading ? 0.6 : 1 }} onClick={generate} disabled={loading}>{loading ? "Working…" : "✦ Generate tailored resume"}</button>
          </div>
        )}

        {tab === "result" && result && (
          <div style={glassCard}>
            {typeof score === "number" && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                <div style={{ width: 58, height: 58, borderRadius: "50%", border: `4px solid ${scoreColor}`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18, color: scoreColor }}>{score}</div>
                <div><div style={{ fontSize: 13, fontWeight: 700 }}>ATS match score</div><div style={{ fontSize: 12, color: P.muted }}>{score >= 75 ? "Strong fit" : score >= 50 ? "Moderate — add missing keywords" : "Weak — may need more relevant experience"}</div></div>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <button style={{ ...tabBtn(true), padding: "10px 18px" }} onClick={downloadPdf}>⬇ PDF</button>
              <button style={{ ...tabBtn(false), padding: "10px 18px" }} onClick={downloadTex}>⬇ .tex</button>
              <button style={{ ...tabBtn(false), padding: "10px 18px", opacity: clLoading ? 0.6 : 1 }} onClick={genCoverLetter} disabled={clLoading}>{clLoading ? "Writing…" : "✦ Cover letter"}</button>
              <a href="https://www.overleaf.com" target="_blank" rel="noreferrer" style={{ ...tabBtn(false), padding: "10px 18px", textDecoration: "none", display: "inline-block" }}>Overleaf ↗</a>
            </div>
            {result.fabricationWarnings?.length > 0 && (
              <div style={{ background: P.warnSoft, border: `1px solid #f0d5a0`, borderRadius: 12, padding: "10px 12px", fontSize: 13, marginBottom: 14, color: P.warn }}>
                <strong>⚠ Verify before sending:</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{result.fabricationWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            {result.notes && <div style={{ background: P.accentSoft, borderRadius: 12, padding: "10px 12px", fontSize: 13, marginBottom: 14 }}><strong>What the AI emphasized:</strong> {result.notes}</div>}
            <Row>
              {result.keywordsMatched?.length > 0 && (
                <div style={{ flex: "1 1 45%", marginBottom: 12 }}><SectionLabel>✓ Covered</SectionLabel>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{result.keywordsMatched.map((k, i) => <span key={i} style={{ background: "rgba(47,125,87,0.12)", color: P.ok, fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 20 }}>{k}</span>)}</div>
                </div>
              )}
              {result.keywordsMissing?.length > 0 && (
                <div style={{ flex: "1 1 45%", marginBottom: 12 }}><SectionLabel>✗ Missing</SectionLabel>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{result.keywordsMissing.map((k, i) => <span key={i} style={{ background: P.dangerSoft, color: P.danger, fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 20 }}>{k}</span>)}</div>
                </div>
              )}
            </Row>
            {coverLetter && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><SectionLabel>Cover letter</SectionLabel><button style={{ ...tabBtn(false), padding: "4px 12px", fontSize: 12 }} onClick={() => { navigator.clipboard?.writeText(coverLetter); setStatus("Cover letter copied."); }}>Copy</button></div>
                <div style={{ border: `1px solid rgba(109,78,201,0.2)`, borderRadius: 12, background: "rgba(255,255,255,0.7)", padding: 16, fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{coverLetter}</div>
              </div>
            )}
            <SectionLabel>Live preview — exactly what your PDF looks like (links are clickable)</SectionLabel>
            <div ref={previewRef} style={{ border: `1px solid rgba(109,78,201,0.15)`, borderRadius: 12, background: "#fff", padding: 30, fontSize: 12.5, lineHeight: 1.5, color: "#111" }} dangerouslySetInnerHTML={{ __html: renderResumeInner(result) }} />
            <details style={{ marginTop: 16 }}><summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13, color: P.muted }}>View LaTeX source</summary>
              <pre style={{ background: "#1a1330", color: "#d9cff5", padding: 14, borderRadius: 12, fontSize: 11.5, overflow: "auto", marginTop: 8, whiteSpace: "pre-wrap" }}>{tex}</pre>
            </details>
          </div>
        )}

        {tab === "history" && (
          <div style={glassCard}>
            <SectionLabel>Your generated resumes</SectionLabel>
            {history.length === 0 ? <p style={{ fontSize: 13, color: P.muted }}>No resumes yet.</p> :
              history.map((e) => (
                <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 13px", border: `1px solid rgba(109,78,201,0.15)`, borderRadius: 12, marginBottom: 8, background: "rgba(255,255,255,0.5)" }}>
                  <div><div style={{ fontWeight: 600, fontSize: 13 }}>{e.label} <span style={{ color: P.muted, fontWeight: 400 }}>· {e.person}</span></div>
                    <div style={{ fontSize: 11.5, color: P.muted }}>{new Date(e.date).toLocaleString()}{typeof e.result?.matchScore === "number" ? ` · match ${e.result.matchScore}` : ""}</div></div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={{ ...tabBtn(false), padding: "5px 12px", fontSize: 12 }} onClick={() => openHistory(e)}>Open</button>
                    <button style={{ ...tabBtn(false), padding: "5px 12px", fontSize: 12, color: P.danger }} onClick={() => deleteHistory(e.id)}>Delete</button>
                  </div>
                </div>
              ))}
          </div>
        )}

        <p style={{ textAlign: "center", color: P.muted, fontSize: 11.5, marginTop: 30 }}>Your data stays in your browser except requests to Google's Gemini API. No server, no tracking.</p>
      </div>
    </div>
  );
}

function fileToBase64(file) { return new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result.split(",")[1]); rd.onerror = rej; rd.readAsDataURL(file); }); }
function deriveLabel(jd) { const f = (jd || "").split("\n").find((l) => l.trim().length > 3); return (f || "Untitled job").trim().slice(0, 60); }
function Row({ children }) { return <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{children}</div>; }
function SectionLabel({ children }) { return <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: P.accentDeep, margin: "14px 0 8px" }}>{children}</div>; }
function Spinner() { return <span style={{ width: 13, height: 13, border: `2px solid rgba(109,78,201,0.25)`, borderTopColor: P.accent, borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite" }}><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style></span>; }

function renderResumeInner(r) {
  const e2 = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const url = (u) => (u.startsWith("http") ? u : "https://" + u);
  const link = (href, label) => `<a href="${e2(url(href))}" style="color:#4a2f9e;text-decoration:none">${e2(label)}</a>`;
  const contactParts = [
    r.email && link("mailto:" + r.email, r.email), r.phone && e2(r.phone), r.location && e2(r.location),
    r.linkedin && link(r.linkedin, "LinkedIn"), r.github && link(r.github, "GitHub"), r.website && link(r.website, "Website"),
  ].filter(Boolean);
  const sec = (t, body) => body ? `<h2 style="font-size:13px;border-bottom:1px solid #333;margin:12px 0 6px;padding-bottom:2px;text-transform:uppercase;letter-spacing:1px">${t}</h2>${body}` : "";
  const exp = (r.experienceStructured || []).map((e) => `<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between"><strong>${e2(e.role)}</strong><span>${e2(e.dates)}</span></div><div style="font-style:italic;color:#333">${e2(e.company)}${e.location ? ", " + e2(e.location) : ""}</div><ul style="margin:4px 0 0;padding-left:18px">${(e.bullets || []).map((b) => `<li>${e2(b)}</li>`).join("")}</ul></div>`).join("");
  const proj = (r.projectsStructured || []).map((p) => { const nm = p.link ? link(p.link, p.name) : `<strong>${e2(p.name)}</strong>`; const nmb = p.link ? `<strong>${nm}</strong>` : nm; return `<div style="margin-bottom:6px">${nmb}${p.tech ? ` <span style="color:#555">(${e2(p.tech)})</span>` : ""}<ul style="margin:3px 0 0;padding-left:18px">${(p.bullets || []).map((b) => `<li>${e2(b)}</li>`).join("")}</ul></div>`; }).join("");
  const edu = (r.educationStructured || []).map((e) => `<div style="display:flex;justify-content:space-between"><span><strong>${e2(e.degree)}</strong>, ${e2(e.school)}${e.location ? ", " + e2(e.location) : ""}</span><span>${e2(e.dates)}</span></div>`).join("");
  const certs = (r.certificationsStructured || []).length
    ? `<ul style="margin:0;padding-left:18px">${r.certificationsStructured.map((c) => `<li>${c.link ? link(c.link, c.name) : e2(c.name)}</li>`).join("")}</ul>`
    : (r.certifications ? `<div>${e2(r.certifications)}</div>` : "");
  return `<div style="text-align:center;margin-bottom:8px"><div style="font-size:20px;font-weight:800">${e2(r.name)}</div>${r.title ? `<div style="font-size:13px">${e2(r.title)}</div>` : ""}<div style="font-size:11px;color:#333;margin-top:3px">${contactParts.join(" &bull; ")}</div></div>${sec("Summary", r.summary ? `<div>${e2(r.summary)}</div>` : "")}${sec("Skills", r.skills ? `<div>${e2(r.skills)}</div>` : "")}${sec("Experience", exp)}${sec("Projects", proj)}${sec("Education", edu)}${sec("Certifications", certs)}`;
}
