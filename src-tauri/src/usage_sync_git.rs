//! Bounded Git transport for app-owned usage snapshot checkouts.
//!
//! This module deliberately does not use Tokei's own checkout. Production remotes are
//! restricted to credential-free GitHub/Gitee SSH URLs, and every write is scoped to
//! `cockpit/<device>.json`.

use serde::Serialize;
use serde_json::Value;
use std::{
    ffi::OsString,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_COMMAND_OUTPUT: usize = 8 * 1024 * 1024 + 1;
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_PENDING_COMMITS: u64 = 8;
const AUTHOR_NAME: &str = "Quota Float";
const AUTHOR_EMAIL: &str = "local@localhost";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReceipt {
    pub commit: String,
    pub pushed: bool,
}

#[derive(Clone, Copy)]
enum Transport {
    Production,
    #[cfg(test)]
    LocalFixture,
}

struct GitOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    overflowed: bool,
}

/// Clone or narrowly fetch and fast-forward an app-owned checkout.
#[allow(dead_code)]
pub fn prepare(repo: &Path, remote: &str, branch: &str) -> Result<(), String> {
    prepare_with(repo, remote, branch, Transport::Production)
}

/// Prepare a checkout while preserving a recoverable pending snapshot for this device.
///
/// Unlike [`prepare`], this accepts only app-authored commits and worktree changes that
/// affect the device's own namespaced file. A peer-only remote advance is fast-forwarded;
/// if a failed push already created local commits, a verified disjoint merge preserves
/// both histories. The same snapshot path changing on both sides is never auto-resolved.
pub fn prepare_for_device(
    repo: &Path,
    remote: &str,
    branch: &str,
    device_id: &str,
) -> Result<(), String> {
    prepare_for_device_with(repo, remote, branch, device_id, Transport::Production)
}

/// Read the committed namespaced snapshot after [`prepare`].
#[allow(dead_code)]
pub fn read_remote_snapshot(repo: &Path, device_id: &str) -> Result<Option<Vec<u8>>, String> {
    validate_repo_path(repo)?;
    validate_device_id(device_id)?;
    ensure_repository(repo)?;
    validate_local_config(repo)?;
    validate_cockpit_paths(repo, device_id)?;

    let object = format!("HEAD:{}", snapshot_relative(device_id));
    let exists = run_git(
        repo,
        ["cat-file", "-e", object.as_str()],
        Transport::Production,
    )?;
    if !exists.status.success() {
        return Ok(None);
    }
    let output = run_git(repo, ["show", object.as_str()], Transport::Production)?;
    if !output.status.success() || output.overflowed || output.stdout.len() > MAX_SNAPSHOT_BYTES {
        return Err("snapshot_unavailable".into());
    }
    validate_payload(device_id, &output.stdout)?;
    Ok(Some(output.stdout))
}

/// Publish one device snapshot without staging or rewriting any other path.
pub fn publish(
    repo: &Path,
    remote: &str,
    branch: &str,
    device_id: &str,
    payload: &[u8],
) -> Result<SyncReceipt, String> {
    publish_with(
        repo,
        remote,
        branch,
        device_id,
        payload,
        Transport::Production,
    )
}

fn prepare_with(
    repo: &Path,
    remote: &str,
    branch: &str,
    transport: Transport,
) -> Result<(), String> {
    validate_repo_path(repo)?;
    validate_branch(branch)?;
    validate_remote(remote, transport)?;

    if !repo.join(".git").exists() {
        ensure_clone_destination(repo)?;
        let repo_arg = repo.as_os_str().to_owned();
        let args = vec![
            OsString::from("clone"),
            OsString::from("--quiet"),
            OsString::from("--no-checkout"),
            OsString::from("--no-tags"),
            OsString::from("--single-branch"),
            OsString::from("--branch"),
            OsString::from(branch),
            OsString::from("--origin"),
            OsString::from("origin"),
            OsString::from("--"),
            OsString::from(remote),
            repo_arg,
        ];
        let cloned = run_git_args(None, &args, transport)?;
        if !cloned.status.success() {
            return Err("sync_clone_failed".into());
        }
        // A failed validation intentionally leaves the clone directory for inspection.
        ensure_repository(repo)?;
        validate_local_config(repo)?;
        validate_checkout(repo, remote, branch, transport)?;
        validate_remote_tree(repo, branch, None, transport)?;
        let indexed = run_git(repo, ["read-tree", "HEAD"], transport)?;
        if !indexed.status.success() {
            return Err("sync_checkout_failed".into());
        }
        let checked_out = run_git(repo, ["checkout-index", "--all"], transport)?;
        if !checked_out.status.success() {
            return Err("sync_checkout_failed".into());
        }
        validate_cockpit_root(repo)?;
        return Ok(());
    }

    ensure_repository(repo)?;
    validate_local_config(repo)?;
    validate_checkout(repo, remote, branch, transport)?;
    ensure_clean(repo, None, transport)?;
    fetch_branch(repo, remote, branch, transport)?;
    validate_remote_tree(repo, branch, None, transport)?;

    match compare_heads(repo, branch, transport)? {
        HeadRelation::Equal => {}
        HeadRelation::RemoteAhead => {
            let remote_ref = remote_ref(branch);
            let merged = run_git(
                repo,
                ["merge", "--ff-only", "--no-edit", remote_ref.as_str()],
                transport,
            )?;
            if !merged.status.success() {
                return Err("non_fast_forward".into());
            }
        }
        HeadRelation::LocalAhead => return Err("pending_publish".into()),
        HeadRelation::Diverged => return Err("non_fast_forward".into()),
    }
    validate_cockpit_root(repo)?;
    Ok(())
}

