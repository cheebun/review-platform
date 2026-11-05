import type { Octokit } from "@octokit/rest";
import { createTwoFilesPatch } from "diff";
import type { PrRef } from "./types";
import type { ReviewDiffFile } from "./review-input";

type ChangedFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  sha: string | null;
};

async function readTextBlob(octokit: Octokit, ref: PrRef, sha: string) {
  const { data: blob } = await octokit.git.getBlob({
    owner: ref.owner,
    repo: ref.repo,
    file_sha: sha,
  });
  if (blob.encoding !== "base64" || blob.sha !== sha) {
    throw new Error("无法读取完整 Git blob");
  }
  const bytes = Buffer.from(blob.content, "base64");
  if (bytes.length !== blob.size) throw new Error("Git blob 内容不完整");
  const source = bytes.toString("utf8");
  if (
    !Buffer.from(source, "utf8").equals(bytes) ||
    bytes.some((byte) => (byte > 0 && byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127) ||
    (bytes.includes(0) && !source.replaceAll("\0", "").trim())
  ) {
    throw new Error("文件不是可恢复为文本 Diff 的 UTF-8 源码");
  }
  return source;
}

/** Recover omitted patches using the PR merge base, never the current base tip. */
export async function recoverFileDiff(
  octokit: Octokit,
  ref: PrRef,
  file: ChangedFile,
  header: string,
  getMergeBase: () => Promise<string>,
): Promise<ReviewDiffFile> {
  if (!["added", "copied", "removed", "modified", "renamed"].includes(file.status)) {
    throw new Error(`无法恢复 ${file.status} 类型的 Diff`);
  }
  if (file.status === "renamed" && !file.previous_filename) {
    throw new Error("重命名文件缺少原路径");
  }
  const oldPath = file.previous_filename ?? file.filename;
  let oldSha: string | undefined;
  if (file.status !== "added" && file.status !== "copied") {
    const { data: oldFile } = await octokit.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: oldPath,
      ref: await getMergeBase(),
    });
    if (Array.isArray(oldFile) || oldFile.type !== "file" || !oldFile.sha) {
      throw new Error("无法读取共同祖先版本的文件");
    }
    oldSha = oldFile.sha;
  }
  const newSha = file.status === "removed" ? undefined : file.sha;
  if (file.status !== "removed" && !newSha) throw new Error("文件缺少 Git blob SHA");

  // A path move still matters to the reviewer, even when its bytes are unchanged.
  if (file.status === "renamed" && oldSha === newSha) {
    return {
      header: `${header}\nSource note: content unchanged; verified identical Git blob ${newSha}.`,
      patch: `similarity index 100%\nrename from ${oldPath}\nrename to ${file.filename}\n`,
    };
  }

  const [before, after] = await Promise.all([
    oldSha ? readTextBlob(octokit, ref, oldSha) : Promise.resolve(""),
    newSha ? readTextBlob(octokit, ref, newSha) : Promise.resolve(""),
  ]);
  let patch = createTwoFilesPatch(
    oldSha ? `a/${oldPath}` : "/dev/null",
    newSha ? `b/${file.filename}` : "/dev/null",
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  );
  let note = `Source note: GitHub omitted the patch. Reconstructed the complete text Diff from Git blobs ${oldSha ?? "absent"} -> ${newSha ?? "absent"}.`;
  if (before.includes("\0") || after.includes("\0")) {
    let marker = "⟦NUL:0x00⟧";
    while (before.includes(marker) || after.includes(marker)) marker = `⟦${marker}⟧`;
    // Diff the original bytes first: a literal NUL differs from a source-code escape.
    patch = patch.replaceAll("\0", marker);
    note += ` Actual NUL bytes are displayed as ${marker}; literal escape sequences are unchanged. Old file: ${before.split("\0").length - 1} NUL bytes; new file: ${after.split("\0").length - 1}.`;
  }
  return { header: `${header}\n${note}`, patch };
}
