const DEFAULT_DURATION_SECONDS = 45;

export function buildVideoPlan(post, config = {}) {
  const videoConfig = config.video_generation || {};
  const targetDuration = toPositiveInt(videoConfig.duration_seconds, DEFAULT_DURATION_SECONDS);
  const title = firstText(post.title_options) || post.selected_topic || "今日热点";
  const topic = cleanText(post.selected_topic || title);
  const angle = cleanText(post.angle || "");
  const risks = Array.isArray(post.risk_notes) ? post.risk_notes.map(cleanText).filter(Boolean) : [];
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags.slice(0, 4) : [];
  const domain = inferDomain(`${topic} ${angle} ${hashtags.join(" ")}`);
  const facts = extractFactSignals(post.body || "", domain);
  const visualKeywords = extractVisualKeywords({ topic, angle, body: post.body || "", hashtags, domain });
  const visualQuery = visualQueryForDomain(domain, visualKeywords);

  const sceneInputs = buildAnalysisScenes({ title, topic, angle, domain, facts, risks, hashtags, visualQuery, visualKeywords });

  const scenes = sceneInputs.slice(0, 9);
  const sceneDuration = Math.max(4, Math.round(targetDuration / scenes.length));
  const timedScenes = scenes.map((scene, index) => ({
    id: `scene-${String(index + 1).padStart(2, "0")}`,
    title: scene.title,
    subtitle: scene.subtitle,
    narration: normalizeNarration(scene.narration || scene.subtitle),
    keywords: scene.keywords,
    visualQuery: scene.visualQuery || visualQuery,
    visualType: scene.visualType || "photo",
    durationSeconds: sceneDuration,
  }));
  const totalDuration = timedScenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  const voiceover = timedScenes.map((scene) => scene.narration).join("\n");
  let cursor = 0;
  const subtitleSegments = [];
  for (const scene of timedScenes) {
    const chunks = splitSubtitleChunks(scene.narration);
    const chunkDuration = scene.durationSeconds / chunks.length;
    for (const text of chunks) {
      subtitleSegments.push({
        index: subtitleSegments.length,
        startSeconds: roundTime(cursor),
        endSeconds: roundTime(cursor + chunkDuration),
        text,
      });
      cursor += chunkDuration;
    }
    const sceneEnd = subtitleSegments.length ? subtitleSegments[subtitleSegments.length - 1].endSeconds : cursor + scene.durationSeconds;
    cursor = Math.max(cursor, sceneEnd);
  }
  if (subtitleSegments.length) {
    subtitleSegments[subtitleSegments.length - 1].endSeconds = totalDuration;
  }

  return {
    provider: "rule_based_node_analysis_v2",
    contentType: "hotspot_analysis_video",
    durationSeconds: totalDuration,
    voiceover,
    scenes: timedScenes,
    subtitleSegments,
  };
}

export function applyVoiceoverToPlan(plan, voiceover) {
  const nextPlan = {
    ...plan,
    voiceover: normalizeNarration(voiceover),
    scenes: [...(plan.scenes || [])],
  };
  const sentences = splitSentences(nextPlan.voiceover);
  const sceneCount = Math.max(1, nextPlan.scenes.length);
  const perScene = Math.max(1, Math.ceil(sentences.length / sceneCount));
  nextPlan.scenes = nextPlan.scenes.map((scene, index) => {
    const chunk = sentences.slice(index * perScene, (index + 1) * perScene);
    return {
      ...scene,
      narration: normalizeNarration(chunk.join("。") || scene.narration || scene.subtitle || ""),
    };
  });
  retimeSubtitles(nextPlan);
  nextPlan.edited_at = new Date().toISOString().slice(0, 19);
  return nextPlan;
}

export function videoScriptText(plan) {
  const lines = ["# 视频口播稿", "", plan.voiceover || ""];
  lines.push("", "# 分镜");
  for (const scene of plan.scenes || []) {
    lines.push(`- ${scene.title}｜${scene.subtitle}`);
  }
  return lines.join("\n");
}

