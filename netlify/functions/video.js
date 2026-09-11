// Video generation — two tiers:
//   basic — server-side slideshow via ffmpeg-static (photos + crossfade + optional music)
//   ai    — image-to-video via Replicate (Kling v1.6 by default, Runway Gen-3 fallback)
//
// Pricing: +150% net margin target.
//   basic: cost ~$0.005 (compute) → 200 credits = $0.20 (+3900% headroom, but keep as entry price)
//   ai:    cost ~$0.30 (Kling 5s)  → 800 credits = $0.80 (+167%)
//
// Requires env:
//   REPLICATE_API_TOKEN — for AI tier
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — for credit accounting

const { getCredits, saveCredits } = require('./_store');
const { logEvent } = require('./_analytics');

const COST_USD = { basic: 0.005, ai: 0.30 };
const VIDEO_COST_BASIC = 200;   // $0.005 → $0.20 (safe margin, entry tier)
const VIDEO_COST_AI    = 800;   // $0.30  → $0.80 (+167% net)

// Replicate model versions (updated 2026):
//   Kling 1.6 Standard image-to-video (5s, 720p): kwaivgi/kling-v1.6-standard
//   Runway Gen-3 Alpha Turbo: runwayml/gen3a-turbo (fallback)
const REPLICATE_KLING = 'kwaivgi/kling-v1.6-standard';
const REPLICATE_RUNWAY = 'runwayml/gen3a-turbo';

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true;
  const provided = event.headers['x-access-code'] || event.headers['X-Access-Code'];
  return provided === required;
}

// ---------- BASIC: ffmpeg slideshow ----------
async function generateSlideshow(photosBase64, opts = {}) {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { execFile } = require('child_process');
  const util = require('util');
  const execFileP = util.promisify(execFile);

  let ffmpegPath;
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (e) {
    throw new Error('ffmpeg-static not installed');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slideshow-'));
  const files = [];
  try {
    photosBase64.forEach((b64, i) => {
      const buf = Buffer.from(b64.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
      const f = path.join(tmp, `img${String(i).padStart(3, '0')}.jpg`);
      fs.writeFileSync(f, buf);
      files.push(f);
    });

    const perImg = opts.durationPerImage || 2.5;
    const fade = 0.5;
    const outPath = path.join(tmp, 'out.mp4');

    // Build ffmpeg command: concat images with xfade transitions
    const args = [];
    files.forEach(f => { args.push('-loop', '1', '-t', String(perImg), '-i', f); });

    // Filter chain — simple scale + concat with xfade between successive segments
    const n = files.length;
    let filter = '';
    for (let i = 0; i < n; i++) {
      filter += `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[v${i}];`;
    }
    if (n === 1) {
      filter += `[v0]copy[outv]`;
    } else {
      // chain xfade
      let cur = 'v0';
      let offset = perImg - fade;
      for (let i = 1; i < n; i++) {
        const next = i === n - 1 ? 'outv' : `x${i}`;
        filter += `[${cur}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset}[${next}];`;
        cur = next;
        offset += perImg - fade;
      }
      filter = filter.replace(/;$/, '');
    }

    args.push('-filter_complex', filter, '-map', '[outv]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '28', '-movflags', '+faststart', '-y', outPath);

    await execFileP(ffmpegPath, args, { timeout: 20000, maxBuffer: 20 * 1024 * 1024 });
    const buf = fs.readFileSync(outPath);
    return { videoB64: buf.toString('base64'), sizeBytes: buf.length, durationSec: perImg * n - fade * (n - 1) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ---------- AI: Replicate image-to-video ----------
async function generateAIVideo(imageB64, prompt) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN not set');

  // Kling requires a URL, not base64 — upload as data URL
  const startInput = imageB64.startsWith('data:') ? imageB64 : `data:image/png;base64,${imageB64}`;

  const attempts = [
    { name: 'kling', model: REPLICATE_KLING, input: { start_image: startInput, prompt: prompt || 'cinematic motion, smooth camera', duration: 5, cfg_scale: 0.5, aspect_ratio: '16:9' } },
    { name: 'runway', model: REPLICATE_RUNWAY, input: { prompt_image: startInput, prompt_text: prompt || 'cinematic motion', duration: 5 } },
  ];

  let lastErr = null;
  for (const a of attempts) {
    try {
      const createRes = await fetch(`https://api.replicate.com/v1/models/${a.model}/predictions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'wait=25',
        },
        body: JSON.stringify({ input: a.input }),
      });
      const pred = await createRes.json();
      if (!createRes.ok) { lastErr = pred?.detail || `HTTP ${createRes.status}`; continue; }
      // If wait=25 didn't finish, poll a bit
      let final = pred;
      const deadline = Date.now() + 20000;
      while (final.status !== 'succeeded' && final.status !== 'failed' && final.status !== 'canceled' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2500));
        const poll = await fetch(final.urls.get, { headers: { Authorization: `Bearer ${token}` } });
        final = await poll.json();
      }
      if (final.status === 'succeeded') {
        const videoUrl = Array.isArray(final.output) ? final.output[0] : final.output;
        return { videoUrl, provider: a.name };
      }
      lastErr = final.error || `status=${final.status}`;
    } catch (e) {
      lastErr = String(e).slice(0, 200);
    }
  }
  throw new Error(`Replicate failed: ${lastErr}`);
}

// ---------- HANDLER ----------
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!checkAccessCode(event)) return json(401, { error: 'unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }
  const { user, tier = 'basic', photos, image, prompt } = body;
  if (!user) return json(400, { error: 'missing_user' });

  const cost = tier === 'ai' ? VIDEO_COST_AI : VIDEO_COST_BASIC;

  // Credits check
  let record = await getCredits(user);
  if (record.credits < cost) {
    return json(402, {
      error: 'insufficient_credits',
      credits: record.credits,
      needed: cost,
      message: `Видео ${tier === 'ai' ? 'AI' : 'слайдшоу'} стоит ${cost} кредитов. Пополните баланс.`,
    });
  }

  try {
    let result;
    if (tier === 'basic') {
      if (!Array.isArray(photos) || photos.length < 2) return json(400, { error: 'need_2_plus_photos' });
      if (photos.length > 10) return json(400, { error: 'max_10_photos' });
      const slideshow = await generateSlideshow(photos);
      result = { tier: 'basic', videoB64: slideshow.videoB64, sizeBytes: slideshow.sizeBytes, durationSec: slideshow.durationSec, provider: 'ffmpeg-slideshow' };
    } else if (tier === 'ai') {
      if (!image) return json(400, { error: 'missing_image' });
      const ai = await generateAIVideo(image, prompt);
      result = { tier: 'ai', videoUrl: ai.videoUrl, provider: ai.provider };
    } else {
      return json(400, { error: 'unknown_tier' });
    }

    // Charge
    const saved = await saveCredits(user, { credits: record.credits - cost });
    await logEvent({
      user_email: user, kind: 'video', model: result.provider, tier,
      credits_charged: cost, cost_usd: COST_USD[tier] || 0, revenue_usd: cost * 0.001,
    }).catch(() => {});

    return json(200, {
      ok: true,
      ...result,
      creditsCharged: cost,
      credits: saved.credits,
    });
  } catch (e) {
    return json(500, { error: 'generation_failed', message: String(e).slice(0, 300) });
  }
};