fn prepare_for_device_with(
    repo: &Path,
    remote: &str,
    branch: &str,
    device_id: &str,
    transport: Transport,
) -> Result<(), String> {
    validate_device_id(device_id)?;
    if !repo.join(".git").exists() {
        return prepare_with(repo, remote, branch, transport);
    }
    validate_repo_path(repo)?;
    validate_remote(remote, transport)?;
    validate_branch(branch)?;
    ensure_repository(repo)?;
    validate_local_config(repo)?;
    validate_checkout(repo, remote, branch, transport)?;
    validate_cockpit_paths(repo, device_id)?;
    let relative = snapshot_relative(device_id);
    ensure_clean(repo, Some(&relative), transport)?;
    fetch_branch(repo, remote, branch, transport)?;
    validate_remote_tree(repo, branch, Some(device_id), transport)?;

    match compare_heads(repo, branch, transport)? {
        HeadRelation::Equal => {}
        HeadRelation::RemoteAhead => {
            ensure_remote_did_not_change_target(repo, branch, &relative, transport)?;
            fast_forward(repo, branch, transport)?;
        }
        HeadRelation::LocalAhead => {
            validate_pending_commits(repo, branch, &relative, transport)?;
        }
        HeadRelation::Diverged => {
            validate_pending_commits(repo, branch, &relative, transport)?;
            ensure_remote_did_not_change_target(repo, branch, &relative, transport)?;
            merge_disjoint_pending(repo, branch, &relative, transport)?;
        }
    }
    validate_cockpit_paths(repo, device_id)?;
    ensure_clean(repo, Some(&relative), transport)?;
    Ok(())
}

fn publish_with(
    repo: &Path,
    remote: &str,
    branch: &str,
    device_id: &str,
    payload: &[u8],
    transport: Transport,
) -> Result<SyncReceipt, String> {
    validate_repo_path(repo)?;
    validate_remote(remote, transport)?;
    validate_branch(branch)?;
    validate_device_id(device_id)?;
    validate_payload(device_id, payload)?;
    ensure_repository(repo)?;
    validate_local_config(repo)?;
    validate_checkout(repo, remote, branch, transport)?;
    validate_cockpit_paths(repo, device_id)?;

    let relative = snapshot_relative(device_id);
    // A prior failed attempt may leave only this device's file dirty or staged. No
    // other worktree/index change is ever adopted.
    ensure_clean(repo, Some(&relative), transport)?;
    write_pending_snapshot(repo, device_id, payload)?;
    ensure_clean(repo, Some(&relative), transport)?;

    // Fetch after persisting the pending payload. If another device published since
    // prepare(), the caller gets a safe failure and the local payload remains.
    fetch_branch(repo, remote, branch, transport)?;
    validate_remote_tree(repo, branch, Some(device_id), transport)?;
    let relation = compare_heads(repo, branch, transport)?;
    match relation {
        HeadRelation::RemoteAhead | HeadRelation::Diverged => return Err("remote_changed".into()),
        HeadRelation::LocalAhead => {
            validate_pending_commits(repo, branch, &relative, transport)?;
        }
        HeadRelation::Equal => {}
    }

    let added = run_git(repo, ["add", "--", relative.as_str()], transport)?;
    if !added.status.success() {
        return Err("snapshot_stage_failed".into());
    }
    ensure_index_scoped(repo, &relative, transport)?;

    let staged = run_git(repo, ["diff", "--cached", "--quiet", "--"], transport)?;
    if !staged.status.success() {
        let committed = run_git(
            repo,
            [
                "commit",
                "--quiet",
                "--no-verify",
                "--no-gpg-sign",
                "-m",
                "Update Codex Cockpit device snapshot",
            ],
            transport,
        )?;
        if !committed.status.success() {
            return Err("snapshot_commit_failed".into());
        }
    }

    let commit = head_commit(repo, transport)?;
    let after_commit = compare_heads(repo, branch, transport)?;
    if matches!(after_commit, HeadRelation::Equal) {
        return Ok(SyncReceipt {
            commit,
            pushed: false,
        });
    }
    if !matches!(after_commit, HeadRelation::LocalAhead) {
        return Err("remote_changed".into());
    }
    validate_pending_commits(repo, branch, &relative, transport)?;

    let destination = format!("HEAD:refs/heads/{branch}");
    let pushed = run_git(
        repo,
        [
            "push",
            "--quiet",
            "--no-verify",
            "--porcelain",
            "--",
            remote,
            destination.as_str(),
        ],
        transport,
    )?;
    if !pushed.status.success() {
        return Err("sync_push_failed_pending".into());
    }
    Ok(SyncReceipt {
        commit,
        pushed: true,
    })
}

fn validate_repo_path(repo: &Path) -> Result<(), String> {
    if !repo.is_absolute() {
        return Err("unsafe_repo_path".into());
    }
    for component in repo.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("unsafe_repo_path".into());
        }
    }
    ensure_no_symlink_components(repo)?;
    if let Some(home) = dirs::home_dir() {
        let forbidden = home.join(".tokei").join("sync");
        if repo.starts_with(&forbidden) {
            return Err("reserved_tokei_checkout".into());
        }
        if repo.exists() && forbidden.exists() {
            if let (Ok(actual), Ok(reserved)) = (repo.canonicalize(), forbidden.canonicalize()) {
                if actual.starts_with(reserved) {
                    return Err("reserved_tokei_checkout".into());
                }
            }
        }
    }
    Ok(())
}

fn ensure_no_symlink_components(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return Err("unsafe_repo_path".into()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err("repo_unavailable".into()),
        }
    }
    Ok(())
}

fn ensure_clone_destination(repo: &Path) -> Result<(), String> {
    if repo.exists() {
        let meta = fs::symlink_metadata(repo).map_err(|_| "repo_unavailable")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("unsafe_repo_path".into());
        }
        let mut entries = fs::read_dir(repo).map_err(|_| "repo_unavailable")?;
        if entries.next().is_some() {
            return Err("clone_destination_not_empty".into());
        }
    } else {
        let parent = repo
            .parent()
            .ok_or_else(|| "unsafe_repo_path".to_string())?;
        let meta = fs::metadata(parent).map_err(|_| "repo_parent_unavailable")?;
        if !meta.is_dir() {
            return Err("repo_parent_unavailable".into());
        }
    }
    Ok(())
}

