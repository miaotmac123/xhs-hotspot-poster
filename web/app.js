let drafts = [];
let selectedDraft = null;
let activeTab = "draft";

const draftList = document.querySelector("#draftList");
const draftCount = document.querySelector("#draftCount");
const fallbackCount = document.querySelector("#fallbackCount");
const latestInfo = document.querySelector("#latestInfo");
const searchInput = document.querySelector("#searchInput");
const emptyState = document.querySelector("#emptyState");
const draftDetail = document.querySelector("#draftDetail");
const generateOnceBtn = document.querySelector("#generateOnceBtn");
const generateOnceStatus = document.querySelector("#generateOnceStatus");
const generateImageBtn = document.querySelector("#generateImageBtn");
const generateAiImageBtn = document.querySelector("#generateAiImageBtn");
const manualImageInput = document.querySelector("#manualImageInput");
const generateVideoBtn = document.querySelector("#generateVideoBtn");
const generateVideoPlanBtn = document.querySelector("#generateVideoPlanBtn");
const saveVideoScriptBtn = document.querySelector("#saveVideoScriptBtn");
const videoScriptInput = document.querySelector("#videoScriptInput");
const videoStyleSelect = document.querySelector("#videoStyleSelect");
const preparePublishBtn = document.querySelector("#preparePublishBtn");
const autoFillXhsBtn = document.querySelector("#autoFillXhsBtn");
const publishPackageInfo = document.querySelector("#publishPackageInfo");

document.querySelector("#refreshBtn").addEventListener("click", () => loadDrafts({ keepSelected: true }));
generateOnceBtn.addEventListener("click", generateDraftsOnce);
searchInput.addEventListener("input", renderDraftList);
generateImageBtn.addEventListener("click", () => generateImageForSelected("local"));
generateAiImageBtn.addEventListener("click", () => generateImageForSelected("ai"));
manualImageInput.addEventListener("change", uploadManualImage);
generateVideoPlanBtn.addEventListener("click", generateVideoPlanForSelected);
saveVideoScriptBtn.addEventListener("click", saveVideoScriptForSelected);
generateVideoBtn.addEventListener("click", generateVideoForSelected);
preparePublishBtn.addEventListener("click", preparePublishPackage);
autoFillXhsBtn.addEventListener("click", prepareAutoFillXhs);

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!selectedDraft) return;
    const text = copyTextFor(button.dataset.copy, selectedDraft);
    await navigator.clipboard.writeText(text);
    pulseButton(button, "已复制");
  });
});

async function loadDrafts(options = {}) {
  const preferredId = options.keepSelected ? selectedDraft?.id : options.selectId;
  const response = await fetch("/api/drafts");
  drafts = await response.json();
  draftCount.textContent = drafts.length;
  fallbackCount.textContent = drafts.filter((draft) => draft.has_error || draft.has_video_error || draft.has_image_error).length;
  latestInfo.textContent = drafts[0]?.generated_at ? `最新：${drafts[0].generated_at}` : "暂无生成记录";
  renderDraftList();
  if (!drafts.length) {
    selectedDraft = null;
    emptyState.classList.remove("hidden");
    draftDetail.classList.add("hidden");
    return;
  }

  const nextId = drafts.some((draft) => draft.id === preferredId) ? preferredId : drafts[0].id;
  if (nextId) await selectDraft(nextId);
}

async function generateDraftsOnce() {
  setButtonLoading(generateOnceBtn, true, "生成中...");
  generateOnceStatus.classList.remove("hidden");
  generateOnceStatus.textContent = "正在抓取热点并生成草稿，通常需要几十秒。";
  try {
    const response = await fetch("/api/generate-once", { method: "POST" });
    const result = await response.json();
    if (!result.ok) {
      generateOnceStatus.textContent = result.error || "生成失败，请查看日志。";
      return;
    }
    const count = result.generated_paths?.length || 0;
    generateOnceStatus.textContent = `已生成 ${count} 篇，列表已刷新。`;
    await loadDrafts({ selectId: result.latest_draft_id });
  } catch (error) {
    generateOnceStatus.textContent = `生成失败：${error.message}`;
  } finally {
    setButtonLoading(generateOnceBtn, false, "生成今日热点");
  }
}