export function retimePlanToAudioDuration(plan, audioDurationSeconds) {
  const duration = Math.max(1, Number(audioDurationSeconds) || Number(plan.durationSeconds) || DEFAULT_DURATION_SECONDS);
  const scenes = plan.scenes || [];
  const sceneChunks = scenes.map((scene) => {
    const chunks = splitSubtitleChunks(scene.narration || scene.subtitle || "");
    return {
      scene,
      chunks: chunks.length ? chunks : [scene.subtitle || scene.title || "今日热点"],
    };
  });
  const weights = sceneChunks.flatMap(({ chunks }) => chunks.map(subtitleWeight));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let weightIndex = 0;
  let cursor = 0;
  const subtitleSegments = [];
  const nextScenes = sceneChunks.map(({ scene, chunks }) => {
    const sceneStart = cursor;
    for (const text of chunks) {
      const isLast = weightIndex === weights.length - 1;
      const chunkDuration = isLast ? duration - cursor : Math.max(0.8, (duration * weights[weightIndex]) / totalWeight);
      const endSeconds = isLast ? duration : Math.min(duration, cursor + chunkDuration);
      subtitleSegments.push({
        index: subtitleSegments.length,
        startSeconds: roundTime(cursor),
        endSeconds: roundTime(endSeconds),
        text,
      });
      cursor = endSeconds;
      weightIndex += 1;
    }
    const sceneEnd = cursor;
    return {
      ...scene,
      durationSeconds: roundTime(Math.max(0.8, sceneEnd - sceneStart)),
    };
  });

  if (subtitleSegments.length) {
    subtitleSegments[0].startSeconds = 0;
    subtitleSegments[subtitleSegments.length - 1].endSeconds = roundTime(duration);
  }

  return {
    ...plan,
    durationSeconds: roundTime(duration),
    scenes: nextScenes,
    subtitleSegments,
    timing_source: "tts_audio_duration",
  };
}

export function voiceoverSegmentsForPlan(plan) {
  return (plan.scenes || []).flatMap((scene) => {
    const chunks = splitSubtitleChunks(scene.narration || scene.subtitle || "");
    return (chunks.length ? chunks : [scene.subtitle || scene.title || "今日热点"]).map((text) => ({
      sceneId: scene.id,
      text,
    }));
  });
}

export function retimePlanToSegmentDurations(plan, segmentDurations) {
  let cursor = 0;
  let segmentIndex = 0;
  const subtitleSegments = [];
  const nextScenes = (plan.scenes || []).map((scene) => {
    const sceneStart = cursor;
    const chunks = splitSubtitleChunks(scene.narration || scene.subtitle || "");
    const texts = chunks.length ? chunks : [scene.subtitle || scene.title || "今日热点"];
    for (const text of texts) {
      const duration = Math.max(0.45, Number(segmentDurations[segmentIndex]) || 1);
      subtitleSegments.push({
        index: subtitleSegments.length,
        startSeconds: roundTime(cursor),
        endSeconds: roundTime(cursor + duration),
        text,
      });
      cursor += duration;
      segmentIndex += 1;
    }
    return {
      ...scene,
      durationSeconds: roundTime(Math.max(0.45, cursor - sceneStart)),
    };
  });
  if (subtitleSegments.length) {
    subtitleSegments[0].startSeconds = 0;
    subtitleSegments[subtitleSegments.length - 1].endSeconds = roundTime(cursor);
  }
  return {
    ...plan,
    durationSeconds: roundTime(cursor),
    scenes: nextScenes,
    subtitleSegments,
    timing_source: "tts_segment_audio_duration",
  };
}

function retimeSubtitles(plan) {
  let cursor = 0;
  const subtitleSegments = [];
  for (const scene of plan.scenes || []) {
    const chunks = splitSubtitleChunks(scene.narration || scene.subtitle || "");
    const duration = Number(scene.durationSeconds || 4);
    const chunkDuration = duration / Math.max(1, chunks.length);
    for (const text of chunks) {
      subtitleSegments.push({
        index: subtitleSegments.length,
        startSeconds: roundTime(cursor),
        endSeconds: roundTime(cursor + chunkDuration),
        text,
      });
      cursor += chunkDuration;
    }
  }
  plan.durationSeconds = (plan.scenes || []).reduce((sum, scene) => sum + Number(scene.durationSeconds || 0), 0);
  if (subtitleSegments.length) subtitleSegments[subtitleSegments.length - 1].endSeconds = plan.durationSeconds;
  plan.subtitleSegments = subtitleSegments;
}

