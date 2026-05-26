import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export async function attachBackgroundImages({ scenes, outputDir, slug, config = {} }) {
  const imageDir = path.join(outputDir, "remote_images");
  await mkdir(imageDir, { recursive: true });
  const cachePath = path.join(imageDir, "image-search-cache.json");
  const searchCache = await readSearchCache(cachePath);
  const usage = {
    jimengCalls: 0,
    tencentWimgsCalls: 0,
    estimatedCostCny: 0,
    jimengEstimatedCostCny: 0,
    tencentEstimatedCostCny: 0,
    jimengUnitCostCny: Number(config.video_generation?.jimeng_unit_cost_cny ?? 0.25),
    jimengQuotaTotal: Number(config.video_generation?.jimeng_quota_total ?? 200),
    jimengQuotaUsed: Number(config.video_generation?.jimeng_quota_used ?? 0),
    maxJimengCalls: Number(config.video_generation?.max_jimeng_calls_per_video ?? 1),
    maxTencentWimgsCalls: Number(config.video_generation?.max_tencent_wimgs_calls_per_video ?? 2),
  };
  const cache = new Map();
  const providerOrder = imageProviderOrder(config);
  const sceneStrategy = String(config.video_generation?.image_scene_strategy || "reuse_single_premium");
  const minImageScore = Number(config.video_generation?.image_min_score ?? 2800);
  let reusablePremiumImage = null;

  const attachedScenes = [];
  for (const [index, scene] of scenes.entries()) {
    const sceneProviderOrder = providerOrderForScene({
      providerOrder,
      scene,
      index,
      totalScenes: scenes.length,
      strategy: sceneStrategy,
    });
    if (scene.visualType === "chart" && !hasRemoteProvider(sceneProviderOrder)) {
      attachedScenes.push({
        ...scene,
        backgroundImagePath: "",
        backgroundImageSource: null,
      });
      continue;
    }
    const query = scene.visualQuery || { zh: "新闻 热点 资料图", en: "news analysis report" };
    if (reusablePremiumImage && sceneStrategy === "reuse_single_premium" && usage.maxJimengCalls <= 1) {
      attachedScenes.push({
        ...scene,
        backgroundImagePath: reusablePremiumImage.path || "",
        backgroundImageSource: {
          ...(reusablePremiumImage.source || {}),
          reusedAcrossScenes: true,
        },
        backgroundImageAttempts: [{ provider: "jimeng", ok: true, query: "reused cached image" }],
        imageSearchUsage: { ...usage },
      });
      continue;
    }
    const cacheKey = JSON.stringify(query);
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, findAndDownloadImage({
        query,
        imageDir,
        slug,
        index,
        providerOrder: sceneProviderOrder,
        searchCache,
        usage,
        config,
        minImageScore,
      }));
    }
    const result = await cache.get(cacheKey).catch((error) => ({ image: null, attempts: [{ provider: "unknown", ok: false, error: error.message }] }));
    let image = result?.image || null;
    if (image?.source?.provider === "jimeng") reusablePremiumImage = image;
    if (!image && reusablePremiumImage) {
      image = {
        ...reusablePremiumImage,
        source: {
          ...reusablePremiumImage.source,
          reusedAcrossScenes: true,
        },
      };
    }
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

async function findAndDownloadImage({ query, imageDir, slug, index, providerOrder, searchCache, usage, config, minImageScore = 2800 }) {
  const attempts = [];
  for (const provider of providerOrder) {
    try {
      const image = await findByProvider({ provider, query, imageDir, slug, index, searchCache, usage, config, minImageScore });
      attempts.push({
        provider,
        ok: Boolean(image),
        query: queryForProvider(query, provider),
        score: image?.source?.qualityScore,
      });
      if (image) return { image, attempts };
    } catch (error) {
      attempts.push({ provider, ok: false, query: queryForProvider(query, provider), error: error.message });
    }
  }
  return { image: null, attempts };
}

async function findByProvider({ provider, query, imageDir, slug, index, searchCache, usage, config, minImageScore = 2800 }) {
  const providerQuery = queryForProvider(query, provider);
  if (provider === "jimeng") return generateJimengImage({ query, prompt: providerQuery, imageDir, slug, index, searchCache, usage, config });
  if (provider === "tencent_wimgs") return findTencentWimgsImage({ query: providerQuery, imageDir, slug, index, searchCache, usage, config });
  if (provider === "pexels") return findPexelsImage({ query: providerQuery, imageDir, slug, index, minImageScore });
  if (provider === "pixabay") return findPixabayImage({ query: providerQuery, imageDir, slug, index, minImageScore });
  if (provider === "wikimedia") return findWikimediaImage({ query: providerQuery, imageDir, slug, index, minImageScore });
  return null;
}

function providerOrderForScene({ providerOrder, scene, index, totalScenes, strategy }) {
  if (strategy !== "per_scene_budget") return providerOrder;
  const premium = Boolean(scene.premiumVisual) || index === 0 || index === totalScenes - 1;
  if (premium) return providerOrder;
  return providerOrder.filter((provider) => provider !== "jimeng");
}

