# Persona templates

`template.zh.md` and `template.en.md` are public, generic starting points. `/tg config` copies the one you pick to an ignored `personas/<id>.local.md`; for more bots, copy a template yourself and point `persona_path` at the copy.

中文：`template.zh.md` / `template.en.md` 是公开模板。`/tg config` 会把所选模板复制成被 Git 忽略的 `personas/<id>.local.md`；添加更多 bot 时自己复制一份并让 `persona_path` 指向它。

Every other `personas/*.md` file is ignored by Git, because real personas may contain private identity or relationship details. Never commit one.