function subtitleWeight(text) {
  const value = String(text || "");
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z0-9]/g) || []).length;
  const punctuationPauses = (value.match(/[，,]/g) || []).length * 0.8
    + (value.match(/[。！？!?；;]/g) || []).length * 1.35;
  return Math.max(2, cjk + latin * 0.55 + punctuationPauses);
}

function buildAnalysisScenes({ title, topic, angle, domain, facts, risks, hashtags, visualQuery, visualKeywords }) {
  const domainLabel = domainLabels[domain] || "热点";
  const impact = impactLines[domain] || impactLines.general;
  const metric = metricLines[domain] || metricLines.general;
  const fact = facts[0] || angle || topic;
  const risk = risks[0] || "目前公开信息可能还不完整，发布前要核实来源和时间。";

  return [
    {
      title: "热点速览",
      subtitle: cleanText(title),
      narration: `今天看一个${domainLabel}热点。${cleanText(title)}。先抓三个关键信号。`,
      keywords: normalizeKeywords([hashtags[0], domainLabel, "速览"]),
      visualQuery: sceneQuery(visualQuery, visualKeywords, ["热点", "新闻", domainLabel], ["news", "headline", domainEnglishLabels[domain]]),
      visualType: visualTypeForDomain(domain),
    },
    {
      title: "发生了什么",
      subtitle: shortLine(fact, 34),
      narration: `先看发生了什么。${fullStop(fact)}重点不是情绪。重点是它会影响哪些决策。`,
      keywords: normalizeKeywords(["事实", "时间线", domainLabel]),
      visualQuery: sceneQuery(visualQuery, visualKeywords, ["事件", "现场", "资料图"], ["event", "news", "report"]),
      visualType: visualTypeForDomain(domain),
    },
    {
      title: "为什么重要",
      subtitle: impact[0],
      narration: `为什么重要？${impact[0]}。预期一变，后面的选择也会变。`,
      keywords: normalizeKeywords(["影响", "预期", domainLabel]),
      visualQuery: sceneQuery(visualQuery, visualKeywords, ["影响", "趋势", domainLabel], ["impact", "trend", domainEnglishLabels[domain]]),
      visualType: visualTypeForDomain(domain),
    },
    {
      title: "第二层影响",
      subtitle: impact[1],
      narration: `${impact[1]}。别只看热度，要看数据能不能跟上。`,
      keywords: normalizeKeywords(["数据", "变化", "趋势"]),
      visualQuery: sceneQuery(visualQuery, visualKeywords, ["数据", "变化", "趋势"], ["data", "trend", "chart"]),
      visualType: visualTypeForDomain(domain),
    },
    {
      title: "接下来盯什么",
      subtitle: metric,
      narration: `接下来盯三个指标。${metric}。指标不变，热度很快会退。`,
      keywords: normalizeKeywords(["指标", "观察", "验证"]),
      visualQuery: sceneQuery(visualQuery, visualKeywords, ["指标", "观察", "数据"], ["metrics", "analysis", "chart"]),
      visualType: domain === "stock" ? "chart" : visualTypeForDomain(domain),
    },
    {
      title: "风险提示",
      subtitle: shortLine(risk, 34),
      narration: `最后提醒一句。${fullStop(risk)}核实来源，比抢速度更重要。`,
      keywords: normalizeKeywords(["风险", "核实", "来源"]),
      visualQuery: sceneQuery(visualQuery, visualKeywords, ["风险", "核实", "信息来源"], ["risk", "verification", "news"]),
      visualType: visualTypeForDomain(domain),
    },
  ];
}

