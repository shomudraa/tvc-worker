const BRAND = {
  name: "Brand",
  // Put logo.png in the web/ folder and it replaces the text automatically.
  caption: "I Am inside Ryze TVC",
  footNote: "Your photo is deleted after processing. Videos are removed after 24 hours.",
};

const API = (window.WORKER_URL || "").replace(/\/$/, "");
const api = (p) => API + p;
const $ = (id) => document.getElementById(id);
const stage = $("stage");
const fileInput = $("fileInput");
const previewImg = $("previewImg");
const consent = $("consent");
const startBtn = $("startBtn");
const previewError = $("previewError");
const statusLine = $("statusLine");
const bar = $("bar");
const result = $("result");
const afterRow = $("afterRow");
const bg = $("bg");
const emailInput = $("email");
const emailField = $("emailField");

$("brandName").textContent = BRAND.name;
if (API) bg.src = api("/master.mp4");
// Worker reachability check so the page never fails silently
// Show the logo if one exists, otherwise keep the text.
// The src is set here, after the handlers are attached, so a missing file
// never leaves a broken image icon on the page.
const logo = $("brandLogo");
logo.onload = () => { logo.hidden = false; $("brandName").hidden = true; };
logo.onerror = () => { logo.remove(); };
logo.src = api("/logo.png");

fetch(api("/health"), { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((h) => { if (h.email) emailField.hidden = false; })
  .catch(() => {
    $("footNote").textContent = "Rendering service is not connected yet. Set WORKER_URL in config.js.";
  });

let file = null;
let jobId = null;
let pollTimer = null;
let copyTimer = null;

// Opened from an emailed link: go straight to the finished film
const fromLink = new URLSearchParams(location.hash.slice(1)).get("job");
if (fromLink) {
  jobId = fromLink;
  fetch(api(`/jobs/${fromLink}`), { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => { if (d.state === "completed") reveal(d.videoUrl); else startRendering(); })
    .catch(() => {});
}
$("footNote").textContent = BRAND.footNote;


const COPY = [
  "Reading your selfie",
  "Finding your face",
  "Matching light and colour",
  "Placing you in the film",
  "Checking every frame",
  "Almost there",
];

const ERRORS = {
  no_file: "No photo was received. Choose a selfie and try again.",
  not_an_image: "That file isn't a photo. Use a JPG or PNG.",
  invalid_image: "That photo couldn't be read. Try a different one.",
  no_face: "We couldn't find a face. Face the camera in good light.",
  multiple_faces: "Only one face, please. Crop to just you.",
  not_a_photo: "Use a real photo of yourself, not a screenshot or drawing.",
  moderation: "That photo can't be used here. Try another selfie.",
  consent_required: "Tick the box to continue.",
  rate_limited: "You've made a few already. Try again in an hour.",
  daily_cap: "Today's films are all made. Come back tomorrow.",
  paused: "We're taking a short break. Back soon.",
  failed: "The film couldn't be made. Please try again later.",
  server_error: "Something broke on our side. Try again in a moment.",
  network: "Lost connection. Check your signal and try again.",
};

function setState(s) { stage.dataset.state = s; }

function showError(code, detail) {
  clearInterval(pollTimer); clearInterval(copyTimer);
  $("errorText").textContent = ERRORS[code] || ERRORS.server_error;
  const d = $("errorDetail");
  if (d) { d.textContent = detail || ""; d.hidden = !detail; }
  setState("error");
}

fileInput.addEventListener("change", () => {
  file = fileInput.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { previewError.textContent = "Photo is over 10MB. Pick a smaller one."; return; }
  previewError.textContent = "";
  previewImg.src = URL.createObjectURL(file);
  consent.checked = false;
  startBtn.disabled = true;
  setState("preview");
});

consent.addEventListener("change", () => { startBtn.disabled = !consent.checked; });
$("retakeBtn").addEventListener("click", () => { fileInput.value = ""; fileInput.click(); });

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  const fd = new FormData();
  fd.append("face", file);
  fd.append("consent", "true");
  const email = (emailInput?.value || "").trim();
  if (email) fd.append("email", email);
  try {
    const res = await fetch(api("/jobs"), { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { startBtn.disabled = false; previewError.textContent = ERRORS[data.error] || ERRORS.server_error; return; }
    jobId = data.jobId;
    startRendering();
  } catch {
    startBtn.disabled = false;
    previewError.textContent = ERRORS.network;
  }
});

function startRendering() {
  setState("rendering");
  let i = 0, pct = 4;
  statusLine.textContent = COPY[0];
  bar.style.width = pct + "%";
  copyTimer = setInterval(() => {
    i = Math.min(i + 1, COPY.length - 1);
    statusLine.textContent = COPY[i];
    pct = Math.min(pct + 14, 92);
    bar.style.width = pct + "%";
  }, 4000);
  pollTimer = setInterval(poll, 3000);
  poll();
}

async function poll() {
  try {
    const res = await fetch(api(`/jobs/${jobId}`), { cache: "no-store" });
    if (!res.ok) return showError("server_error");
    const data = await res.json();
    if (data.state === "completed") {
      clearInterval(pollTimer); clearInterval(copyTimer);
      bar.style.width = "100%";
      setTimeout(() => reveal(data.videoUrl), 500);
    } else if (data.state === "failed") {
      showError("failed", data.detail);
    }
  } catch {
    /* transient network error: keep polling */
  }
}

function reveal(url) {
  url = api(url);
  result.src = url;
  $("downloadBtn").href = url;
  afterRow.classList.remove("show");
  setState("reveal");
  bg.pause();
  result.muted = false;
  result.play().catch(() => { result.muted = true; result.play(); });
  result.addEventListener("ended", () => afterRow.classList.add("show"), { once: true });
  // if autoplay with sound was blocked, still show actions after a beat
  setTimeout(() => afterRow.classList.add("show"), 4000);
}

/**
 * Share the video file itself through the phone's own share sheet, so
 * Instagram, Facebook, WhatsApp and the rest appear as options. Sharing the
 * file is the only route that reaches Instagram from a web page: it has no
 * web share link of its own. The caption is attached as text, though some
 * apps (Instagram especially) ignore prefilled text and require a paste.
 */
$("shareBtn").addEventListener("click", async () => {
  const btn = $("shareBtn");
  const url = new URL(result.src, location.href).href;
  const caption = BRAND.caption;

  try { await navigator.clipboard?.writeText(caption); } catch {}

  if (navigator.share) {
    try {
      const blob = await (await fetch(url)).blob();
      const f = new File([blob], "my-film.mp4", { type: "video/mp4" });
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        await navigator.share({ files: [f], text: caption, title: caption });
        return;
      }
      await navigator.share({ url, text: caption, title: caption });
      return;
    } catch { /* user cancelled or share failed */ }
  }
  await navigator.clipboard?.writeText(`${caption} ${url}`);
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = "Share"), 1600);
});

$("captionBtn").addEventListener("click", async () => {
  const btn = $("captionBtn");
  await navigator.clipboard?.writeText(BRAND.caption);
  btn.textContent = "Caption copied";
  setTimeout(() => (btn.textContent = "Copy caption"), 1600);
});

function reset() {
  result.pause(); result.removeAttribute("src"); result.load();
  bg.play().catch(() => {});
  file = null; jobId = null; fileInput.value = "";
  bar.style.width = "0%";
  setState("idle");
}
$("againBtn").addEventListener("click", reset);
$("errorRetry").addEventListener("click", reset);
