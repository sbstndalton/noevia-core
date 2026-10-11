//! Required actual-candidate Node ownership qualification. Rust owns cases and assertions.
mod process;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Command, ExitCode},
    time::Duration,
};
#[derive(Debug)]
enum Failure {
    Infrastructure(String),
    Assertion(String),
}
impl From<String> for Failure {
    fn from(s: String) -> Self {
        Self::Infrastructure(s)
    }
}
impl From<&str> for Failure {
    fn from(s: &str) -> Self {
        Self::Infrastructure(s.into())
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Infrastructure(s) => write!(f, "infrastructure: {s}"),
            Self::Assertion(s) => write!(f, "assertion: {s}"),
        }
    }
}
const ACTOR: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
fn at<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&Value::Null)
}
fn put(v: &mut Value, key: &str, value: Value) -> Result<(), String> {
    v.as_object_mut()
        .ok_or("fixture object missing")?
        .insert(key.into(), value);
    Ok(())
}
fn git(core: &Path, args: &[&str]) -> Result<String, String> {
    let o = Command::new("git")
        .arg("-C")
        .arg(core)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err("candidate Git check failed".into());
    }
    Ok(String::from_utf8_lossy(&o.stdout).trim().into())
}
fn full() -> Value {
    json!({"NOEVIA_FRONT":"rust","NOEVIA_RUST_AUTH":"1","NOEVIA_RUST_AUTH_CONFIRMED":"1","NOEVIA_RUST_ROUTING_MODE":"1","NOEVIA_RUST_ROUTING_MODE_CONFIRMED":"1"})
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn case() -> Value {
    json!({"file":null,"allowed":"[\"cloud\",\"hybrid\"]","feature":"false","env":{},"routeEnv":{},"featureUpdate":null,"directFeature":null,"auditAbort":false,"readError":false,"method":"GET","path":"/api/routing-mode","role":"admin","body":""})
}
fn actual(core: &Path, case: Value) -> Result<Value, Failure> {
    let node = std::env::var("NOEVIA_ORACLE_NODE").unwrap_or_else(|_| "node".into());
    let mut command = Command::new(node);
    command
        .arg(core.join("tools/contract-corpus/serve.cjs"))
        .arg("--routing-mode-oracle");
    let o = process::bounded(
        command,
        process::json_input(&json!({"cases":[case]}))?,
        Duration::from_secs(10),
    )?;
    if !o.status.success() {
        return Err(format!(
            "actual oracle failed: {}",
            String::from_utf8_lossy(&o.stderr)
        )
        .into());
    }
    let v: Value = serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())?;
    v.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or("oracle result missing".into())
}
fn require(ok: bool, msg: &str) -> Result<(), Failure> {
    if ok {
        Ok(())
    } else {
        Err(Failure::Assertion(msg.into()))
    }
}
fn qualify(core: &Path) -> Result<usize, Failure> {
    let mut count = 0;
    for runtime in [false, true] {
        for path in ["/api/routing-mode", "/api/routing-mode/allowed"] {
            for method in [
                "GET", "PUT", "POST", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT",
            ] {
                let mut c = case();
                put(&mut c, "routeEnv", full())?;
                put(&mut c, "runtimeDefaults", json!(runtime))?;
                put(&mut c, "path", json!(path))?;
                put(&mut c, "method", json!(method))?;
                put(&mut c, "feature", json!("true"))?;
                put(
                    &mut c,
                    "body",
                    json!(hex(br#"{"mode":"local","allowed":["local"]}"#)),
                )?;
                let out = actual(core, c)?;
                require(
                    at(at(&out, "response"), "status") == 503
                        && at(&out, "bodyConsumed") == false
                        && at(&out, "file").is_null()
                        && at(&out, "allowed") == "[\"cloud\",\"hybrid\"]"
                        && at(&out, "audit") == &json!([]),
                    "route/all-methods-state",
                )?;
                count += 1;
            }
        }
    }
    for action in [
        "file",
        "allowed",
        "insert",
        "update",
        "delete",
        "indirect",
        "indirect-update",
        "indirect-delete",
        "rename-in",
        "rename-out",
        "feature",
    ] {
        let mut c = case();
        put(&mut c, "routeEnv", full())?;
        put(&mut c, "guardAction", json!(action))?;
        let out = actual(core, c)?;
        require(
            at(at(&out, "response"), "status") == 503,
            "confirmed route ownership refusal missing",
        )?;
        if action == "feature" {
            require(
                at(&out, "guardError").is_null() && at(&out, "feature") == "true",
                "Node product feature writer was denied",
            )?;
        } else {
            require(
                !at(&out, "guardError").is_null()
                    && (if action == "rename-in" {
                        at(&out, "allowed").is_null()
                            && at(&out, "unowned") == "[\"cloud\",\"hybrid\"]"
                    } else {
                        at(&out, "allowed") == "[\"cloud\",\"hybrid\"]"
                    })
                    && at(&out, "file").is_null()
                    && at(&out, "audit") == &json!([]),
                &format!("writer/{action}"),
            )?;
        }
        count += 1;
    }
    for probe in ["flags", "describe"] {
        for direct in ["true", "false", "malformed"] {
            let mut c = case();
            put(&mut c, "env", full())?;
            put(
                &mut c,
                "feature",
                json!(if direct == "true" { "false" } else { "true" }),
            )?;
            put(&mut c, "directFeature", json!(direct))?;
            put(&mut c, "featureProbe", json!(probe))?;
            let out = actual(core, c)?;
            require(
                at(&out, "featureProbe") == (direct == "true"),
                &format!("feature/{probe}-fresh"),
            )?;
            count += 1;
        }
    }
    for key in full().as_object().ok_or("full guard env invalid")?.keys() {
        for bad in [Value::Null, json!("0"), json!("true"), json!(" 1")] {
            let mut env = full();
            env.as_object_mut().ok_or("guard env invalid")?.remove(key);
            if !bad.is_null() {
                put(&mut env, key, bad)?;
            }
            let mut c = case();
            put(&mut c, "routeEnv", env)?;
            put(&mut c, "guardAction", json!("allowed"))?;
            let out = actual(core, c)?;
            require(
                at(at(&out, "response"), "status") == 200
                    && at(&out, "guardError").is_null()
                    && at(&out, "allowed") == "[\"local\"]",
                "incomplete guard incorrectly owns routing",
            )?;
            count += 1;
        }
    }
    for confirmed in [false, true] {
        for initial in [
            Value::Null,
            json!("false"),
            json!("true"),
            json!("malformed"),
        ] {
            for direct in ["true", "false", "malformed"] {
                let mut c = case();
                put(&mut c, "feature", initial.clone())?;
                put(&mut c, "directFeature", json!(direct))?;
                if confirmed {
                    put(&mut c, "env", full())?;
                }
                let out = actual(core, c)?;
                let expected = if confirmed {
                    direct == "true"
                } else {
                    initial == "true"
                };
                require(
                    at(&out, "featureEnabled") == expected
                        && at(at(at(&out, "response"), "body"), "enabled") == expected,
                    "confirmed product refresh or legacy cache changed",
                )?;
                count += 1;
            }
        }
    }
    for (raw, expected) in [
        ("", None),
        (" \u{feff}", None),
        ("yes", Some(true)),
        (" TRUE ", Some(true)),
        ("on", Some(true)),
        ("1", Some(true)),
        ("false", Some(false)),
        ("0", Some(false)),
        ("off", Some(false)),
        ("NO", Some(false)),
        ("enabled", None),
    ] {
        let mut c = case();
        put(&mut c, "env", full())?;
        put(
            c.get_mut("env").ok_or("env missing")?,
            "NOEVIA_FEATURE_ROUTING_MODES",
            json!(raw),
        )?;
        put(&mut c, "feature", json!("true"))?;
        let out = actual(core, c)?;
        if raw == "enabled" {
            require(
                at(&out, "featureError")
                    == "Invalid boolean in feature env var: expected true/false",
                "invalid product env accepted",
            )?;
        } else {
            require(
                at(&out, "featureEnabled") == expected.unwrap_or(true),
                "product env precedence changed",
            )?;
        }
        count += 1;
    }
    for abort in [false, true] {
        let mut c = case();
        put(&mut c, "env", full())?;
        put(&mut c, "featureUpdate", json!(true))?;
        put(&mut c, "auditAbort", json!(abort))?;
        let out = actual(core, c)?;
        require(
            at(&out, "feature") == "true" && at(&out, "featureEnabled") == true,
            "admin product feature save/audit partial state changed",
        )?;
        require(
            at(&out, "audit")
                .as_array()
                .is_some_and(|a| a.len() == usize::from(!abort)),
            "product feature audit state changed",
        )?;
        count += 1;
        let mut c = case();
        put(&mut c, "feature", json!("true"))?;
        put(&mut c, "method", json!("PUT"))?;
        put(&mut c, "path", json!("/api/routing-mode/allowed"))?;
        put(
            &mut c,
            "body",
            json!(hex(br#"{"allowed":["hybrid","local","local"]}"#)),
        )?;
        put(&mut c, "auditAbort", json!(abort))?;
        let out = actual(core, c)?;
        require(
            at(&out, "allowed") == "[\"local\",\"hybrid\"]",
            "allowed list write-then-audit partial commit changed",
        )?;
        let expected = if abort { 400 } else { 200 };
        require(
            at(at(&out, "response"), "status") == expected,
            "actual Node allowed audit status changed",
        )?;
        if abort {
            require(
                at(&out, "audit") == &json!([])
                    && at(at(at(&out, "response"), "body"), "error") == "synthetic audit refusal",
                "actual Node partial audit failure qualifier changed",
            )?;
        } else {
            require(
                at(&out, "audit").as_array().is_some_and(|a| !a.is_empty()),
                "routing audit missing",
            )?;
            let a = at(&out, "audit")
                .as_array()
                .and_then(|a| a.first())
                .ok_or("routing audit missing")?;
            require(
                at(a, "actor_user_id") == ACTOR
                    && at(a, "target_user_id") == ACTOR
                    && at(a, "action") == "routing.allowed"
                    && at(a, "detail") == &json!({"allowed":["local","hybrid"]}),
                "routing audit actor/target/detail changed",
            )?;
        }
        count += 1;
    }
    for role in ["admin", "member"] {
        let mut c = case();
        put(&mut c, "feature", json!("true"))?;
        put(&mut c, "method", json!("PUT"))?;
        put(&mut c, "path", json!("/api/routing-mode/allowed"))?;
        put(&mut c, "role", json!(role))?;
        put(&mut c, "body", json!(hex(b"{")))?;
        let out = actual(core, c)?;
        require(
            at(at(&out, "response"), "status") == 400,
            "allowed member JSON-before-admin order changed",
        )?;
        count += 1;
    }
    Ok(count)
}
struct Restore {
    path: PathBuf,
    original: String,
}
impl Drop for Restore {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.path, &self.original);
    }
}
fn mutants(core: &Path, inject_fault: bool) -> Result<(), Failure> {
    for (name, file, old, new, expected) in [
        (
            "confirmation",
            "server/routing-modes.cjs",
            "return env.NOEVIA_FRONT === 'rust'",
            "return false && env.NOEVIA_FRONT === 'rust'",
            "route/all-methods-state",
        ),
        (
            "feature-refresh",
            "server/features.cjs",
            "if (!store || !state.has('routingModes')",
            "if (true || !store || !state.has('routingModes')",
            "feature/flags-fresh",
        ),
        (
            "indirect-insert",
            "server/rust-auth.cjs",
            "WHEN NEW.key='routing_modes_allowed' BEGIN",
            "WHEN NEW.key='synthetic_unowned' BEGIN",
            "writer/indirect",
        ),
        (
            "indirect-update",
            "server/rust-auth.cjs",
            "WHEN OLD.key='routing_modes_allowed' OR NEW.key='routing_modes_allowed' BEGIN",
            "WHEN OLD.key='synthetic_unowned' OR NEW.key='synthetic_unowned' BEGIN",
            "writer/indirect-update",
        ),
        (
            "indirect-delete",
            "server/rust-auth.cjs",
            "WHEN OLD.key='routing_modes_allowed' BEGIN",
            "WHEN OLD.key='synthetic_unowned' BEGIN",
            "writer/indirect-delete",
        ),
        (
            "rename-into-owned",
            "server/rust-auth.cjs",
            "WHEN OLD.key='routing_modes_allowed' OR NEW.key='routing_modes_allowed' BEGIN",
            "WHEN OLD.key='routing_modes_allowed' BEGIN",
            "writer/rename-in",
        ),
        (
            "rename-out-of-owned",
            "server/rust-auth.cjs",
            "WHEN OLD.key='routing_modes_allowed' OR NEW.key='routing_modes_allowed' BEGIN",
            "WHEN NEW.key='routing_modes_allowed' BEGIN",
            "writer/rename-out",
        ),
        (
            "description-refresh",
            "server/features.cjs",
            "describe: () => { refreshRoutingModes();",
            "describe: () => {",
            "feature/describe-fresh",
        ),
        (
            "route-get-only",
            "server/routes/routing-mode.cjs",
            "if (rm.rustOwned(env))",
            "if (req.method === 'GET' && rm.rustOwned(env))",
            "route/all-methods-state",
        ),
        (
            "allowed-persistence",
            "server/routes/routing-mode.cjs",
            "const allowed = rm.setAllowedModes(store, body?.allowed);",
            "const allowed = rm.setAllowedModes({ ...store, set: () => {} }, body?.allowed);",
            "allowed list write-then-audit partial commit changed",
        ),
        (
            "audit-append",
            "server/routes/routing-mode.cjs",
            "audit('routing.allowed', authn.user.id, { allowed });",
            "void allowed;",
            "routing audit missing",
        ),
    ] {
        let path = core.join(file);
        let original = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        require(
            original.matches(old).count() == 1,
            "mutation target must occur exactly once",
        )?;
        let guard = Restore {
            path: path.clone(),
            original: original.clone(),
        };
        std::fs::write(&path, original.replacen(old, new, 1)).map_err(|e| e.to_string())?;
        let original_node = std::env::var_os("NOEVIA_ORACLE_NODE");
        if inject_fault {
            std::env::set_var("NOEVIA_ORACLE_NODE", core.join("synthetic-missing-runtime"));
        }
        let result = qualify(core);
        if inject_fault {
            match original_node {
                Some(v) => std::env::set_var("NOEVIA_ORACLE_NODE", v),
                None => std::env::remove_var("NOEVIA_ORACLE_NODE"),
            }
        }
        drop(guard);
        reject_mutant(name, expected, result)?;
    }
    Ok(())
}
fn reject_mutant(
    name: &str,
    expected: &str,
    result: Result<usize, Failure>,
) -> Result<(), Failure> {
    match result {
        Err(Failure::Assertion(id)) if id == expected => {
            println!("production mutant {name} rejected by assertion {id}");
            Ok(())
        }
        Err(Failure::Infrastructure(error)) => {
            Err(Failure::Infrastructure(format!("mutant {name}: {error}")))
        }
        Err(Failure::Assertion(id)) => Err(Failure::Infrastructure(format!(
            "mutant {name}: unexpected assertion {id}; expected {expected}"
        ))),
        Ok(_) => Err(Failure::Assertion(format!(
            "production mutant {name} survived"
        ))),
    }
}
fn run() -> Result<(), Failure> {
    let mut args = std::env::args().skip(1);
    let core = PathBuf::from(args.next().ok_or("candidate core path required")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let mode = args.next().unwrap_or_else(|| "qualify".into());
    let expected = std::env::var("ROUTING_CORE_HEAD").map_err(|_| "ROUTING_CORE_HEAD required")?;
    let head = git(&core, &["rev-parse", "HEAD"])?;
    require(
        head == expected,
        "candidate HEAD does not match workflow input",
    )?;
    require(
        git(&core, &["status", "--porcelain", "--untracked-files=no"])?.is_empty(),
        "candidate checkout must be clean",
    )?;
    require(
        Command::new("git")
            .arg("-C")
            .arg(&core)
            .args([
                "merge-base",
                "--is-ancestor",
                "4f978ec2e636c9a4a82c40b876765156e8a746e9",
                "HEAD",
            ])
            .status()
            .map_err(|e| e.to_string())?
            .success(),
        "candidate must descend from inspected actual source",
    )?;
    let mut source = serde_json::Map::new();
    for file in [
        "server/routing-modes.cjs",
        "server/routes/routing-mode.cjs",
        "server/features.cjs",
        "server/rust-auth.cjs",
        "tools/contract-corpus/serve.cjs",
    ] {
        let bytes = std::fs::read(core.join(file)).map_err(|e| e.to_string())?;
        source.insert(file.into(), json!(format!("{:x}", Sha256::digest(bytes))));
    }
    println!("{}", json!({"core":head,"sources":source}));
    let n = qualify(&core)?;
    println!("actual Node routing ownership/product/state cases={n}");
    if mode == "mutants" || mode == "mutant-infrastructure" {
        mutants(&core, mode == "mutant-infrastructure")?;
    } else {
        require(mode == "qualify", "unknown routing qualification mode")?;
    }
    Ok(())
}
fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--probe-child") {
        return probe_child();
    }
    if std::env::args().nth(1).as_deref() == Some("--selftest") {
        return match selftest() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("infrastructure control failed: {e}");
                ExitCode::FAILURE
            }
        };
    }
    if std::env::args().nth(1).as_deref() == Some("--lifecycle-selftest") {
        return match lifecycle_selftest() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("lifecycle control failed: {e}");
                ExitCode::FAILURE
            }
        };
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("routing qualification failed: {e}");
            ExitCode::FAILURE
        }
    }
}
fn probe_child() -> ExitCode {
    use std::io::Write;
    match std::env::args().nth(2).as_deref() {
        Some("detached-pipes") => {
            use std::os::unix::process::CommandExt;
            let result = (|| -> Result<(), String> {
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                let child = Command::new(exe)
                    .args(["--probe-child", "pipe-holder"])
                    .process_group(0)
                    .stdin(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())?;
                let path = std::env::args()
                    .nth(3)
                    .ok_or("missing synthetic pid file")?;
                std::fs::write(path, child.id().to_string()).map_err(|e| e.to_string())
            })();
            if result.is_ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Some("pipe-holder") => {
            // Finite emergency lifetime even if the synthetic control is interrupted.
            std::thread::sleep(Duration::from_secs(5));
            ExitCode::SUCCESS
        }
        Some("exit") => ExitCode::SUCCESS,
        Some("oversized") => match std::io::stdout().write_all(&vec![b'x'; process::INPUT + 1]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => ExitCode::FAILURE,
        },
        _ => loop {
            std::thread::sleep(Duration::from_secs(1));
        },
    }
}
fn lifecycle_selftest() -> Result<(), Failure> {
    use rustix::process::{waitid, WaitId, WaitIdOptions};
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut command = Command::new(&exe);
    command.args(["--probe-child", "exit"]);
    let mut retained = false;
    let mut child_pid = None;
    let output = process::bounded_observed(
        &mut command,
        Vec::new(),
        Duration::from_millis(300),
        |id| child_pid = rustix::process::Pid::from_raw(id as i32),
        |id| {
            retained = rustix::process::Pid::from_raw(id as i32).is_some_and(|pid| {
                waitid(
                    WaitId::Pid(pid),
                    WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
                )
                .is_ok_and(|status| status.is_some())
            });
        },
    )?;
    require(
        output.status.success() && retained,
        "lifecycle/signal-before-reap",
    )?;
    require(
        child_pid.is_some_and(|pid| {
            waitid(
                WaitId::Pid(pid),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            )
            .is_err()
        }),
        "lifecycle/after-signal-reaped",
    )?;
    println!("signal-before-reap control: exited leader remained waitable before group signal and was reaped afterward");

    use std::os::unix::fs::DirBuilderExt;
    let directory =
        std::env::temp_dir().join(format!("routing-detached-pipe-{}", std::process::id()));
    // Exclusive private directory prevents a preexisting /tmp entry from supplying
    // the synthetic PID or redirecting the child's PID-file write.
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(|e| e.to_string())?;
    let path = directory.join("holder.pid");
    command = Command::new(exe);
    command.args(["--probe-child", "detached-pipes"]).arg(&path);
    let start = std::time::Instant::now();
    let result =
        process::bounded_with(&mut command, Vec::new(), Duration::from_millis(300), |id| {
            child_pid = rustix::process::Pid::from_raw(id as i32)
        });
    let elapsed = start.elapsed();
    // Clean only the PID recorded by this fixed synthetic child, before asserting.
    let pid_text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let holder = pid_text
        .parse::<i32>()
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .ok_or("invalid synthetic holder pid")?;
    let alive = rustix::process::test_kill_process(holder).is_ok();
    rustix::process::kill_process_group(holder, rustix::process::Signal::KILL)
        .map_err(|e| e.to_string())?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    std::fs::remove_dir(&directory).map_err(|e| e.to_string())?;
    require(alive, "lifecycle/escaped-holder-outside-authority")?;
    require(
        result
            .as_ref()
            .err()
            .is_some_and(|e| e == "child deadline exceeded"),
        "lifecycle/detached-pipe-deadline",
    )?;
    require(
        elapsed < Duration::from_millis(1500),
        "lifecycle/detached-pipe-return-bound",
    )?;
    require(
        child_pid.is_some_and(|pid| rustix::process::test_kill_process(pid).is_err()),
        "lifecycle/detached-leader-reaped",
    )?;
    println!("detached inherited stdout/stderr control: 300ms deadline returned in {}ms; escaped synthetic holder alive outside group authority, explicitly signalled; direct leader reaped", elapsed.as_millis());
    Ok(())
}
fn selftest() -> Result<(), Failure> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    for (mode, expected) in [
        ("stall", "child deadline exceeded"),
        ("oversized", "child output limit exceeded"),
        ("exit", "child stdin failed"),
    ] {
        let mut command = Command::new(&exe);
        command.args(["--probe-child", mode]);
        let mut pid = None;
        let result = process::bounded_with(
            &mut command,
            vec![b'x'; process::INPUT],
            Duration::from_millis(300),
            |id| pid = rustix::process::Pid::from_raw(id as i32),
        );
        require(
            result.as_ref().err().is_some_and(|e| e.contains(expected)),
            &format!("lifecycle/{mode}"),
        )?;
        require(
            pid.is_some_and(|p| rustix::process::test_kill_process(p).is_err()),
            &format!("lifecycle/{mode}-reaped"),
        )?;
        println!("bounded child control {mode} rejected");
    }
    require(
        process::json_input(&json!("x".repeat(process::INPUT))).is_err(),
        "bounded serialization",
    )?;
    require(
        reject_mutant(
            "synthetic",
            "expected",
            Err(Failure::Infrastructure("synthetic spawn failure".into())),
        )
        .is_err(),
        "infrastructure never qualifies mutant",
    )?;
    require(
        reject_mutant(
            "synthetic",
            "expected",
            Err(Failure::Assertion("wrong assertion".into())),
        )
        .is_err(),
        "wrong assertion never qualifies mutant",
    )?;
    Ok(())
}
