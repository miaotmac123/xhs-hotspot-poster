import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export async function attachBackgroundImages({ scenes, outputDir, slug, config = {} }) {
  const imageDir = path.join(outputDir, "remote_images");
  await mkdir(imageDir, { recursive: true });
  const cachePath = path.join(imageDir, "image-search-cache.json");
  const searchCache = await readSearchCache(cachePath);
  const usage = {
    tencentWimgsCalls: 0,
    estimatedCostCny: 0,
    maxTencentWimgsCalls: Number(config.video_generation?.max_tencent_wimgs_calls_per_video ?? 2),
  };
  const cache = new Map();
  const providerOrder = imageProviderOrder(config);

  const attachedScenes = [];
  for (const [index, scene] of scenes.entries()) {
    if (scene.visualType === "chart" && !hasRemoteProvider(providerOrder)) {
      attachedScenes.push({
        ...scene,
        backgroundImagePath: "",
        backgroundImageSource: null,
      });
      continue;
    }
    const query = scene.visualQuery || { zh: "新闻 热点 资料图", en: "news analysis report" };
    const cacheKey = JSON.stringify(query);
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, findAndDownloadImage({ query, imageDir, slug, index, providerOrder, searchCache, usage }));
    }
    const result = await cache.get(cacheKey).catch((error) => ({ image: null, attempts: [{ provider: "unknown", ok: false, error: error.message }] }));
    const image = result?.image || null;
    attachedScenes.push({
      ...scene,
      backgroundImagePath: image?.path || "",
      backgroundImageSource: image?.source || null,
      backgroundImageAttempts: result?.attempts || [],
      imageSearchUsage: { ...usage },
    });
  }
  await writeSearchCache(cachePath, searchCache);
  return attachedScenes;
}

async function findAndDownloadImage({ query, imageDir, slug, index, providerOrder, searchCache, usage }) {
  const attempts = [];
  for (const provider of providerOrder) {
    try {
      const image = await findByProvider({ provider, query, imageDir, slug, index, searchCache, usage });
      attempts.push({ provider, ok: Boolean(image), query: queryForProvider(query, provider) });
      if (image) return { image, attempts };
    } catch (error) {
      attempts.push({ provider, ok: false, query: queryForProvider(query, provider), error: error.message });
    }
  }
  return { image: null, attempts };
}

async function findByProvider({ provider, query, imageDir, slug, index, searchCache, usage }) {
  const providerQuery = queryForProvider(query, provider);
  if (provider === "tencent_wimgs") return findTencentWimgsImage({ query: providerQuery, imageDir, slug, index, searchCache, usage });
  if (provider === "pexels") return findPexelsImage({ query: providerQuery, imageDir, slug, index });
  if (provider === "pixabay") return findPixabayImage({ query: providerQuery, imageDir, slug, index });
  if (provider === "wikimedia") return findWikimediaImage({ query: providerQuery, imageDir, slug, index });
  return null;
}

function queryForProvider(query, provider) {
  if (typeof query === "string") return query;
  if (provider === "tencent_wimgs") return query.zh || query.en || "新闻 热点 资料图";
  return query.en || query.zh || "news analysis report";
}

