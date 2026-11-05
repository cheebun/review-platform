export function ReviewHeader() {
  return (
    <div>
      <p className="ops-kicker">Review</p>
      <h1 className="ops-title">PR Review</h1>
      <p className="ops-desc">
        点击条目打开 PR。他人点 Ship 执行 Review + Approve（无 P0）；自己的 PR 可复制链接/标题，或直接
        Merge。Tianye / Jayce / Dajiang / Zhengzhu 只 Approve；其他人通过后自动 Merge。
      </p>
    </div>
  );
}
