import { createTwoFilesPatch } from "diff";
import type { ReviewDiffFile } from "../../domain/review/types";
import type { PullRequestDiff, PullRequestMeta } from "../../ports/github";

export type ChangedFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  sha: string | null;
  additions: number;
  deletions: number;
  patch?: string;
};

export type BlobPayload = { sha: string; encoding: string; size: number; content: string };

/** The reads `assembleDiff` needs. Implemented over Octokit and over the in-memory world. */
export type DiffSource = {
  getMeta(): Promise<PullRequestMeta>;
  listFiles(): Promise<ChangedFile[]>;
  mergeBase(baseSha: string, headSha: string): Promise<string>;
  /** Blob SHA of `path` at commit `ref`; throws when it is not a plain file. */
  fileShaAt(path: string, ref: string): Promise<string>;
  readBlob(sha: string): Promise<BlobPayload>;
};

/** The PR head or base moved while the diff was being read. Mapped to `conflict`. */
export class PrChangedError extends Error {
  constructor() {
    super("pull request changed while its diff was being read");
    this.name = "PrChangedError";
  }
}

async function readTextBlob(source: DiffSource, sha: string) {
  const blob = await source.readBlob(sha);
  if (blob.encoding !== "base64" || blob.sha !== sha) {
    throw new Error("cannot read the complete git blob");
  }
  const bytes = Buffer.from(blob.content, "base64");
  if (bytes.length !== blob.size) throw new Error("git blob content is incomplete");
  const text = bytes.toString("utf8");
  if (
    !Buffer.from(text, "utf8").equals(bytes) ||
    bytes.some((byte) => (byte > 0 && byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127) ||
    (bytes.includes(0) && !text.replaceAll("\0", "").trim())
  ) {
    throw new Error("file is not UTF-8 source that can be recovered as a text diff");
  }
  return text;
}

/** Recover an omitted patch using the PR merge base, never the current base tip. */
export async function recoverFileDiff(
  source: DiffSource,
  file: ChangedFile,
  header: string,
  getMergeBase: () => Promise<string>,
): Promise<ReviewDiffFile> {
  if (!["added", "copied", "removed", "modified", "renamed"].includes(file.status)) {
    throw new Error(`cannot recover a diff for status ${file.status}`);
  }
  if (file.status === "renamed" && !file.previous_filename) {
    throw new Error("renamed file has no previous path");
  }
  const oldPath = file.previous_filename ?? file.filename;
  let oldSha: string | undefined;
  if (file.status !== "added" && file.status !== "copied") {
    oldSha = await source.fileShaAt(oldPath, await getMergeBase());
  }
  const newSha = file.status === "removed" ? undefined : file.sha;
  if (file.status !== "removed" && !newSha) throw new Error("file has no git blob SHA");

  // A path move still matters to the reviewer, even when its bytes are unchanged.
  if (file.status === "renamed" && oldSha === newSha) {
    return {
      header: `${header}\nSource note: content unchanged; verified identical Git blob ${newSha}.`,
      patch: `similarity index 100%\nrename from ${oldPath}\nrename to ${file.filename}\n`,
    };
  }

  const [before, after] = await Promise.all([
    oldSha ? readTextBlob(source, oldSha) : Promise.resolve(""),
    newSha ? readTextBlob(source, newSha) : Promise.resolve(""),
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

/** Port of `fetchPullRequest`: meta, files with patch recovery, then a head/base re-check. */
export async function assembleDiff(source: DiffSource): Promise<PullRequestDiff> {
  const meta = await source.getMeta();
  const files = await source.listFiles();

  let complete = files.length === meta.changedFiles;
  const diffFiles: ReviewDiffFile[] = [];
  const missing: string[] = [];
  let mergeBase: Promise<string> | undefined;
  const getMergeBase = () => (mergeBase ??= source.mergeBase(meta.baseSha, meta.sha));
  for (const file of files) {
    let header = `### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`;
    if (file.previous_filename) header += `\nPrevious path: ${file.previous_filename}`;
    if (file.patch) {
      diffFiles.push({ header, patch: file.patch });
      continue;
    }
    try {
      diffFiles.push(await recoverFileDiff(source, file, header, getMergeBase));
    } catch (error) {
      complete = false;
      missing.push(
        `${file.filename} (${error instanceof Error ? error.message : "unrecoverable"})`,
      );
    }
  }

  const current = await source.getMeta();
  if (current.sha !== meta.sha || current.baseSha !== meta.baseSha) throw new PrChangedError();

  return {
    meta,
    files: diffFiles,
    complete,
    incompleteReason:
      files.length !== meta.changedFiles
        ? `file list incomplete (received ${files.length}/${meta.changedFiles} files)`
        : missing.length
          ? `files missing a diff: ${missing.join(", ")}`
          : undefined,
  };
}
