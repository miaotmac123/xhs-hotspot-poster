let drafts = [];
let selectedDraft = null;

const draftList = document.querySelector("#draftList");
const draftCount = document.querySelector("#draftCount");
const fallbackCount = document.querySelector("#fallbackCount");
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

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!selectedDraft) return;
    const field = button.dataset.copy;
    const text = copyTextFor(field, selectedDraft);
    navigator.clipboard.writeText(text);
    const oldText = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = oldText;
    }, 1200);
  });
});

async function loadDrafts(options = {}) {
  const preferredId = options.keepSelected ? selectedDraft?.id : options.selectId;
  const response = await fetch("/api/drafts");
  drafts = await response.json();
  draftCount.textContent = drafts.length;
  fallbackCount.textContent = drafts.filter((draft) => draft.has_error).length;
  renderDraftList();
  if (!drafts.length) return;

  const nextId = drafts.some((draft) => draft.id === preferredId) ? preferredId : drafts[0].id;
  if (nextId) {
    await selectDraft(nextId);
  }
}

async function generateDraftsOnce() {
  generateOnceBtn.disabled = true;
  generateOnceBtn.textContent = "生成中...";
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
    generateOnceBtn.disabled = false;
    generateOnceBtn.textContent = "生成今日热点";
  }
}

function renderDraftList() {
  const keyword = searchInput.value.trim().toLowerCase();
  const visibleDrafts = drafts.filter((draft) => {
    const haystack = `${draft.topic} ${(draft.hashtags || []).join(" ")}`.toLowerCase();
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
        <span>${escapeHtml(draft.model || "")}</span>
        ${draft.has_error ? "<span>需处理</span>" : "<span>可审核</span>"}
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

function renderDetail(draft) {
  emptyState.classList.add("hidden");
  draftDetail.classList.remove("hidden");

  document.querySelector("#dateText").textContent = `${draft.generated_at || ""} · ${draft.model || ""}`;
  document.querySelector("#topicText").textContent = draft.selected_topic || "未命名草稿";
  document.querySelector("#coverText").textContent = draft.cover_text || "待补充封面文字";

  const badge = document.querySelector("#statusBadge");
  badge.textContent = draft.generation_error ? "需处理" : "可审核";
  badge.className = `badge ${draft.generation_error ? "warn" : ""}`;

  fillList("#titlesList", draft.title_options || [], "ol");
  document.querySelector("#bodyText").textContent = draft.body || "";
  fillTags("#hashtagList", draft.hashtags || []);
  fillList("#imageIdeas", draft.image_ideas || []);
  fillList("#checklist", draft.publish_checklist || []);
  fillList("#riskNotes", draft.risk_notes || []);
  renderImage(draft);
  renderVideo(draft);
}

function fillList(selector, items) {
  const node = document.querySelector(selector);
  node.innerHTML = "";
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    node.appendChild(li);
  });
}

function fillTags(selector, tags) {
  const node = document.querySelector(selector);
  node.innerHTML = "";
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
    preview.innerHTML = `<img alt="AI 生成配图" src="${imageUrl}" />`;
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
  const sources = draft.generated_video?.background_sources || [];
  const subtitle = draft.generated_video?.subtitle_path;
  const usage = draft.generated_video?.image_search_usage;
  const audioDuration = draft.generated_video?.audio_duration_seconds;
  const sourceText = sources.length
    ? sources.slice(0, 3).map((source) => `${source.provider}: ${source.title || source.query || ""}`).join(" / ")
    : "图片源：尚未生成或未拉到外部图片";
  node.innerHTML = `
    <span>${escapeHtml(sourceText)}</span>
    ${usage ? `<span>腾讯云图片搜索：${escapeHtml(usage.tencent_wimgs_calls || 0)} 次，约 ${escapeHtml(usage.estimated_cost_cny || 0)} 元</span>` : ""}
    ${audioDuration ? `<span>音频时长：${escapeHtml(audioDuration)} 秒，字幕按音频重排</span>` : ""}
    ${subtitle ? `<span>字幕：${escapeHtml(subtitle)}</span>` : ""}
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
  renderDraftList();
  if (result?.ok) {
    await loadDrafts({ selectId: draftId });
  }
}

async function generateImageForSelected(mode = "local") {
  if (!selectedDraft) return;
  const draftId = selectedDraft.id;
  const button = mode === "ai" ? generateAiImageBtn : generateImageBtn;
  button.disabled = true;
  button.textContent = "生成中...";
  const endpoint = mode === "ai" ? "image-ai" : "image-local";
  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/${endpoint}`, {
      method: "POST",
    });
    const result = await response.json();
    mergeDraftResult(result, draftId);
    await refreshDraftListAfterSuccess(result, draftId);
  } finally {
    button.disabled = false;
    button.textContent = mode === "ai" ? "大模型生成图" : "本地生成封面";
  }
}

