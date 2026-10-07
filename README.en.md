# Codex Cockpit

Keep your remaining quota, daily usage and estimated costs in one small window.

[Official website](https://codex-cockpit.pages.dev/) · [Bilibili video](https://www.bilibili.com/video/BV1SXbv6REWz/) · [Download](https://github.com/HouSiyuan2001/codex-cockpit/releases) · [中文](README.md)

Codex Cockpit is a companion app for Mac and Windows. A floating widget stays out of the way while you work. Open it to check your quota, explore usage and plan the rest of your day.

This is an independent community project, not an OpenAI product.

Prefer a video? Watch the creator's Bilibili video, [我榨干了Codex](https://www.bilibili.com/video/BV1SXbv6REWz/) (in Chinese).

## Let Codex help you

Send your Codex this prompt:

```text
Help me install Codex Cockpit: https://github.com/HouSiyuan2001/codex-cockpit
Read skills/codex-cockpit/SKILL.md first. Choose the Release package for my
system, verify it, and help me install it. Keep my settings; do not deploy
a server or disable system security protections.
```

The repository includes an [installation and troubleshooting skill](skills/codex-cockpit/SKILL.md), a [Cloudflare skill](skills/cloudflare-sync/SKILL.md), and a [code and troubleshooting map](skills/codex-cockpit/references/repository-map.md). The guides are written in Chinese; Codex can use them while responding in your language.

For repeated use, ask `$skill-installer` to install `skills/codex-cockpit` from `HouSiyuan2001/codex-cockpit`. See [setup and support prompts](docs/CODEX-HELP.md). Repository access is still required while it is private. Installing a skill does not install the app or deploy a server.

## What can I do with it?

- **Check what's left.** See your remaining weekly quota, reset time and daily plan together.
- **See where usage goes.** Explore tokens and estimated costs by task, model or member. Browse history with charts and a calendar heatmap.
- **Add up a few tasks.** Select the tasks you want to include and copy a receipt-style PNG, set in Smiley Sans.
- **Bring several computers together.** Combine Mac and Windows usage in a shared space. Choose your own member names, colors and device assignments.
- **Find a comfortable pace.** Record how your daily usage feels and use plans and reminders to adjust it.

Visit the [official website](https://codex-cockpit.pages.dev/) for feature introductions and a look at the interface. Its interactive previews use sample data, not your account's usage. The desktop app may look different as it evolves.

## Install

Open [Releases](https://github.com/HouSiyuan2001/codex-cockpit/releases) and choose the package for your computer:

| Computer | Package |
| --- | --- |
| Mac, Apple Silicon or Intel | The file ending in `universal.dmg` |
| Windows, x64 | The file ending in `x64-setup.exe` |

You can start with local usage tracking. You do not need a server before opening the app. Set up sync later if you want to share data.

This is a beta. New builds check for signed updates in Settings and ask before restarting to install. If the repository or Release is private, use your own authorized GitHub account to download manually; never put a GitHub token in the app. Older builds need one manual upgrade first. Source on main is not proof that a matching installer has been released. See [update details](docs/AUTO-UPDATE.md).

**Before installing:** the Mac build is not Apple-notarized, and the Windows installer has no publisher signature. Your system may warn that it cannot identify the developer. Check the download source and the release checksums; do not turn off system protection to install the app.

## Use it alone or together

**One computer:** no Cloudflare account or server is needed.

**Several computers or people:** one person deploys the sync service in their own Cloudflare account, creates a shared space and invites the other devices. Each member does not need their own server.

A member is simply the person whose usage a device counts toward. Each device belongs to one member, and a member can have several devices. Names, colors and assignments are yours to choose. Joined devices can edit the shared member settings.

Follow the [self-hosting guide](skills/cloudflare-sync/references/self-hosting.md), or give the included [Cloudflare deployment Skill](skills/cloudflare-sync/SKILL.md) to your coding assistant.

Only the team's administrator deploys into their own Cloudflare account and manages permissions, backups and costs. Invited users need only that administrator's server URL and invitation, not another server or space. This project does not offer public sync hosting; the service is for small trusted groups, not open-registration SaaS. See the [product manual (Chinese)](docs/USER-GUIDE.md) and [operator maintenance guide](skills/cloudflare-sync/references/maintenance.md).

Sync shares usage records, not Codex login access. Joining a space does not give someone access to another person's account.

## A few things to know

- **Costs are estimates, not provider bills.** Missing prices or incomplete history stay visible rather than being counted as zero.
- **Local use works without sync.** No developer-owned private sync server or member list is built in. Sharing task and project names is off by default.
- **Check who can see shared data.** Space members and the server operator can read it; this is not end-to-end encrypted. Keep credentials out of chats, screenshots and repositories.
- **Plans and reset warnings are guidance.** The app cannot change provider limits or guarantee a reset.

See [privacy details](PRIVACY.md) and the [current release notes](docs/RELEASE.md).

## Work on the code

The UI uses React / TypeScript, the desktop layer uses Tauri / Rust, and the optional sync service uses Cloudflare Workers + D1.

You will need Node.js 24+, Rust stable and the [Tauri prerequisites for your platform](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run tauri dev
```

Run tests with `npm test`; build an installer with `npm run tauri build`.

See the [development guide](docs/DESKTOP-DEVELOPMENT-SOP.md), [test checklist](docs/TEST-MATRIX.md) and [release process](docs/RELEASING.md). Browser previews use fictional data and do not replace desktop testing.

## Buy Dice a coffee ☕

If Cockpit has been helpful, you're welcome to buy Dice (骰子) a coffee. Thank you for your support! Donations are entirely optional and do not affect access to any features.

<a href="assets/support/dice-coffee.png"><img src="assets/support/dice-coffee.png" alt="Alipay QR code to buy Dice a coffee" width="640"></a>

## Thanks and license

Built on [Quota Float](https://github.com/silverlion2/quota-float), with source released under the [MIT license](LICENSE). Thanks to the upstream project and the maintainers of our dependencies.

[Smiley Sans](https://github.com/atelier-anchor/smiley-sans) is licensed under OFL-1.1. See [third-party notices](THIRD_PARTY_NOTICES.md).