fn ensure_repository(repo: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(repo).map_err(|_| "repo_unavailable")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("unsafe_repo_path".into());
    }
    let git_dir = repo.join(".git");
    let git_meta = fs::symlink_metadata(&git_dir).map_err(|_| "invalid_repository")?;
    if !git_meta.is_dir() || git_meta.file_type().is_symlink() {
        return Err("invalid_repository".into());
    }
    let config = git_dir.join("config");
    let config_meta = fs::symlink_metadata(config).map_err(|_| "invalid_repository")?;
    if !config_meta.is_file()
        || config_meta.file_type().is_symlink()
        || config_meta.len() > MAX_CONFIG_BYTES
    {
        return Err("invalid_repository".into());
    }
    let top = run_git(
        repo,
        ["rev-parse", "--show-toplevel"],
        Transport::Production,
    )?;
    let top = output_path(&top).ok_or_else(|| "invalid_repository".to_string())?;
    let actual_repo = repo.canonicalize().map_err(|_| "invalid_repository")?;
    if top.canonicalize().ok().as_ref() != Some(&actual_repo) {
        return Err("invalid_repository".into());
    }
    let resolved_git = run_git(
        repo,
        ["rev-parse", "--absolute-git-dir"],
        Transport::Production,
    )?;
    let resolved_git =
        output_path(&resolved_git).ok_or_else(|| "invalid_repository".to_string())?;
    let expected_git = git_dir.canonicalize().map_err(|_| "invalid_repository")?;
    if resolved_git.canonicalize().ok().as_ref() != Some(&expected_git) {
        return Err("invalid_repository".into());
    }
    Ok(())
}

fn output_path(output: &GitOutput) -> Option<PathBuf> {
    if !output.status.success() || output.overflowed {
        return None;
    }
    let value = std::str::from_utf8(&output.stdout).ok()?.trim();
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

fn validate_remote(remote: &str, transport: Transport) -> Result<(), String> {
    match transport {
        Transport::Production => {
            let rest = remote
                .strip_prefix("git@github.com:")
                .or_else(|| remote.strip_prefix("git@gitee.com:"))
                .ok_or_else(|| "invalid_remote".to_string())?;
            let rest = rest
                .strip_suffix(".git")
                .ok_or_else(|| "invalid_remote".to_string())?;
            let mut parts = rest.split('/');
            let owner = parts.next().unwrap_or_default();
            let name = parts.next().unwrap_or_default();
            if parts.next().is_some()
                || !safe_remote_component(owner)
                || !safe_remote_component(name)
            {
                return Err("invalid_remote".into());
            }
        }
        #[cfg(test)]
        Transport::LocalFixture => {
            let path = Path::new(remote);
            if !path.is_absolute() {
                return Err("invalid_remote".into());
            }
            ensure_no_symlink_components(path).map_err(|_| "invalid_remote".to_string())?;
        }
    }
    Ok(())
}

fn safe_remote_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn validate_branch(branch: &str) -> Result<(), String> {
    if branch.is_empty()
        || branch.len() > 128
        || branch.starts_with(['-', '.', '/'])
        || branch.ends_with(['.', '/'])
        || branch.contains("..")
        || branch.contains("@{")
        || branch.contains("//")
        || branch.contains("\\")
        || branch.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || part.ends_with('.')
                || part.ends_with(".lock")
        })
        || !branch
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
    {
        return Err("invalid_branch".into());
    }
    Ok(())
}

fn validate_device_id(device_id: &str) -> Result<(), String> {
    if device_id.is_empty()
        || device_id.len() > 128
        || device_id == "."
        || device_id == ".."
        || device_id.starts_with('.')
        || device_id.ends_with('.')
        || !device_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err("invalid_device_id".into());
    }
    Ok(())
}

fn validate_payload(device_id: &str, payload: &[u8]) -> Result<(), String> {
    if payload.is_empty() || payload.len() > MAX_SNAPSHOT_BYTES {
        return Err("invalid_snapshot".into());
    }
    let value: Value = serde_json::from_slice(payload).map_err(|_| "invalid_snapshot")?;
    if !value.is_object() || value.get("_device").and_then(Value::as_str) != Some(device_id) {
        return Err("snapshot_identity_mismatch".into());
    }
    Ok(())
}

fn snapshot_relative(device_id: &str) -> String {
    format!("cockpit/{device_id}.json")
}

fn validate_cockpit_root(repo: &Path) -> Result<(), String> {
    let cockpit = repo.join("cockpit");
    match fs::symlink_metadata(cockpit) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            Err("unsafe_cockpit_path".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("repo_unavailable".into()),
    }
}

fn validate_cockpit_paths(repo: &Path, device_id: &str) -> Result<(), String> {
    validate_cockpit_root(repo)?;
    let target = repo.join(snapshot_relative(device_id));
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            Err("unsafe_cockpit_path".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("repo_unavailable".into()),
    }
}

fn validate_local_config(repo: &Path) -> Result<(), String> {
    let output = run_git(
        repo,
        [
            "config",
            "--local",
            "--no-includes",
            "--null",
            "--name-only",
            "--list",
        ],
        Transport::Production,
    )?;
    if !output.status.success() || output.overflowed {
        return Err("invalid_repository_config".into());
    }
    for raw in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
    {
        let key = String::from_utf8_lossy(raw).to_ascii_lowercase();
        let forbidden = key == "core.hookspath"
            || key == "core.sshcommand"
            || key == "core.fsmonitor"
            || key == "core.worktree"
            || key == "core.attributesfile"
            || key == "extensions.worktreeconfig"
            || key.starts_with("include.")
            || key.starts_with("includeif.")
            || key.starts_with("credential.")
            || key.starts_with("filter.")
            || (key.starts_with("merge.") && key.ends_with(".driver"))
            || key.starts_with("url.")
            || key.starts_with("protocol.")
            || key.starts_with("submodule.")
            || (key.starts_with("diff.") && key.ends_with(".textconv"))
            || key.ends_with(".uploadpack")
            || key.ends_with(".receivepack")
            || key.ends_with(".pushurl");
        if forbidden {
            return Err("unsafe_repository_config".into());
        }
    }
    Ok(())
}

