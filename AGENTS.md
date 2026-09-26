# Quota Float desktop instructions

Quota Float is a Tauri desktop application, not a website deployment project.

- Read `docs/DESKTOP-DEVELOPMENT-SOP.md` before implementation, testing, packaging, or release work.
- Use the desktop SOP's fast handoff and release gates.
- Do not adopt or run the website SOP unless the task specifically concerns a separately deployed website.
- Preserve the local-first credential boundary: provider access stays read-only and inside `src-tauri`.
- Treat commit, push, tag, release, signing, and external submission as separate authorization boundaries.
