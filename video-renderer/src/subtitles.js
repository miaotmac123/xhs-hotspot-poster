import { writeFile } from "node:fs/promises";

export async function writeSrtSubtitles({ plan, outputPath }) {
  const segments = plan.subtitleSegments || [];
  const body = segments.map((segment, index) => [
    String(index + 1),
    `${formatTime(segment.startSeconds || 0)} --> ${formatTime(segment.endSeconds || 0)}`,
    String(segment.text || "").trim(),
    "",
  ].join("\n")).join("\n");
  await writeFile(outputPath, body, "utf8");
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const wholeSeconds = Math.floor(value % 60);
  const millis = Math.round((value - Math.floor(value)) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)},${String(millis).padStart(3, "0")}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}