async function generateVideoForSelected() {
  if (!selectedDraft) return;
  const saveResult = await saveVideoScriptForSelected({ quiet: true });
  if (saveResult && !saveResult.ok) return;
  const draftId = selectedDraft.id;
  generateVideoBtn.disabled = true;
  generateVideoBtn.textContent = "生成中...";
  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/video-local`, {
      method: "POST",
    });
    const result = await response.json();
    mergeDraftResult(result, draftId);
    await refreshDraftListAfterSuccess(result, draftId);
    generateVideoBtn.textContent = result.ok ? "重新生成视频" : "生成本地视频";
  } finally {
    generateVideoBtn.disabled = false;
    if (generateVideoBtn.textContent === "生成中...") {
      generateVideoBtn.textContent = "生成本地视频";
    }
  }
}

async function generateVideoPlanForSelected() {
  if (!selectedDraft) return;
  const draftId = selectedDraft.id;
  generateVideoPlanBtn.disabled = true;
  generateVideoPlanBtn.textContent = "生成中...";
  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/video-plan-local`, {
      method: "POST",
    });
    const result = await response.json();
    mergeDraftResult(result, draftId);
    await refreshDraftListAfterSuccess(result, draftId);
    generateVideoPlanBtn.textContent = result.ok ? "重新生成视频稿" : "生成视频稿";
  } finally {
    generateVideoPlanBtn.disabled = false;
    if (generateVideoPlanBtn.textContent === "生成中...") {
      generateVideoPlanBtn.textContent = "生成视频稿";
    }
  }
}

async function saveVideoScriptForSelected(options = {}) {
  if (!selectedDraft) return;
  const draftId = selectedDraft.id;
  saveVideoScriptBtn.disabled = true;
  if (!options.quiet) saveVideoScriptBtn.textContent = "保存中...";
  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/video-script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceover: videoScriptInput.value }),
    });
    const result = await response.json();
    mergeDraftResult(result, draftId);
    saveVideoScriptBtn.textContent = result.ok ? "已保存" : "保存视频稿";
    return result;
  } finally {
    saveVideoScriptBtn.disabled = false;
    setTimeout(() => {
      saveVideoScriptBtn.textContent = "保存视频稿";
    }, 1200);
  }
}

async function preparePublishPackage() {
  if (!selectedDraft) return;
  const draftId = selectedDraft.id;
  preparePublishBtn.disabled = true;
  preparePublishBtn.textContent = "准备中...";
  const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/publish-package`, {
    method: "POST",
  });
  const result = await response.json();
  if (result.ok) {
    await navigator.clipboard.writeText(result.combined_text);
    mergeDraftResult(result, draftId);
    window.open(result.image_url, "_blank", "noopener,noreferrer");
    window.open(result.creator_url, "_blank", "noopener,noreferrer");
    publishPackageInfo.classList.remove("hidden");
    publishPackageInfo.innerHTML = `
      发布包已生成：<br>
      图片：<code>${escapeHtml(result.cover_png)}</code><br>
      ${result.video_path ? `视频：<code>${escapeHtml(result.video_path)}</code><br>` : ""}
      文案：<code>${escapeHtml(result.publish_txt)}</code>
    `;
    preparePublishBtn.textContent = "发布包已生成";
  } else {
    preparePublishBtn.textContent = "准备失败";
  }
  setTimeout(() => {
    preparePublishBtn.disabled = false;
    preparePublishBtn.textContent = "准备发布包";
  }, 1800);
}

async function prepareAutoFillXhs() {
  if (!selectedDraft) return;
  const draftId = selectedDraft.id;
  autoFillXhsBtn.disabled = true;
  autoFillXhsBtn.textContent = "准备中...";
  const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/publish-package`, {
    method: "POST",
  });
  const result = await response.json();
  if (result.ok) {
    await navigator.clipboard.writeText(result.combined_text);
    mergeDraftResult(result, draftId);
    publishPackageInfo.classList.remove("hidden");
    publishPackageInfo.innerHTML = `
      已选择这篇用于自动填入小红书：<br>
      图片：<code>${escapeHtml(result.cover_png)}</code><br>
      ${result.video_path ? `视频：<code>${escapeHtml(result.video_path)}</code><br>` : ""}
      文案：<code>${escapeHtml(result.publish_txt)}</code><br>
      请回到 Codex 对话里说：<code>自动填这篇</code>
    `;
    window.open(result.creator_url, "_blank", "noopener,noreferrer");
    autoFillXhsBtn.textContent = "已准备，等 Codex 填入";
  } else {
    autoFillXhsBtn.textContent = "准备失败";
  }
  setTimeout(() => {
    autoFillXhsBtn.disabled = false;
    autoFillXhsBtn.textContent = "自动填入小红书";
  }, 2200);
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadDrafts();