fn validate_checkout(
    repo: &Path,
    remote: &str,
    branch: &str,
    transport: Transport,
) -> Result<(), String> {
    let origin = run_git(
        repo,
        ["config", "--get-all", "remote.origin.url"],
        transport,
    )?;
    if !origin.status.success()
        || origin.overflowed
        || origin.stdout != format!("{remote}\n").as_bytes()
    {
        return Err("unexpected_remote".into());
    }
    let current = run_git(
        repo,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        transport,
    )?;
    if !current.status.success()
        || current.overflowed
        || current.stdout != format!("{branch}\n").as_bytes()
    {
        return Err("unexpected_branch".into());
    }
    let branch_remote = format!("branch.{branch}.remote");
    let configured_remote = run_git(repo, ["config", "--get", branch_remote.as_str()], transport)?;
    let branch_merge = format!("branch.{branch}.merge");
    let configured_merge = run_git(repo, ["config", "--get", branch_merge.as_str()], transport)?;
    if configured_remote.stdout != b"origin\n"
        || configured_merge.stdout != format!("refs/heads/{branch}\n").as_bytes()
    {
        return Err("unexpected_branch".into());
    }
    Ok(())
}

fn fetch_branch(
    repo: &Path,
    remote: &str,
    branch: &str,
    transport: Transport,
) -> Result<(), String> {
    let refspec = format!("refs/heads/{branch}:{}", remote_ref(branch));
    let fetched = run_git(
        repo,
        [
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            "--",
            remote,
            refspec.as_str(),
        ],
        transport,
    )?;
    if !fetched.status.success() {
        return Err("sync_fetch_failed".into());
    }
    Ok(())
}

fn remote_ref(branch: &str) -> String {
    format!("refs/remotes/origin/{branch}")
}

enum HeadRelation {
    Equal,
    LocalAhead,
    RemoteAhead,
    Diverged,
}

fn fast_forward(repo: &Path, branch: &str, transport: Transport) -> Result<(), String> {
    let remote = remote_ref(branch);
    let merged = run_git(
        repo,
        ["merge", "--ff-only", "--no-edit", remote.as_str()],
        transport,
    )?;
    if !merged.status.success() {
        return Err("non_fast_forward".into());
    }
    Ok(())
}

fn merge_base(repo: &Path, branch: &str, transport: Transport) -> Result<String, String> {
    let remote = remote_ref(branch);
    let output = run_git(repo, ["merge-base", "HEAD", remote.as_str()], transport)?;
    if !output.status.success() || output.overflowed {
        return Err("repository_state_unavailable".into());
    }
    parse_commit(&output.stdout)
}

fn ensure_remote_did_not_change_target(
    repo: &Path,
    branch: &str,
    relative: &str,
    transport: Transport,
) -> Result<(), String> {
    let base = merge_base(repo, branch, transport)?;
    let range = format!("{base}..{}", remote_ref(branch));
    let paths = run_git(
        repo,
        ["diff", "--name-only", "-z", range.as_str(), "--"],
        transport,
    )?;
    if !paths.status.success() || paths.overflowed {
        return Err("repository_state_unavailable".into());
    }
    if paths
        .stdout
        .split(|byte| *byte == 0)
        .any(|path| path == relative.as_bytes())
    {
        return Err("snapshot_conflict".into());
    }
    Ok(())
}

fn merge_disjoint_pending(
    repo: &Path,
    branch: &str,
    relative: &str,
    transport: Transport,
) -> Result<(), String> {
    let local_before = head_commit(repo, transport)?;
    let remote = remote_ref(branch);
    let remote_before = rev_parse(repo, &remote, transport)?;
    let merged = run_git(
        repo,
        ["merge", "--no-edit", "--no-ff", remote.as_str()],
        transport,
    )?;
    if !merged.status.success() {
        return Err("sync_merge_failed_pending".into());
    }
    let parents = run_git(
        repo,
        ["rev-list", "--parents", "-n", "1", "HEAD"],
        transport,
    )?;
    if !parents.status.success() || parents.overflowed {
        return Err("unexpected_merge_commit".into());
    }
    let fields: Vec<_> = String::from_utf8_lossy(&parents.stdout)
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    if fields.len() != 3 || fields[1] != local_before || fields[2] != remote_before {
        return Err("unexpected_merge_commit".into());
    }
    // Audit from the peer tip: everything newly introduced by our side, including
    // the merge result, must still be confined to this device snapshot.
    validate_pending_commits(repo, branch, relative, transport)?;
    Ok(())
}

fn compare_heads(repo: &Path, branch: &str, transport: Transport) -> Result<HeadRelation, String> {
    let remote = remote_ref(branch);
    let range = format!("HEAD...{remote}");
    let counts = run_git(
        repo,
        ["rev-list", "--left-right", "--count", range.as_str()],
        transport,
    )?;
    if !counts.status.success() || counts.overflowed {
        return Err("repository_state_unavailable".into());
    }
    let text = std::str::from_utf8(&counts.stdout).map_err(|_| "repository_state_unavailable")?;
    let mut parts = text.split_whitespace();
    let local: u64 = parts
        .next()
        .ok_or_else(|| "repository_state_unavailable".to_string())?
        .parse()
        .map_err(|_| "repository_state_unavailable")?;
    let remote: u64 = parts
        .next()
        .ok_or_else(|| "repository_state_unavailable".to_string())?
        .parse()
        .map_err(|_| "repository_state_unavailable")?;
    if parts.next().is_some() {
        return Err("repository_state_unavailable".into());
    }
    Ok(match (local, remote) {
        (0, 0) => HeadRelation::Equal,
        (_, 0) => HeadRelation::LocalAhead,
        (0, _) => HeadRelation::RemoteAhead,
        (_, _) => HeadRelation::Diverged,
    })
}