function renderDraftList() {
  const keyword = searchInput.value.trim().toLowerCase();
  const visibleDrafts = drafts.filter((draft) => {
    const haystack = `${draft.topic} ${draft.date} ${(draft.hashtags || []).join(" ")}`.toLowerCase();
    return !keyword || haystack.includes(keyword);
  });

  draftList.innerHTML = "";
  visibleDrafts.forEach((draft) => {
    const button = document.createElement("button");
    button.className = `draft-card ${selectedDraft?.id === draft.id ? "active" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(draft.topic)}</strong>
      <div class="draft-meta">
        <span>${escapeHtml(draft.date || "")}</span>
        ${draft.has_image ? "<span>有封面</span>" : ""}
        ${draft.has_video ? "<span>有视频</span>" : ""}
        ${draft.has_error || draft.has_image_error || draft.has_video_error ? "<span class=\"warn-text\">需处理</span>" : "<span>可审核</span>"}
      </div>
    `;
    button.addEventListener("click", () => selectDraft(draft.id));
    draftList.appendChild(button);
  });
}

async function selectDraft(id) {
  const response = await fetch(`/api/drafts/${encodeURIComponent(id)}`);
  selectedDraft = await response.json();
  selectedDraft.id = id;
  renderDraftList();
  renderDetail(selectedDraft);
}