function splitSentences(text) {
  return String(text)
    .replace(/\r/g, "")
    .split(/[\n。！？!?；;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/^#+\s*/.test(item))
    .map((item) => item.replace(/^[-*\d.、\s]+/, "").trim())
    .filter(Boolean);
}

function cleanText(text) {
  return String(text || "")
    .replace(/[\u{1F000}-\u{1FAFF}\uFE0F\u20E3]/gu, "")
    .replace(/[「」【】]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNarration(text) {
  return splitSentences(text)
    .flatMap((sentence) => splitLongSentence(sentence, 24))
    .join("。");
}

function splitSubtitleChunks(text) {
  const chunks = splitSentences(text).flatMap((sentence) => splitLongSentence(sentence, 18));
  return chunks.length ? chunks : [cleanText(text)];
}

function splitLongSentence(sentence, maxLength) {
  const clean = cleanText(sentence);
  if (clean.length <= maxLength) return [clean];
  const parts = clean.split(/[，,、：:]/).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const part of parts.length ? parts : [clean]) {
    if (!current) {
      current = part;
    } else if ((current + part).length <= maxLength) {
      current = `${current}，${part}`;
    } else {
      chunks.push(current);
      current = part;
    }
  }
  if (current) chunks.push(current);
  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxLength + 6) return [chunk];
    const result = [];
    for (let index = 0; index < chunk.length; index += maxLength) {
      result.push(chunk.slice(index, index + maxLength));
    }
    return result;
  });
}

function roundTime(value) {
  return Math.round(value * 100) / 100;
}

function fullStop(text) {
  const clean = cleanText(text);
  return /[。！？!?]$/.test(clean) ? clean : `${clean}。`;
}

function firstText(value) {
  if (Array.isArray(value) && value.length) return String(value[0]);
  if (typeof value === "string") return value;
  return "";
}