fn ensure_clean(repo: &Path, allowed: Option<&str>, transport: Transport) -> Result<(), String> {
    let status = run_git(
        repo,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        transport,
    )?;
    if !status.status.success() || status.overflowed {
        return Err("repository_state_unavailable".into());
    }
    for record in status
        .stdout
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
    {
        if record.len() < 4 || record[2] != b' ' {
            return Err("unexpected_dirty_state".into());
        }
        let state = &record[..2];
        let path = &record[3..];
        let recoverable_target_state =
            matches!(state, b"??" | b" M" | b"M " | b"MM" | b"A " | b"AM");
        if !recoverable_target_state || allowed.is_none_or(|expected| path != expected.as_bytes()) {
            return Err("unexpected_dirty_state".into());
        }
    }
    Ok(())
}

fn ensure_index_scoped(repo: &Path, relative: &str, transport: Transport) -> Result<(), String> {
    let index = run_git(
        repo,
        ["diff", "--cached", "--name-only", "-z", "--"],
        transport,
    )?;
    if !index.status.success() || index.overflowed {
        return Err("repository_state_unavailable".into());
    }
    let mut paths = index
        .stdout
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty());
    if paths.next().is_some_and(|path| path != relative.as_bytes()) || paths.next().is_some() {
        return Err("unexpected_staged_state".into());
    }
    Ok(())
}

fn validate_pending_commits(
    repo: &Path,
    branch: &str,
    relative: &str,
    transport: Transport,
) -> Result<(), String> {
    let range = format!("{}..HEAD", remote_ref(branch));
    let revisions = run_git(repo, ["rev-list", "--reverse", range.as_str()], transport)?;
    if !revisions.status.success() || revisions.overflowed {
        return Err("unexpected_local_commit_list".into());
    }
    let commits: Vec<_> = String::from_utf8_lossy(&revisions.stdout)
        .lines()
        .map(str::to_owned)
        .collect();
    if commits.is_empty() || commits.len() as u64 > MAX_PENDING_COMMITS {
        return Err("unexpected_local_commit_count".into());
    }
    let expected_identity =
        format!("{AUTHOR_NAME}\x1f{AUTHOR_EMAIL}\x1f{AUTHOR_NAME}\x1f{AUTHOR_EMAIL}\n");
    for commit in &commits {
        if parse_commit(commit.as_bytes()).is_err() {
            return Err("unexpected_local_commit_id".into());
        }
        let identity = run_git(
            repo,
            [
                "show",
                "--quiet",
                "--format=%an%x1f%ae%x1f%cn%x1f%ce",
                commit.as_str(),
            ],
            transport,
        )?;
        if !identity.status.success()
            || identity.overflowed
            || identity.stdout != expected_identity.as_bytes()
        {
            return Err("unexpected_local_commit_identity".into());
        }
        validate_commit_scope(repo, branch, commit, relative, transport)?;
    }
    Ok(())
}

fn validate_commit_scope(
    repo: &Path,
    branch: &str,
    commit: &str,
    relative: &str,
    transport: Transport,
) -> Result<(), String> {
    let parent_line = run_git(
        repo,
        ["rev-list", "--parents", "-n", "1", commit],
        transport,
    )?;
    if !parent_line.status.success() || parent_line.overflowed {
        return Err("unexpected_local_commit_parents".into());
    }
    let fields: Vec<_> = String::from_utf8_lossy(&parent_line.stdout)
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let comparison_parent = match fields.as_slice() {
        [actual, parent] if actual == commit => parent.as_str(),
        [actual, _local_parent, peer_parent] if actual == commit => {
            let remote = remote_ref(branch);
            let ancestor = run_git(
                repo,
                [
                    "merge-base",
                    "--is-ancestor",
                    peer_parent.as_str(),
                    remote.as_str(),
                ],
                transport,
            )?;
            if !ancestor.status.success() {
                return Err("unexpected_local_merge_parent".into());
            }
            peer_parent.as_str()
        }
        _ => return Err("unexpected_local_commit_parents".into()),
    };
    let range = format!("{comparison_parent}..{commit}");
    let paths = run_git(
        repo,
        ["diff", "--name-only", "-z", range.as_str(), "--"],
        transport,
    )?;
    if !paths.status.success() || paths.overflowed {
        return Err("unexpected_local_commit_paths".into());
    }
    let mut changed = paths
        .stdout
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty());
    if changed.next() != Some(relative.as_bytes()) || changed.next().is_some() {
        return Err("unexpected_local_commit_scope".into());
    }
    Ok(())
}

fn validate_remote_tree(
    repo: &Path,
    branch: &str,
    device_id: Option<&str>,
    transport: Transport,
) -> Result<(), String> {
    let tree = remote_ref(branch);
    validate_tree_entry(repo, &tree, "cockpit", true, transport)?;
    if let Some(device_id) = device_id {
        validate_tree_entry(repo, &tree, &snapshot_relative(device_id), false, transport)?;
    }
    Ok(())
}

fn validate_tree_entry(
    repo: &Path,
    tree: &str,
    path: &str,
    directory: bool,
    transport: Transport,
) -> Result<(), String> {
    let output = run_git(repo, ["ls-tree", "-z", tree, "--", path], transport)?;
    if !output.status.success() || output.overflowed {
        return Err("repository_state_unavailable".into());
    }
    if output.stdout.is_empty() {
        return Ok(());
    }
    let header = output
        .stdout
        .split(|byte| *byte == b'\t')
        .next()
        .unwrap_or_default();
    let mode = header
        .split(|byte| *byte == b' ')
        .next()
        .unwrap_or_default();
    if (directory && mode != b"040000") || (!directory && mode != b"100644" && mode != b"100755") {
        return Err("unsafe_cockpit_path".into());
    }
    Ok(())
}