function setActiveTab(tab) {
  activeTab = tab || "draft";
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === activeTab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${activeTab}`);
  });
}

function renderDetail(draft) {
  emptyState.classList.add("hidden");
  draftDetail.classList.remove("hidden");

  document.querySelector("#dateText").textContent = `${draft.generated_at || ""} · ${draft.model || ""}`;
  document.querySelector("#topicText").textContent = draft.selected_topic || "未命名草稿";
  document.querySelector("#coverText").textContent = draft.cover_text || "待补充封面文字";

  const hasError = Boolean(draft.generation_error || draft.image_generation_error || draft.video_generation_error);
  const badge = document.querySelector("#statusBadge");
  badge.textContent = hasError ? "需处理" : "可审核";
  badge.className = `badge ${hasError ? "warn" : ""}`;

  fillList("#titlesList", draft.title_options || []);
  document.querySelector("#bodyText").textContent = draft.body || "";
  fillTags("#hashtagList", draft.hashtags || []);
  fillList("#imageIdeas", draft.image_ideas || []);
  fillList("#checklist", draft.publish_checklist || []);
  fillList("#riskNotes", draft.risk_notes || []);

  renderImage(draft);
  renderVideo(draft);
  renderStatusPanel(draft);
  setActiveTab(activeTab);
}

function fillList(selector, items) {
  const node = document.querySelector(selector);
  node.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "暂无";
    node.appendChild(li);
    return;
  }
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    node.appendChild(li);
  });
}

function fillTags(selector, tags) {
  const node = document.querySelector(selector);
  node.innerHTML = "";
  if (!tags.length) {
    node.innerHTML = `<span class="muted">暂无标签</span>`;
    return;
  }
  tags.forEach((tag) => {
    const span = document.createElement("span");
    span.className = "tag";
    span.textContent = tag;
    node.appendChild(span);
  });
}

function copyTextFor(field, draft) {
  if (field === "titles") return (draft.title_options || []).join("\n");
  if (field === "hashtags") return (draft.hashtags || []).join(" ");
  return draft.body || "";
}

function renderImage(draft) {
  const preview = document.querySelector("#imagePreview");
  const error = document.querySelector("#imageError");
  const imageOpenLink = document.querySelector("#imageOpenLink");
  const image = draft.generated_image;
  error.classList.toggle("hidden", !draft.image_generation_error);
  error.textContent = draft.image_generation_error || "";

  if (image?.path) {
    const imageUrl = `/assets/${encodeURI(image.path)}`;
    preview.innerHTML = `<img alt="封面或配图预览" src="${imageUrl}" />`;
    imageOpenLink.href = imageUrl;
    imageOpenLink.classList.remove("hidden");
  } else {
    preview.innerHTML = "<p>还没有生成图片。</p>";
    imageOpenLink.classList.add("hidden");
  }
}

function renderVideo(draft) {
  const preview = document.querySelector("#videoPreview");
  const error = document.querySelector("#videoError");
  const videoOpenLink = document.querySelector("#videoOpenLink");
  const video = draft.generated_video;
  const plan = draft.video_plan;
  error.classList.toggle("hidden", !draft.video_generation_error);
  error.textContent = draft.video_generation_error || "";
  videoScriptInput.value = plan?.voiceover || "";
  videoStyleSelect.value = draft.video_style_preset || plan?.stylePreset || "xiaohongshu";
  renderVideoMeta(draft);

  if (video?.path) {
    const videoUrl = `/assets/${encodeURI(video.path)}`;
    preview.innerHTML = `<video controls playsinline preload="metadata" src="${videoUrl}"></video>`;
    videoOpenLink.href = videoUrl;
    videoOpenLink.classList.remove("hidden");
  } else {
    preview.innerHTML = "<p>还没有生成视频。</p>";
    videoOpenLink.classList.add("hidden");
  }
}

function renderVideoMeta(draft) {
  const node = document.querySelector("#videoMeta");
  const video = draft.generated_video || {};
  const sources = video.background_sources || [];
  const usage = video.image_search_usage;
  const rows = [];
  rows.push(["平台风格", styleLabel(draft.video_style_preset || draft.video_plan?.stylePreset || video.style_preset || "xiaohongshu")]);
  rows.push(["分镜", draft.video_plan?.scenes?.length ? `${draft.video_plan.scenes.length} 段` : "未生成"]);
  rows.push(["字幕", video.subtitle_path || "未生成"]);
  rows.push(["音频", video.audio_duration_seconds ? `${video.audio_duration_seconds} 秒 · ${video.voice_provider || "未记录"}` : "未生成"]);
  rows.push(["TTS 成本", video.tts_estimated_cost_cny ? `约 ${video.tts_estimated_cost_cny} 元` : "暂无记录"]);
  rows.push(["腾讯图搜", usage ? `${usage.tencent_wimgs_calls || 0} 次，约 ${usage.estimated_cost_cny || 0} 元` : "未调用或未记录"]);
  rows.push(["素材来源", sources.length ? sources.slice(0, 3).map((source) => `${source.provider}: ${source.title || source.query || ""}`).join(" / ") : "尚未生成或未拉到外部图片"]);
  node.innerHTML = rows.map(([label, value]) => `
    <div>
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
    </div>
  `).join("");
}

function renderStatusPanel(draft) {
  const node = document.querySelector("#statusPanel");
  const video = draft.generated_video || {};
  const image = draft.generated_image || {};
  const usage = video.image_search_usage;
  const errors = [
    draft.generation_error && ["草稿", draft.generation_error],
    draft.image_generation_error && ["图片", draft.image_generation_error],
    draft.video_generation_error && ["视频", draft.video_generation_error],
  ].filter(Boolean);
  node.innerHTML = `
    ${statusRow("草稿", draft.generated_at || "未记录", "生成时间")}
    ${statusRow("封面", image.path ? "已生成" : "未生成", image.provider || "provider 未记录")}
    ${statusRow("视频", video.path ? "已生成" : "未生成", video.path || "等待生成")}
    ${statusRow("成本", costSummary(video, usage), "只统计已写回的 provider")}
    ${statusRow("发布包", draft.platform_packages ? "已记录" : "待生成", "当前以本地发布包为主")}
    ${errors.length ? `<div class="status-errors">${errors.map(([label, text]) => `<p><strong>${escapeHtml(label)}：</strong>${escapeHtml(text)}</p>`).join("")}</div>` : ""}
  `;
}

function statusRow(title, value, note) {
  return `
    <div class="status-row">
      <span>${escapeHtml(title)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note || "")}</small>
    </div>
  `;
}

function mergeDraftResult(result, draftId) {
  if (result?.draft) {
    selectedDraft = { ...result.draft, id: draftId };
  } else if (selectedDraft) {
    selectedDraft = { ...selectedDraft, id: draftId };
  }
  renderDetail(selectedDraft);
}

async function refreshDraftListAfterSuccess(result, draftId) {
  if (result?.ok) {
    await loadDrafts({ selectId: draftId });
  } else {
    renderDraftList();
  }
}

async function generateImageForSelected(mode = "local") {
  if (!selectedDraft) return;
  const draftId = selectedDraft.id;
  const button = mode === "ai" ? generateAiImageBtn : generateImageBtn;
  setButtonLoading(button, true, "生成中...");
  const endpoint = mode === "ai" ? "image-ai" : "image-local";
  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/${endpoint}`, { method: "POST" });
    const result = await response.json();
    mergeDraftResult(result, draftId);
    await refreshDraftListAfterSuccess(result, draftId);
  } finally {
    setButtonLoading(button, false, mode === "ai" ? "大模型生成图" : "本地生成封面");
  }
}