async function findTencentWimgsImage({ query, imageDir, slug, index, searchCache, usage }) {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) return null;
  if (usage.tencentWimgsCalls >= usage.maxTencentWimgsCalls) {
    throw new Error(`Tencent WIMGS skipped: per-video call limit ${usage.maxTencentWimgsCalls} reached.`);
  }

  const cacheKey = `tencent_wimgs:${query}`;
  let rawImages = searchCache[cacheKey]?.images || null;
  let requestId = searchCache[cacheKey]?.requestId || "";
  let fromCache = Boolean(rawImages && rawImages.length);
  if (rawImages && !rawImages.length) {
    rawImages = null;
  }
  if (!rawImages) {
    const response = await tencentCloudRequest({
      secretId,
      secretKey,
      service: "wimgs",
      host: "wimgs.tencentcloudapi.com",
      action: "SearchByText",
      version: "2025-11-06",
      payload: { Query: query },
    });
    rawImages = response.Response?.Images || [];
    requestId = response.Response?.RequestId || "";
    if (rawImages.length) {
      searchCache[cacheKey] = {
        images: rawImages,
        requestId,
        fetchedAt: new Date().toISOString(),
      };
    }
    usage.tencentWimgsCalls += 1;
    usage.estimatedCostCny = Math.round(usage.tencentWimgsCalls * 0.06 * 100) / 100;
  }
  const images = rawImages
    .map((item) => {
      try {
        return typeof item === "string" ? JSON.parse(item) : item;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const image = pickBestTencentImage(images);
  if (!image) return null;

  const imageUrl = image.origPicUrl || image.thumbnailUrl;
  const target = path.join(imageDir, `${slug}-bg-${String(index + 1).padStart(2, "0")}-tencent.jpg`);
  await writeFile(target, await fetchBytes(imageUrl));
  return {
    path: target,
    source: {
      provider: "tencent_wimgs",
      query,
      requestId,
      fromCache,
      title: image.title || "",
      url: image.siteUrl || imageUrl,
      imageUrl,
      thumbnailUrl: image.thumbnailUrl || "",
      siteName: image.siteName || "",
      width: image.origPicWidth || image.thumbnailWidth || 0,
      height: image.origPicHeight || image.thumbnailHeight || 0,
      date: image.date || "",
      license: "source_site_required",
      artist: image.siteName || "",
    },
  };
}

async function findPexelsImage({ query, imageDir, slug, index }) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  const api = new URL("https://api.pexels.com/v1/search");
  api.searchParams.set("query", query);
  api.searchParams.set("orientation", "portrait");
  api.searchParams.set("per_page", "5");
  const data = await fetchJson(api, { Authorization: key });
  const photo = (data.photos || [])[0];
  if (!photo?.src?.large2x && !photo?.src?.large) return null;
  const imageUrl = photo.src.large2x || photo.src.large;
  const target = path.join(imageDir, `${slug}-bg-${String(index + 1).padStart(2, "0")}-pexels.jpg`);
  await writeFile(target, await fetchBytes(imageUrl));
  return {
    path: target,
    source: {
      provider: "pexels",
      query,
      title: photo.alt || "",
      url: photo.url,
      imageUrl,
      license: "Pexels License",
      artist: photo.photographer || "",
    },
  };
}

async function findPixabayImage({ query, imageDir, slug, index }) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return null;
  const api = new URL("https://pixabay.com/api/");
  api.searchParams.set("key", key);
  api.searchParams.set("q", query);
  api.searchParams.set("image_type", "photo");
  api.searchParams.set("orientation", "vertical");
  api.searchParams.set("per_page", "5");
  const data = await fetchJson(api);
  const photo = (data.hits || [])[0];
  if (!photo?.largeImageURL && !photo?.webformatURL) return null;
  const imageUrl = photo.largeImageURL || photo.webformatURL;
  const target = path.join(imageDir, `${slug}-bg-${String(index + 1).padStart(2, "0")}-pixabay.jpg`);
  await writeFile(target, await fetchBytes(imageUrl));
  return {
    path: target,
    source: {
      provider: "pixabay",
      query,
      title: photo.tags || "",
      url: photo.pageURL,
      imageUrl,
      license: "Pixabay Content License",
      artist: photo.user || "",
    },
  };
}