fn write_pending_snapshot(repo: &Path, device_id: &str, payload: &[u8]) -> Result<(), String> {
    let cockpit = repo.join("cockpit");
    if !cockpit.exists() {
        fs::create_dir(&cockpit).map_err(|_| "snapshot_write_failed")?;
    }
    validate_cockpit_paths(repo, device_id)?;
    let target = repo.join(snapshot_relative(device_id));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(target).map_err(|_| "snapshot_write_failed")?;
    use std::io::Write;
    file.write_all(payload)
        .map_err(|_| "snapshot_write_failed")?;
    file.sync_all().map_err(|_| "snapshot_write_failed")?;
    Ok(())
}

fn head_commit(repo: &Path, transport: Transport) -> Result<String, String> {
    rev_parse(repo, "HEAD", transport)
}

fn rev_parse(repo: &Path, revision: &str, transport: Transport) -> Result<String, String> {
    let output = run_git(repo, ["rev-parse", "--verify", revision], transport)?;
    if !output.status.success() || output.overflowed {
        return Err("repository_state_unavailable".into());
    }
    parse_commit(&output.stdout)
}

fn parse_commit(bytes: &[u8]) -> Result<String, String> {
    let commit = std::str::from_utf8(bytes)
        .map_err(|_| "repository_state_unavailable")?
        .trim();
    if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("repository_state_unavailable".into());
    }
    Ok(commit.to_owned())
}

fn run_git<'a, I>(repo: &Path, args: I, transport: Transport) -> Result<GitOutput, String>
where
    I: IntoIterator<Item = &'a str>,
{
    let args: Vec<OsString> = args.into_iter().map(OsString::from).collect();
    run_git_args(Some(repo), &args, transport)
}

fn git_executable() -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from("git"))
    }
    #[cfg(windows)]
    {
        let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|paths| {
                std::env::split_paths(&paths)
                    .filter(|p| p.is_absolute())
                    .map(|p| p.join("git.exe"))
                    .collect()
            })
            .unwrap_or_default();
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(key) {
                candidates.push(PathBuf::from(root).join("Git/cmd/git.exe"));
            }
        }
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("AppData/Local/Programs/Git/cmd/git.exe"));
            // Optional existing Codex bundled runtime; never download or install a sidecar.
            candidates.push(home.join(
                ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe",
            ));
        }
        candidates
            .into_iter()
            .find(|p| p.is_absolute() && p.is_file())
            .ok_or_else(|| "git_unavailable".into())
    }
}

fn run_git_args(
    repo: Option<&Path>,
    args: &[OsString],
    transport: Transport,
) -> Result<GitOutput, String> {
    let null_config = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let hooks_path = null_config;
    let protocol = match transport {
        Transport::Production => "protocol.ssh.allow=always",
        #[cfg(test)]
        Transport::LocalFixture => "protocol.file.allow=always",
    };
    // Windows Git may use MSYS SSH, where NUL is not a readable config file.
    // Preserve the user's existing key selection, with noninteractive transport
    // and proxy/local-command restrictions still enforced on the command line.
    let config_option = if cfg!(windows) { "" } else { "-F /dev/null " };
    let ssh_command = format!(
        "ssh {config_option}-oBatchMode=yes -oStrictHostKeyChecking=yes -oPasswordAuthentication=no -oKbdInteractiveAuthentication=no -oProxyCommand=none -oProxyJump=none -oPermitLocalCommand=no -oConnectTimeout=10 -oServerAliveInterval=10 -oServerAliveCountMax=2"
    );
    let mut command = Command::new(git_executable()?);
    command
        .arg("-c")
        .arg(format!("core.hooksPath={hooks_path}"))
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("credential.helper=")
        .arg("-c")
        .arg("commit.gpgSign=false")
        .arg("-c")
        .arg("tag.gpgSign=false")
        .arg("-c")
        .arg("protocol.allow=never")
        .arg("-c")
        .arg(protocol)
        .arg("-c")
        .arg("protocol.ext.allow=never")
        .arg("-c")
        .arg("submodule.recurse=false")
        .arg("-c")
        .arg("fetch.recurseSubmodules=false")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", null_config)
        .env("GIT_SSH_COMMAND", ssh_command)
        .env("GIT_SSH_VARIANT", "ssh")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_AUTHOR_NAME", AUTHOR_NAME)
        .env("GIT_AUTHOR_EMAIL", AUTHOR_EMAIL)
        .env("GIT_COMMITTER_NAME", AUTHOR_NAME)
        .env("GIT_COMMITTER_EMAIL", AUTHOR_EMAIL)
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_SYSTEM")
        .env_remove("GIT_CONFIG_KEY_0")
        .env_remove("GIT_CONFIG_VALUE_0")
        .env_remove("GIT_EXEC_PATH")
        .env_remove("GIT_EXTERNAL_DIFF")
        .env_remove("GIT_DIFF_OPTS")
        .env_remove("GIT_PROXY_COMMAND")
        .env_remove("GIT_SSH");
    if let Some(repo) = repo {
        command.current_dir(repo);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let mut child = command.spawn().map_err(|_| "git_unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git_unavailable".to_string())?;
    let (output_tx, output_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = output_tx.send(read_bounded(stdout));
    });
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("git_timeout".into());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("git_failed".into());
            }
        }
    };
    // A spawned SSH/helper process can inherit stdout after Git exits. Never wait
    // unboundedly for that descendant to close the pipe.
    let remaining = deadline.saturating_duration_since(Instant::now());
    let (stdout, overflowed) = output_rx
        .recv_timeout(remaining.min(Duration::from_secs(1)))
        .map_err(|_| "git_output_timeout")?;
    Ok(GitOutput {
        status,
        stdout,
        overflowed,
    })
}

