// Ali's Fight Card - auto-refresh worker
//
// Runs on a Cron Trigger (set up in the Cloudflare dashboard). Each run:
//   1. Pulls fresh stats from the YouTube Data API for Ali's channel.
//   2. Recomputes the latest-20, all-time-top-20, and current longform video.
//   3. Uploads any thumbnails not already in the repo.
//   4. Writes the result to data.json in the GitHub repo (Cloudflare Pages
//      then redeploys the static site automatically).
//
// Required secrets (set in the Worker's Settings -> Variables, as "Encrypt"):
//   YOUTUBE_API_KEY  - a YouTube Data API v3 key
//   GITHUB_TOKEN     - a GitHub PAT with contents:write on the repo below
//   TRIGGER_SECRET   - any string you make up; required to trigger a run by
//                      visiting the worker's URL (not needed for the cron)
//
// Everything else below is not secret and can stay in the code.
const CHANNEL_ID = "UC24iC-l2nMOCRLvWNuArizw";
const GITHUB_OWNER = "KennethDunlop";
const GITHUB_REPO = "ali-fight-card";
const DATA_PATH = "data.json";

export default {
  async scheduled(event, env, ctx) {
    await refresh(env);
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.searchParams.get("run") === "1" && url.searchParams.get("secret") === env.TRIGGER_SECRET) {
      const result = await refresh(env);
      return new Response(JSON.stringify(result, null, 2), { headers: { "content-type": "application/json" } });
    }
    return new Response("Ali's Fight Card refresh worker is running. Add ?run=1&secret=... to trigger manually.");
  },
};

async function refresh(env) {
  const log = [];
  const yt = (path, params) => youtubeFetch(path, params, env.YOUTUBE_API_KEY);

  // 1. Channel meta.
  const channelResp = await yt("channels", { part: "snippet,statistics,contentDetails,brandingSettings", id: CHANNEL_ID });
  const channel = channelResp.items[0];
  const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;
  log.push("channel fetched: " + channel.snippet.title);

  // Not every channel has a banner set on YouTube -- upload one only if it
  // actually has one; otherwise meta.banner stays null and the site just
  // shows nothing for it.
  let bannerPath = null;
  const bannerExternalUrl = channel.brandingSettings && channel.brandingSettings.image && channel.brandingSettings.image.bannerExternalUrl;
  if (bannerExternalUrl) {
    const uploaded = await uploadBanner(env, bannerExternalUrl + "=w1280");
    if (uploaded) {
      bannerPath = "thumbs/banner.jpg";
      log.push("banner uploaded");
    }
  } else {
    log.push("no banner set on this channel");
  }

  // 2. Every uploaded video ID (paginate the uploads playlist).
  const videoIds = [];
  let pageToken;
  do {
    const page = await yt("playlistItems", {
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });
    page.items.forEach((it) => videoIds.push(it.contentDetails.videoId));
    pageToken = page.nextPageToken;
  } while (pageToken);
  log.push("found " + videoIds.length + " uploads");

  // 3. Batch-fetch stats for every video (50 IDs per call).
  const allVideos = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const resp = await yt("videos", { part: "snippet,statistics,contentDetails", id: batch.join(",") });
    resp.items.forEach((v) => {
      allVideos.push({
        id: v.id,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        thumbUrl:
          (v.snippet.thumbnails.maxres && v.snippet.thumbnails.maxres.url) ||
          (v.snippet.thumbnails.high && v.snippet.thumbnails.high.url) ||
          v.snippet.thumbnails.default.url,
        views: parseInt(v.statistics.viewCount || "0", 10),
        likes: parseInt(v.statistics.likeCount || "0", 10),
        comments: parseInt(v.statistics.commentCount || "0", 10),
        durationSeconds: parseIsoDuration(v.contentDetails.duration),
      });
    });
  }

  // 4. Derive the three views the site needs.
  const byNewest = allVideos.slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const latest20 = byNewest.slice(0, 20);
  const byViews = allVideos.slice().sort((a, b) => b.views - a.views);
  const top20 = byViews.slice(0, 20);
  const longform = byNewest.find((v) => v.durationSeconds > 180) || null;

  // 5. Read the current data.json (for its sha, subscriber history, thumb list, version).
  const current = await githubGetFile(env, DATA_PATH);
  const currentData = current ? JSON.parse(atob(current.contentBase64)) : {};
  const knownThumbIds = new Set(currentData.knownThumbIds || []);

  // 6. Upload any thumbnails we don't have yet.
  const needed = new Set(latest20.map((v) => v.id).concat(top20.map((v) => v.id)));
  if (longform) needed.add(longform.id);
  const byId = {};
  allVideos.forEach((v) => (byId[v.id] = v));
  const newlyUploaded = [];
  for (const id of needed) {
    if (knownThumbIds.has(id)) continue;
    const uploaded = await uploadThumbnail(env, id, byId[id] ? byId[id].thumbUrl : null);
    if (uploaded) {
      knownThumbIds.add(id);
      newlyUploaded.push(id);
    }
  }
  log.push("uploaded " + newlyUploaded.length + " new thumbnail(s): " + newlyUploaded.join(", "));

  // 7. Subscriber history: upsert today's snapshot.
  const today = new Date().toISOString().slice(0, 10);
  const history = (currentData.subscriberHistory || []).filter((h) => h.date !== today);
  history.push({ date: today, subscriberCount: parseInt(channel.statistics.subscriberCount || "0", 10) });
  history.sort((a, b) => new Date(a.date) - new Date(b.date));

  // 8. Version bump (+0.1, matching the site's existing convention).
  const prevVersion = parseFloat(currentData.version || "1.6");
  const nextVersion = (Math.round((prevVersion + 0.1) * 10) / 10).toFixed(1);

  const toSeedShape = (v) => ({
    id: v.id,
    title: v.title,
    publishedAt: v.publishedAt,
    thumbnail: "thumbs/" + v.id + ".jpg",
    views: v.views,
    likes: v.likes,
    comments: v.comments,
    durationSeconds: v.durationSeconds,
  });

  const newData = {
    version: nextVersion,
    meta: {
      channelTitle: channel.snippet.title,
      channelId: CHANNEL_ID,
      avatar: (currentData.meta && currentData.meta.avatar) || "thumbs/avatar.jpg",
      avatarLarge: (currentData.meta && currentData.meta.avatarLarge) || "thumbs/avatar-large.jpg",
      banner: bannerPath,
      channelUrl: channel.snippet.customUrl
        ? "https://www.youtube.com/" + channel.snippet.customUrl
        : (currentData.meta && currentData.meta.channelUrl) || "https://www.youtube.com/@Ali-MacKensie",
      subscriberCount: parseInt(channel.statistics.subscriberCount || "0", 10),
      videoCount: parseInt(channel.statistics.videoCount || "0", 10),
      channelViews: parseInt(channel.statistics.viewCount || "0", 10),
      channelCreatedAt: channel.snippet.publishedAt,
      lastUpdated: new Date().toISOString(),
    },
    subscriberGoal: currentData.subscriberGoal || 128,
    subscriberHistory: history,
    videos: latest20.map(toSeedShape),
    longform: longform ? toSeedShape(longform) : currentData.longform || null,
    popularVideos: top20.map(toSeedShape),
    knownThumbIds: Array.from(knownThumbIds),
  };

  await githubPutFile(
    env,
    DATA_PATH,
    JSON.stringify(newData, null, 2),
    current ? current.sha : null,
    "Auto-refresh Ali's data (v" + nextVersion + ")"
  );
  log.push("pushed data.json, version " + nextVersion);

  return { ok: true, log };
}