async function generateVideoPlanForSelected() {
  if (!selectedDraft) return;
  const draftId = selectedDraft.id;
  setActiveTab("video");
  setButtonLoading(generateVideoPlanBtn, true, "生成中...");
  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/video-plan-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style_preset: videoStyleSelect.value }),
    });
    const result = await response.json();
    mergeDraftResult(result, draftId);
    await refreshDraftListAfterSuccess(result, draftId);
    if (result.ok) pulseButton(generateVideoPlanBtn, "已生成");
  } finally {
    setButtonLoading(generateVideoPlanBtn, false, "生成视频稿");
  }
}

async function saveVideoScriptForSelected(options = {}) {
  if (!selectedDraft) return;
  const draftId = selectedDraft.id;
  if (!options.quiet) setButtonLoading(saveVideoScriptBtn, true, "保存中...");
  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/video-script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceover: videoScriptInput.value, style_preset: videoStyleSelect.value }),
    });
    const result = await response.json();
    mergeDraftResult(result, draftId);
    if (!options.quiet) pulseButton(saveVideoScriptBtn, result.ok ? "已保存" : "保存失败");
    return result;
  } finally {
    if (!options.quiet) setButtonLoading(saveVideoScriptBtn, false, "保存视频稿");
  }
}

async function generateVideoForSelected() {
  if (!selectedDraft) return;
  setActiveTab("video");
  const saveResult = await saveVideoScriptForSelected({ quiet: true });
  if (saveResult && !saveResult.ok) return;
  const draftId = selectedDraft.id;
  setButtonLoading(generateVideoBtn, true, "生成中...");
  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/video-local`, { method: "POST" });
    const result = await response.json();
    mergeDraftResult(result, draftId);
    await refreshDraftListAfterSuccess(result, draftId);
    pulseButton(generateVideoBtn, result.ok ? "已生成" : "生成失败");
  } finally {
    setButtonLoading(generateVideoBtn, false, "按稿生成视频");
  }
}

async function preparePublishPackage() {
  if (!selectedDraft) return;
  setActiveTab("publish");
  await createPublishPackage(preparePublishBtn, "准备发布包");
}

async function prepareAutoFillXhs() {
  if (!selectedDraft) return;
  await createPublishPackage(autoFillXhsBtn, "准备小红书填入", true);
}

async function createPublishPackage(button, idleText, openCreator = false) {
  const draftId = selectedDraft.id;
  setButtonLoading(button, true, "准备中...");
  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/publish-package`, { method: "POST" });
    const result = await response.json();
    if (result.ok) {
      await navigator.clipboard.writeText(result.combined_text);
      mergeDraftResult(result, draftId);
      publishPackageInfo.classList.remove("hidden");
      publishPackageInfo.innerHTML = `
        <strong>发布包已生成，文案已复制。</strong><br>
        图片：<code>${escapeHtml(result.cover_png)}</code><br>
        ${result.video_path ? `视频：<code>${escapeHtml(result.video_path)}</code><br>` : ""}
        文案：<code>${escapeHtml(result.publish_txt)}</code>
      `;
      if (result.image_url) window.open(result.image_url, "_blank", "noopener,noreferrer");
      if (openCreator && result.creator_url) window.open(result.creator_url, "_blank", "noopener,noreferrer");
      pulseButton(button, "已准备");
    } else {
      publishPackageInfo.classList.remove("hidden");
      publishPackageInfo.textContent = result.error || "发布包生成失败。";
      pulseButton(button, "准备失败");
    }
  } finally {
    setButtonLoading(button, false, idleText);
  }
}

async function uploadManualImage(event) {
  if (!selectedDraft) return;
  const draftId = selectedDraft.id;
  const file = event.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("image", file);
  const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/upload-image`, {
    method: "POST",
    body: form,
  });
  const result = await response.json();
  mergeDraftResult(result, draftId);
  await refreshDraftListAfterSuccess(result, draftId);
  manualImageInput.value = "";
}

function setButtonLoading(button, loading, text) {
  button.disabled = loading;
  button.textContent = text;
}

function styleLabel(value) {
  if (value === "douyin") return "抖音";
  if (value === "shipinhao") return "视频号";
  return "小红书";
}

function costSummary(video, usage) {
  const parts = [];
  if (usage) parts.push(`图搜约 ${usage.estimated_cost_cny || 0} 元`);
  if (video.tts_estimated_cost_cny) parts.push(`TTS 约 ${video.tts_estimated_cost_cny} 元`);
  return parts.length ? parts.join(" / ") : "暂无记录";
}

function pulseButton(button, text) {
  const oldText = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = oldText;
  }, 1100);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadDrafts();