fn read_bounded(mut reader: impl Read) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut overflowed = false;
    let mut buffer = [0_u8; 8192];
    while let Ok(read) = reader.read(&mut buffer) {
        if read == 0 {
            break;
        }
        let available = MAX_COMMAND_OUTPUT.saturating_sub(kept.len());
        let copy = available.min(read);
        kept.extend_from_slice(&buffer[..copy]);
        overflowed |= copy < read;
    }
    (kept, overflowed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        origin: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            // Git for Windows does not accept Rust's verbatim \\?\ paths.
            let root = std::env::temp_dir().join(format!(
                "quota-float-sync-git-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            // macOS temp_dir contains /var -> /private/var. Keep the fixture
            // canonical there, while avoiding Windows verbatim Git paths.
            #[cfg(unix)]
            let root = root.canonicalize().unwrap();
            let origin = root.join("origin.git");
            raw_git(
                None,
                &[
                    "init",
                    "--bare",
                    "--initial-branch=main",
                    origin.to_str().unwrap(),
                ],
            );
            let seed = root.join("seed");
            raw_git(
                None,
                &["init", "--initial-branch=main", seed.to_str().unwrap()],
            );
            fs::write(seed.join("legacy-device.json"), b"legacy bytes\n").unwrap();
            fs::create_dir(seed.join("cockpit")).unwrap();
            fs::write(seed.join("cockpit/device-a.json"), payload("device-a", 1)).unwrap();
            raw_git(
                Some(&seed),
                &["add", "--", "legacy-device.json", "cockpit/device-a.json"],
            );
            raw_git(Some(&seed), &["commit", "-m", "seed"]);
            raw_git(
                Some(&seed),
                &["push", origin.to_str().unwrap(), "main:main"],
            );
            Self { root, origin }
        }

        fn checkout(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }

        fn remote(&self) -> &str {
            self.origin.to_str().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn raw_git(repo: Option<&Path>, args: &[&str]) -> Vec<u8> {
        let mut command = Command::new("git");
        command
            .args(args)
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@localhost")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@localhost")
            .stderr(Stdio::null());
        if let Some(repo) = repo {
            command.current_dir(repo);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "git fixture command failed: {args:?}"
        );
        output.stdout
    }

    fn payload(device: &str, total: u64) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "_device": device,
            "_ts": "2026-09-10T00:00:00Z",
            "_ledger": {"tools": {"codex": {"total_tokens": total}}},
            "codex": {"ranges": {}},
            "_cockpit": {"schema": 1}
        }))
        .unwrap()
    }

    fn test_prepare(repo: &Path, remote: &str) -> Result<(), String> {
        prepare_with(repo, remote, "main", Transport::LocalFixture)
    }

    fn test_prepare_for_device(repo: &Path, remote: &str, device: &str) -> Result<(), String> {
        prepare_for_device_with(repo, remote, "main", device, Transport::LocalFixture)
    }

    fn test_publish(
        repo: &Path,
        remote: &str,
        device: &str,
        bytes: &[u8],
    ) -> Result<SyncReceipt, String> {
        publish_with(repo, remote, "main", device, bytes, Transport::LocalFixture)
    }

    #[test]
    fn clones_reads_and_noops() {
        let fixture = Fixture::new();
        let repo = fixture.checkout("clone");
        test_prepare(&repo, fixture.remote()).unwrap();
        let bytes = run_git(
            &repo,
            ["show", "HEAD:cockpit/device-a.json"],
            Transport::LocalFixture,
        )
        .unwrap()
        .stdout;
        let receipt = test_publish(&repo, fixture.remote(), "device-a", &bytes).unwrap();
        assert!(!receipt.pushed);
        assert_eq!(
            receipt.commit,
            head_commit(&repo, Transport::LocalFixture).unwrap()
        );
    }

    #[test]
    fn publishes_only_namespaced_device_and_preserves_legacy() {
        let fixture = Fixture::new();
        let repo = fixture.checkout("clone");
        test_prepare(&repo, fixture.remote()).unwrap();
        let before = fs::read(repo.join("legacy-device.json")).unwrap();
        let receipt = test_publish(
            &repo,
            fixture.remote(),
            "device-b",
            &payload("device-b", 42),
        )
        .unwrap();
        assert!(receipt.pushed);
        assert_eq!(fs::read(repo.join("legacy-device.json")).unwrap(), before);
        let changed = raw_git(
            Some(&repo),
            &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        );
        assert_eq!(changed, b"cockpit/device-b.json\n");
        let verifier = fixture.checkout("verify");
        test_prepare(&verifier, fixture.remote()).unwrap();
        assert_eq!(
            fs::read(verifier.join("legacy-device.json")).unwrap(),
            b"legacy bytes\n"
        );
        assert_eq!(
            fs::read(verifier.join("cockpit/device-b.json")).unwrap(),
            payload("device-b", 42)
        );
    }

    #[test]
    fn rejects_publicly_unsafe_inputs() {
        let fixture = Fixture::new();
        let repo = fixture.checkout("clone");
        assert_eq!(
            prepare(&repo, fixture.remote(), "main").unwrap_err(),
            "invalid_remote"
        );
        assert_eq!(
            prepare(&repo, "https://github.com/owner/repo.git", "main").unwrap_err(),
            "invalid_remote"
        );
        assert_eq!(
            prepare(&repo, "git@evil.example:owner/repo.git", "main").unwrap_err(),
            "invalid_remote"
        );
        assert_eq!(
            prepare(&repo, "git@github.com:owner/repo.git", "--upload-pack=x").unwrap_err(),
            "invalid_branch"
        );
        assert_eq!(
            validate_device_id("../peer").unwrap_err(),
            "invalid_device_id"
        );
        assert_eq!(
            validate_device_id("peer/name").unwrap_err(),
            "invalid_device_id"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_repo_and_cockpit_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let real = fixture.checkout("real");
        test_prepare(&real, fixture.remote()).unwrap();
        let linked = fixture.checkout("linked");
        symlink(&real, &linked).unwrap();
        assert_eq!(
            test_prepare(&linked, fixture.remote()).unwrap_err(),
            "unsafe_repo_path"
        );

        fs::remove_dir_all(real.join("cockpit")).unwrap();
        symlink(fixture.root.join("outside"), real.join("cockpit")).unwrap();
        assert_eq!(
            test_publish(&real, fixture.remote(), "device-a", &payload("device-a", 2)).unwrap_err(),
            "unsafe_cockpit_path"
        );
    }

    #[test]
    fn rejects_dirty_peer_without_touching_target() {
        let fixture = Fixture::new();
        let repo = fixture.checkout("clone");
        test_prepare(&repo, fixture.remote()).unwrap();
        fs::write(repo.join("legacy-device.json"), b"locally dirty\n").unwrap();
        let target = repo.join("cockpit/device-a.json");
        let before = fs::read(&target).unwrap();
        assert_eq!(
            test_publish(&repo, fixture.remote(), "device-a", &payload("device-a", 2)).unwrap_err(),
            "unexpected_dirty_state"
        );
        assert_eq!(fs::read(target).unwrap(), before);
    }

    #[test]
    fn remote_advance_fails_and_retains_pending_snapshot() {
        let fixture = Fixture::new();
        let first = fixture.checkout("first");
        let second = fixture.checkout("second");
        test_prepare(&first, fixture.remote()).unwrap();
        test_prepare(&second, fixture.remote()).unwrap();

        test_publish(
            &first,
            fixture.remote(),
            "device-a",
            &payload("device-a", 2),
        )
        .unwrap();
        let pending = payload("device-b", 9);
        assert_eq!(
            test_publish(&second, fixture.remote(), "device-b", &pending).unwrap_err(),
            "remote_changed"
        );
        assert_eq!(
            fs::read(second.join("cockpit/device-b.json")).unwrap(),
            pending
        );
        let remote_device_b = Command::new("git")
            .args([
                "--git-dir",
                fixture.remote(),
                "cat-file",
                "-e",
                "main:cockpit/device-b.json",
            ])
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!remote_device_b.success());
    }

    #[cfg(unix)]
    #[test]
    fn full_retry_lifecycle_merges_disjoint_peer_then_pushes() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = Fixture::new();
        let pending_repo = fixture.checkout("pending");
        let peer_repo = fixture.checkout("peer");
        test_prepare_for_device(&pending_repo, fixture.remote(), "device-a").unwrap();
        test_prepare_for_device(&peer_repo, fixture.remote(), "device-b").unwrap();

        let rejecting_hook = fixture.origin.join("hooks/pre-receive");
        fs::write(&rejecting_hook, b"#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(&rejecting_hook, fs::Permissions::from_mode(0o700)).unwrap();
        let pending = payload("device-a", 77);
        assert_eq!(
            test_publish(&pending_repo, fixture.remote(), "device-a", &pending).unwrap_err(),
            "sync_push_failed_pending"
        );
        fs::remove_file(rejecting_hook).unwrap();

        test_publish(
            &peer_repo,
            fixture.remote(),
            "device-b",
            &payload("device-b", 88),
        )
        .unwrap();
        test_prepare_for_device(&pending_repo, fixture.remote(), "device-a").unwrap();
        let parents = raw_git(
            Some(&pending_repo),
            &["rev-list", "--parents", "-n", "1", "HEAD"],
        );
        assert_eq!(
            String::from_utf8_lossy(&parents).split_whitespace().count(),
            3
        );
        let receipt = test_publish(&pending_repo, fixture.remote(), "device-a", &pending).unwrap();
        assert!(receipt.pushed);

        let verifier = fixture.checkout("retry-verify");
        test_prepare(&verifier, fixture.remote()).unwrap();
        assert_eq!(
            fs::read(verifier.join("cockpit/device-a.json")).unwrap(),
            pending
        );
        assert_eq!(
            fs::read(verifier.join("cockpit/device-b.json")).unwrap(),
            payload("device-b", 88)
        );
        assert_eq!(
            fs::read(verifier.join("legacy-device.json")).unwrap(),
            b"legacy bytes\n"
        );
    }

    #[test]
    fn device_prepare_fast_forwards_peer_and_keeps_dirty_snapshot() {
        let fixture = Fixture::new();
        let local = fixture.checkout("local");
        let peer = fixture.checkout("peer");
        test_prepare_for_device(&local, fixture.remote(), "device-a").unwrap();
        test_prepare_for_device(&peer, fixture.remote(), "device-b").unwrap();
        let pending = payload("device-a", 55);
        fs::write(local.join("cockpit/device-a.json"), &pending).unwrap();
        test_publish(
            &peer,
            fixture.remote(),
            "device-b",
            &payload("device-b", 66),
        )
        .unwrap();

        test_prepare_for_device(&local, fixture.remote(), "device-a").unwrap();
        assert_eq!(
            fs::read(local.join("cockpit/device-a.json")).unwrap(),
            pending
        );
        let receipt = test_publish(&local, fixture.remote(), "device-a", &pending).unwrap();
        assert!(receipt.pushed);
    }

    #[test]
    fn device_prepare_rejects_same_snapshot_conflict_and_keeps_pending_bytes() {
        let fixture = Fixture::new();
        let local = fixture.checkout("local-conflict");
        let peer = fixture.checkout("peer-conflict");
        test_prepare_for_device(&local, fixture.remote(), "device-a").unwrap();
        test_prepare_for_device(&peer, fixture.remote(), "device-a").unwrap();
        let pending = payload("device-a", 101);
        fs::write(local.join("cockpit/device-a.json"), &pending).unwrap();
        test_publish(
            &peer,
            fixture.remote(),
            "device-a",
            &payload("device-a", 202),
        )
        .unwrap();

        assert_eq!(
            test_prepare_for_device(&local, fixture.remote(), "device-a").unwrap_err(),
            "snapshot_conflict"
        );
        assert_eq!(
            fs::read(local.join("cockpit/device-a.json")).unwrap(),
            pending
        );
    }

    #[test]
    fn rejects_unexpected_remote_configuration() {
        let fixture = Fixture::new();
        let repo = fixture.checkout("clone");
        test_prepare(&repo, fixture.remote()).unwrap();
        raw_git(
            Some(&repo),
            &["remote", "set-url", "origin", "/tmp/not-the-origin.git"],
        );
        assert_eq!(
            test_prepare(&repo, fixture.remote()).unwrap_err(),
            "unexpected_remote"
        );
    }
}