// ---- YouTube ----
async function youtubeFetch(path, params, apiKey) {
  const url = new URL("https://www.googleapis.com/youtube/v3/" + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  url.searchParams.set("key", apiKey);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error("YouTube API " + path + " failed: " + resp.status + " " + (await resp.text()));
  return resp.json();
}

function parseIsoDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const s = parseInt(m[3] || "0", 10);
  return h * 3600 + min * 60 + s;
}

// ---- GitHub Contents API ----
async function githubGetFile(env, path) {
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
    { headers: githubHeaders(env) }
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error("GitHub GET " + path + " failed: " + resp.status);
  const json = await resp.json();
  return { sha: json.sha, contentBase64: json.content.replace(/\n/g, "") };
}

async function githubPutFile(env, path, textContent, sha, message) {
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(textContent))),
  };
  if (sha) body.sha = sha;
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
    { method: "PUT", headers: githubHeaders(env), body: JSON.stringify(body) }
  );
  if (!resp.ok) throw new Error("GitHub PUT " + path + " failed: " + resp.status + " " + (await resp.text()));
  return resp.json();
}

async function uploadThumbnail(env, videoId, thumbUrl) {
  const candidates = [thumbUrl, `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`].filter(Boolean);
  for (const url of candidates) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const base64 = arrayBufferToBase64(bytes);
      await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/thumbs/${videoId}.jpg`,
        {
          method: "PUT",
          headers: githubHeaders(env),
          body: JSON.stringify({ message: "Add thumbnail for " + videoId, content: base64 }),
        }
      );
      return true;
    } catch (e) {
      // try next candidate
    }
  }
  return false;
}

async function uploadBanner(env, bannerUrl) {
  try {
    const resp = await fetch(bannerUrl);
    if (!resp.ok) return false;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const base64 = arrayBufferToBase64(bytes);
    const existing = await githubGetFile(env, "thumbs/banner.jpg");
    const body = { message: "Update channel banner", content: base64 };
    if (existing) body.sha = existing.sha;
    await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/thumbs/banner.jpg`,
      { method: "PUT", headers: githubHeaders(env), body: JSON.stringify(body) }
    );
    return true;
  } catch (e) {
    return false;
  }
}

function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function githubHeaders(env) {
  return {
    Authorization: "token " + env.GITHUB_TOKEN,
    "User-Agent": "ali-fight-card-worker",
    Accept: "application/vnd.github+json",
  };
}