function queryForProvider(query, provider) {
  if (typeof query === "string") return query;
  if (provider === "jimeng") return buildJimengPrompt(query);
  if (provider === "tencent_wimgs") return query.zh || query.en || "新闻 热点 资料图";
  return query.en || query.zh || "news analysis report";
}

async function generateJimengImage({ query, prompt, imageDir, slug, index, searchCache, usage, config }) {
  const videoConfig = config.video_generation || {};
  const apiKey = process.env[videoConfig.jimeng_api_key_env || "ARK_API_KEY"] || process.env.ARK_API_KEY || process.env.JIMENG_API_KEY;
  const model = process.env[videoConfig.jimeng_model_env || "ARK_IMAGE_MODEL"] || videoConfig.jimeng_model || process.env.ARK_IMAGE_MODEL;
  if (!apiKey || !model) return null;
  if (usage.jimengCalls >= usage.maxJimengCalls) {
    throw new Error(`Jimeng skipped: per-video call limit ${usage.maxJimengCalls} reached.`);
  }
  const remaining = Math.max(0, usage.jimengQuotaTotal - usage.jimengQuotaUsed - usage.jimengCalls);
  if (remaining <= 0) {
    throw new Error(`Jimeng skipped: configured quota exhausted (${usage.jimengQuotaUsed}/${usage.jimengQuotaTotal}).`);
  }

  const cacheKey = `jimeng:${model}:${prompt}`;
  let cached = searchCache[cacheKey] || null;
  if (cached?.path) {
    return {
      path: cached.path,
      source: {
        ...cached.source,
        fromCache: true,
      },
    };
  }

  const endpoint = String(videoConfig.jimeng_endpoint || process.env.ARK_IMAGE_ENDPOINT || "https://ark.cn-beijing.volces.com/api/v3/images/generations");
  const size = String(videoConfig.jimeng_size || "1080x1920");
  const responseFormat = String(videoConfig.jimeng_response_format || "url");
  const payload = {
    model,
    prompt,
    size,
    response_format: responseFormat,
    watermark: Boolean(videoConfig.jimeng_watermark ?? false),
  };
  const data = await fetchJimengImage(endpoint, apiKey, payload);
  const item = data.data?.[0] || data.Data?.[0] || data.Result?.[0] || {};
  const imageUrl = item.url || item.image_url || item.ImageUrl || "";
  const base64 = item.b64_json || item.base64 || item.B64Json || "";
  if (!imageUrl && !base64) throw new Error("Jimeng image generation returned no image URL or base64 payload.");

  const target = path.join(imageDir, `${slug}-bg-${String(index + 1).padStart(2, "0")}-jimeng.jpg`);
  if (base64) {
    await writeFile(target, Buffer.from(base64, "base64"));
  } else {
    await writeFile(target, await fetchBytes(imageUrl));
  }
  usage.jimengCalls += 1;
  usage.jimengEstimatedCostCny = roundMoney(usage.jimengCalls * usage.jimengUnitCostCny);
  usage.estimatedCostCny = roundMoney((usage.estimatedCostCny || 0) + usage.jimengUnitCostCny);

  const width = Number(size.split("x")[0]) || 1080;
  const height = Number(size.split("x")[1]) || 1920;
  const source = {
    provider: "jimeng",
    model,
    query: typeof query === "string" ? query : (query.zh || query.en || ""),
    prompt,
    imageUrl,
    url: imageUrl,
    license: "generated_ai_review_required",
    artist: "Volcengine Ark / Jimeng",
    width,
    height,
    qualityScore: scoreGeneratedImage({ width, height }),
    unit_cost_cny: usage.jimengUnitCostCny,
    estimated_cost_cny: usage.jimengUnitCostCny,
    quota_used_after_call: usage.jimengQuotaUsed + usage.jimengCalls,
    quota_total: usage.jimengQuotaTotal,
  };
  searchCache[cacheKey] = {
    path: target,
    source,
    fetchedAt: new Date().toISOString(),
  };
  return { path: target, source };
}

async function findTencentWimgsImage({ query, imageDir, slug, index, searchCache, usage, config }) {
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
    usage.tencentEstimatedCostCny = roundMoney(usage.tencentWimgsCalls * 0.06);
    usage.estimatedCostCny = roundMoney((usage.estimatedCostCny || 0) + 0.06);
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
  const image = pickBestTencentImage(images, {
    minScore: Number(config.video_generation?.tencent_wimgs_min_score ?? 4200),
  });
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
      qualityScore: scoreTencentImage(image),
    },
  };
}

async function findPexelsImage({ query, imageDir, slug, index, minImageScore = 2800 }) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  const api = new URL("https://api.pexels.com/v1/search");
  api.searchParams.set("query", query);
  api.searchParams.set("orientation", "portrait");
  api.searchParams.set("per_page", "8");
  const data = await fetchJson(api, { Authorization: key });
  const ranked = (data.photos || [])
    .map((photo) => ({
      photo,
      score: scoreStockPhoto({
        width: photo.width,
        height: photo.height,
        title: photo.alt || "",
        provider: "pexels",
      }),
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked.find((item) => item.score >= minImageScore) || ranked[0];
  const photo = best?.photo;
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
      width: photo.width,
      height: photo.height,
      qualityScore: best.score,
    },
  };
}

