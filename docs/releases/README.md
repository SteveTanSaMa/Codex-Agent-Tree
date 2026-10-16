# Release 格式 / Release format

- 标签：`vMAJOR.MINOR.PATCH`；预发布追加 `-alpha.N`、`-beta.N` 或 `-rc.N`。标题统一为 `Codex Agent Tree <tag>`，不追加功能副标题。
- 附件：`codex-agent-tree-<version>.zip` 与同名 `.zip.sha256`，文件名中的版本不带 `v`。
- 说明按 `中文`、`English` 两节排列，条目含义、顺序一致；使用“新增 / Added”“修改 / Changed”“修复 / Fixed”“移除 / Removed”，省略空分类。
- 只记录该标签实际包含的变更。不包含安装步骤、兼容范围、测试统计、评价、路线图或尚未发布的 main 改动。
- 发布说明保存为 `<tag>.md`。调整标题或说明时，不移动标签、不替换附件、不改变发布状态。

- Tags use `vMAJOR.MINOR.PATCH`, with `-alpha.N`, `-beta.N`, or `-rc.N` for prereleases. Titles use `Codex Agent Tree <tag>` without feature subtitles.
- Assets use `codex-agent-tree-<version>.zip` and the matching `.zip.sha256`, without `v` in the filename version.
- Notes contain Chinese followed by English, with matching meaning and bullet order. Use Added, Changed, Fixed, and Removed categories; omit empty categories.
- Include only changes contained in that tag. Exclude installation steps, compatibility statements, test statistics, evaluations, roadmaps, and unreleased main changes.
- Store notes as `<tag>.md`. Editing titles or notes must preserve tags, assets, and release status.

```sh
gh release edit "$TAG" --title "Codex Agent Tree $TAG" --notes-file "docs/releases/$TAG.md"
```