async function findWikimediaImage({ query, imageDir, slug, index }) {
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("format", "json");
  api.searchParams.set("origin", "*");
  api.searchParams.set("generator", "search");
  api.searchParams.set("gsrnamespace", "6");
  api.searchParams.set("gsrlimit", "8");
  api.searchParams.set("gsrsearch", query);
  api.searchParams.set("prop", "imageinfo");
  api.searchParams.set("iiprop", "url|mime|extmetadata");
  api.searchParams.set("iiurlwidth", "1600");

  const data = await fetchJson(api);
  const pages = Object.values(data.query?.pages || {});
  const candidate = pages
    .flatMap((page) => (page.imageinfo || []).map((info) => ({ page, info })))
    .find(({ info }) => String(info.mime || "").startsWith("image/") && (info.thumburl || info.url));
  if (!candidate) return null;

  const imageUrl = candidate.info.thumburl || candidate.info.url;
  const ext = extensionFromMime(candidate.info.mime);
  const target = path.join(imageDir, `${slug}-bg-${String(index + 1).padStart(2, "0")}${ext}`);
  const bytes = await fetchBytes(imageUrl);
  await writeFile(target, bytes);

  return {
    path: target,
    source: {
      provider: "wikimedia_commons",
      query,
      title: candidate.page.title,
      url: candidate.info.descriptionurl || candidate.info.url,
      imageUrl,
      license: candidate.info.extmetadata?.LicenseShortName?.value || "",
      artist: stripHtml(candidate.info.extmetadata?.Artist?.value || ""),
    },
  };
}

function imageProviderOrder(config) {
  const configured = config.video_generation?.image_providers;
  if (Array.isArray(configured)) return configured;
  return ["tencent_wimgs", "pexels", "pixabay", "wikimedia"];
}

function hasRemoteProvider(providerOrder) {
  return providerOrder.some((provider) => ["tencent_wimgs", "pexels", "pixabay", "wikimedia"].includes(provider));
}

function pickBestTencentImage(images) {
  const valid = images.filter((image) => image && (image.origPicUrl || image.thumbnailUrl));
  valid.sort((a, b) => scoreTencentImage(b) - scoreTencentImage(a));
  const best = valid[0] || null;
  if (!best || scoreTencentImage(best) < 1200) return null;
  return best;
}

function scoreTencentImage(image) {
  const width = Number(image.origPicWidth || image.thumbnailWidth || 0);
  const height = Number(image.origPicHeight || image.thumbnailHeight || 0);
  const verticalBonus = height >= width ? 900 : 0;
  const sizeScore = Math.min(width * height, 2_000_000) / 1000;
  const sourceScore = sourceQualityScore(image.siteName || image.siteUrl || "");
  const titlePenalty = /头像|表情|logo|壁纸|卡通|漫画|大涨|暴涨|涨停|炒股秘籍|手把手|离奇|账户被盗|庄股/.test(`${image.title || ""}${image.siteName || ""}`) ? -2500 : 0;
  return verticalBonus + sizeScore + sourceScore + titlePenalty;
}

function sourceQualityScore(source) {
  if (/pixabay|pexels|unsplash/i.test(source)) return 4000;
  if (/新浪财经|财新|证券时报|第一财经|央视|新华社|人民网|澎湃|东方财富/.test(source)) return 1800;
  if (/搜狐|百度知道|淘股吧|南方财富网|金投网|股吧|博客|网易/.test(source)) return -1800;
  return 0;
}

async function readSearchCache(cachePath) {
  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeSearchCache(cachePath, cache) {
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function tencentCloudRequest({ secretId, secretKey, service, host, action, version, payload }) {
  const algorithm = "TC3-HMAC-SHA256";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedRequestPayload = sha256(body);
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload,
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");
  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${host}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": version,
    },
    body,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Tencent WIMGS returned non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!response.ok || data.Response?.Error) {
    const error = data.Response?.Error;
    throw new Error(`Tencent WIMGS failed: ${error?.Code || response.status} ${error?.Message || text.slice(0, 200)}`);
  }
  return data;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest(encoding);
}

async function fetchJson(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": "xhs-hotspot-poster/0.1 video renderer", ...extraHeaders },
  });
  if (!response.ok) throw new Error(`Image search failed: HTTP ${response.status}`);
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "xhs-hotspot-poster/0.1 video renderer" },
  });
  if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function extensionFromMime(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

function stripHtml(value) {
  return String(value).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