async function findPixabayImage({ query, imageDir, slug, index, minImageScore = 2800 }) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return null;
  const api = new URL("https://pixabay.com/api/");
  api.searchParams.set("key", key);
  api.searchParams.set("q", query);
  api.searchParams.set("image_type", "photo");
  api.searchParams.set("orientation", "vertical");
  api.searchParams.set("per_page", "8");
  const data = await fetchJson(api);
  const ranked = (data.hits || [])
    .map((photo) => ({
      photo,
      score: scoreStockPhoto({
        width: photo.imageWidth,
        height: photo.imageHeight,
        title: photo.tags || "",
        provider: "pixabay",
      }),
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked.find((item) => item.score >= minImageScore) || ranked[0];
  const photo = best?.photo;
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
      width: photo.imageWidth,
      height: photo.imageHeight,
      qualityScore: best.score,
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
  if (config.video_generation?.visual_provider === "jimeng") return ["jimeng", "pexels", "pixabay", "wikimedia", "tencent_wimgs"];
  return ["pexels", "pixabay", "wikimedia", "tencent_wimgs"];
}

function hasRemoteProvider(providerOrder) {
  return providerOrder.some((provider) => ["jimeng", "tencent_wimgs", "pexels", "pixabay", "wikimedia"].includes(provider));
}

function buildJimengPrompt(query) {
  const zh = typeof query === "string" ? query : query.zh || "热点分析";
  const en = typeof query === "string" ? "" : query.en || "";
  return [
    `主题：${zh}`,
    en ? `参考英文关键词：${en}` : "",
    "生成一张适合中文热点分析短视频的竖屏背景图。",
    "画面要高级、干净、有真实摄影或高质量商业海报质感，主体明确，留出上方标题区和下方字幕区。",
    "不要出现可读文字、新闻截图、股票代码、真实品牌 logo、水印、二维码、人物肖像特写、夸张表情包。",
    "风格：专业媒体视觉，浅景深，构图稳定，适合 9:16 视频背景。",
  ].filter(Boolean).join("\n");
}

function pickBestTencentImage(images, { minScore = 4200 } = {}) {
  const valid = images.filter((image) => image && (image.origPicUrl || image.thumbnailUrl));
  valid.sort((a, b) => scoreTencentImage(b) - scoreTencentImage(a));
  const best = valid[0] || null;
  if (!best || scoreTencentImage(best) < minScore) return null;
  return best;
}

function scoreStockPhoto({ width = 0, height = 0, title = "", provider = "" }) {
  const verticalBonus = height >= width ? 900 : 0;
  const sizeScore = Math.min(Number(width) * Number(height), 2_000_000) / 1000;
  const noisyTitlePenalty = /头像|表情|logo|壁纸|卡通|漫画|大涨|暴涨|涨停|炒股|韭菜|牛股/.test(title) ? -2500 : 0;
  const tinyPenalty = width < 900 || height < 600 ? -1400 : 0;
  const providerBonus = provider === "pexels" ? 500 : 300;
  return verticalBonus + sizeScore + providerBonus + noisyTitlePenalty + tinyPenalty;
}

function scoreGeneratedImage({ width = 1080, height = 1920 }) {
  return scoreStockPhoto({ width, height, title: "", provider: "jimeng" }) + 1200;
}

function scoreTencentImage(image) {
  const width = Number(image.origPicWidth || image.thumbnailWidth || 0);
  const height = Number(image.origPicHeight || image.thumbnailHeight || 0);
  const verticalBonus = height >= width ? 900 : 0;
  const sizeScore = Math.min(width * height, 2_000_000) / 1000;
  const sourceScore = sourceQualityScore(image.siteName || image.siteUrl || "");
  const noisyTitlePenalty = /头像|表情|logo|壁纸|卡通|漫画|大涨|暴涨|涨停|炒股秘籍|手把手|离奇|账户被盗|庄股|怎么买|韭菜|一夜暴富|牛股|妖股/.test(`${image.title || ""}${image.siteName || ""}`) ? -3000 : 0;
  const tinyPenalty = width < 900 || height < 600 ? -1400 : 0;
  const veryWidePenalty = width > height * 2 ? -1200 : 0;
  return verticalBonus + sizeScore + sourceScore + noisyTitlePenalty + tinyPenalty + veryWidePenalty;
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

async function fetchJimengImage(endpoint, apiKey, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "xhs-hotspot-poster/0.1 video renderer",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Jimeng returned non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!response.ok || data.error || data.Error) {
    const error = data.error || data.Error || {};
    throw new Error(`Jimeng image request failed: HTTP ${response.status} ${error.code || error.Code || ""} ${error.message || error.Message || text.slice(0, 200)}`.trim());
  }
  return data;
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

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