function normalizeKeywords(keywords) {
  const seen = new Set();
  const normalized = [];
  for (const raw of keywords) {
    const item = String(raw || "").replace(/^#/, "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    normalized.push(item.length > 8 ? item.slice(0, 8) : item);
    if (normalized.length >= 3) break;
  }
  return normalized.length ? normalized : ["热点", "观察", "清单"];
}

function inferDomain(text) {
  if (/股市|A股|股票|投资|半导体|机器人|仓位/.test(text)) return "stock";
  if (/房产|楼市|住宅|网签|刚需|学区|通勤/.test(text)) return "realestate";
  if (/AI|手机|苹果|芯片|科技|终端|大模型/.test(text)) return "tech";
  if (/经济|消费|就业|利率|钱包|零售/.test(text)) return "economy";
  if (/政治|国际|中美|外交|关系/.test(text)) return "politics";
  return "general";
}

function extractFactSignals(body, domain) {
  const sentences = splitSentences(cleanText(body));
  const useful = sentences.filter((sentence) => {
    if (sentence.length < 8) return false;
    if (/姐妹|评论区|收藏|关注|后面我/.test(sentence)) return false;
    if (domain === "stock") return /A股|板块|领涨|探底|回升|投资|仓位|数据/.test(sentence);
    if (domain === "realestate") return /楼市|网签|住宅|政策|预算|通勤|现金流|同比/.test(sentence);
    if (domain === "tech") return /AI|苹果|手机|终端|标准|模型|效率|换机/.test(sentence);
    return true;
  });
  return useful.slice(0, 3).map((item) => shortLine(item, 44));
}

function shortLine(text, maxLength) {
  const clean = cleanText(text);
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

function extractVisualKeywords({ topic, angle, body, hashtags, domain }) {
  const text = cleanText(`${topic} ${angle} ${body} ${hashtags.join(" ")}`);
  const dictionary = domainKeywordDictionary[domain] || domainKeywordDictionary.general;
  const hits = dictionary.zh.filter((word) => text.includes(word));
  const hashtagWords = hashtags.map((tag) => cleanText(String(tag).replace(/^#/, ""))).filter(Boolean);
  const entities = [...new Set([...hits, ...hashtagWords])].slice(0, 5);
  return {
    zh: entities.length ? entities : dictionary.zh.slice(0, 3),
    en: dictionary.en,
  };
}

function visualQueryForDomain(domain, keywords) {
  const zhBase = domainVisualQueries[domain]?.zh || domainVisualQueries.general.zh;
  const enBase = domainVisualQueries[domain]?.en || domainVisualQueries.general.en;
  return {
    zh: compactQuery([...keywords.zh, ...zhBase], 8),
    en: compactQuery([...keywords.en, ...enBase], 8),
  };
}

function sceneQuery(baseQuery, keywords, zhIntent, enIntent) {
  return {
    zh: compactQuery([...keywords.zh, ...zhIntent, baseQuery.zh], 10),
    en: compactQuery([...keywords.en, ...enIntent.filter(Boolean), baseQuery.en], 10),
  };
}

function compactQuery(items, limit) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const terms = cleanText(item).split(/\s+/).filter(Boolean);
    for (const value of terms) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
      if (result.length >= limit) break;
    }
    if (result.length >= limit) break;
  }
  return result.join(" ");
}

function visualTypeForDomain(domain) {
  return domain === "stock" || domain === "economy" ? "chart" : "photo";
}

const domainLabels = {
  stock: "股市",
  realestate: "房产",
  tech: "科技",
  economy: "经济",
  politics: "国际关系",
  general: "新闻",
};

const domainEnglishLabels = {
  stock: "stock market",
  realestate: "real estate",
  tech: "technology",
  economy: "economy",
  politics: "international relations",
  general: "news",
};

const domainVisualQueries = {
  stock: {
    zh: ["股市", "股票行情", "K线图", "交易屏幕", "金融数据"],
    en: ["stock market", "trading screen", "financial chart"],
  },
  realestate: {
    zh: ["房产", "楼市", "住宅小区", "城市建筑", "售楼处"],
    en: ["real estate", "apartment buildings", "city housing"],
  },
  tech: {
    zh: ["科技", "人工智能", "智能手机", "芯片", "数字技术"],
    en: ["technology", "artificial intelligence", "smartphone", "chip"],
  },
  economy: {
    zh: ["经济", "消费", "零售", "商场", "数据图表"],
    en: ["economy", "retail", "shopping", "data chart"],
  },
  politics: {
    zh: ["国际关系", "新闻发布会", "会议", "旗帜", "外交"],
    en: ["international relations", "press conference", "flags"],
  },
  general: {
    zh: ["新闻", "热点", "资料图", "分析报告"],
    en: ["news", "analysis", "report"],
  },
};

const domainKeywordDictionary = {
  stock: {
    zh: ["A股", "股市", "股票", "半导体", "机器人", "算力", "板块", "成交量", "仓位", "投资"],
    en: ["stock market", "trading", "financial chart", "semiconductor", "robotics"],
  },
  realestate: {
    zh: ["房产", "楼市", "网签", "住宅", "刚需", "改善", "学区", "通勤", "政策", "现金流"],
    en: ["real estate", "housing market", "apartment buildings", "city"],
  },
  tech: {
    zh: ["AI", "人工智能", "手机", "苹果", "芯片", "终端", "大模型", "效率工具", "机器人"],
    en: ["artificial intelligence", "smartphone", "technology", "chip"],
  },
  economy: {
    zh: ["经济", "消费", "就业", "零售", "利率", "降价", "预算", "钱包"],
    en: ["economy", "retail", "shopping", "employment", "consumer"],
  },
  politics: {
    zh: ["国际", "外交", "关系", "会议", "发布会", "政策"],
    en: ["international relations", "conference", "news"],
  },
  general: {
    zh: ["新闻", "热点", "分析", "数据", "趋势"],
    en: ["news", "analysis", "data", "trend"],
  },
};

const impactLines = {
  stock: ["市场情绪正在从避险切到结构性机会", "板块轮动越快，越需要区分趋势和短线噪音"],
  realestate: ["成交和网签变化会影响买卖双方预期", "政策信号会传导到预算、通勤和现金流决策"],
  tech: ["AI 功能正在从营销词变成产品分级标准", "换机决策会从参数比较变成效率场景比较"],
  economy: ["消费和就业数据会影响家庭预算预期", "降价潮背后往往是库存、需求和竞争的共同作用"],
  politics: ["国际关系热点会影响市场预期和公共讨论", "越是高热度议题，越要区分事实、立场和猜测"],
  general: ["它会影响普通人的判断和选择", "热度背后要看数据、来源和后续变化"],
};

const metricLines = {
  stock: "成交量、领涨持续性、资金是否从题材扩散到基本面",
  realestate: "网签持续性、挂牌变化、按揭成本和真实成交周期",
  tech: "标准落地时间、真实可用功能、用户是否愿意为效率付费",
  economy: "零售数据、就业变化、价格折扣能否转化为真实需求",
  politics: "权威来源、时间线、不同媒体是否互相印证",
  general: "来源可信度、数据是否更新、讨论有没有新的事实增量",
};

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
