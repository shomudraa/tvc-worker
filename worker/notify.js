/**
 * Sends the finished video link by email, so people don't have to sit on the
 * page for several minutes waiting for a generation to finish.
 *
 * Uses Resend over plain fetch, so there is no extra dependency.
 *
 * Env:
 *   RESEND_API_KEY   from resend.com. Without it, email is skipped silently.
 *   MAIL_FROM        e.g. "Ryze <film@yourdomain.com>". Must be a domain you
 *                    verified in Resend.
 *   PUBLIC_URL       e.g. https://tvc-worker.onrender.com (used to build the link)
 *   BRAND_NAME       used in the subject line
 */

export function emailEnabled() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

export function validEmail(v) {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;
}

export async function sendReadyEmail({ to, jobId, log = () => {} }) {
  if (!emailEnabled()) return log("email: not configured, skipping");
  if (!validEmail(to)) return log("email: invalid address, skipping");

  const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const brand = process.env.BRAND_NAME || "the film";
  const link = `${base}/watch/${jobId}`;

  const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111">
  <h1 style="font-size:24px;font-weight:600;margin:0 0 16px">Your film is ready</h1>
  <p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 24px">You're in ${brand}. Tap below to watch, download and share it.</p>
  <a href="${link}" style="display:inline-block;background:#C8102E;color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600;font-size:16px">Watch your film</a>
  <p style="font-size:13px;color:#888;margin:28px 0 0">This link works for 24 hours, then the video is deleted.</p>
</div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: [to],
      subject: `Your film is ready`,
      html,
    }),
  });

  if (!res.ok) {
    log(`email: failed ${res.status} ${(await res.text()).slice(0, 200)}`);
    return;
  }
  log(`email: sent to ${to.replace(/(.{2}).*(@.*)/, "$1***$2")}`);
}
