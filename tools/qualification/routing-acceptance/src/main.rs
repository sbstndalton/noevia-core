//! Required actual-candidate Node ownership qualification. Rust owns cases and assertions.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
};
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
fn actual(core: &Path, case: Value) -> Result<Value, String> {
    let node = std::env::var("NOEVIA_ORACLE_NODE").unwrap_or_else(|_| "node".into());
    let mut child = Command::new(node)
        .arg(core.join("tools/contract-corpus/serve.cjs"))
        .arg("--routing-mode-oracle")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("oracle stdin unavailable")?
        .write_all(json!({"cases":[case]}).to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(format!(
            "actual oracle failed: {}",
            String::from_utf8_lossy(&o.stderr)
        ));
    }
    let v: Value = serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())?;
    v.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or("oracle result missing".into())
}
fn require(ok: bool, msg: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(msg.into())
    }
}
fn qualify(core: &Path) -> Result<usize, String> {
    let mut count = 0;
    for action in [
        "file", "allowed", "insert", "update", "delete", "indirect", "feature",
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
                    && at(&out, "allowed") == "[\"cloud\",\"hybrid\"]"
                    && at(&out, "file").is_null(),
                "confirmed direct/indirect writer refusal missing",
            )?;
        }
        count += 1;
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
fn mutants(core: &Path) -> Result<(), String> {
    for (name, file, old, new) in [
        (
            "confirmation",
            "server/routing-modes.cjs",
            "return env.NOEVIA_FRONT === 'rust'",
            "return false && env.NOEVIA_FRONT === 'rust'",
        ),
        (
            "feature-refresh",
            "server/features.cjs",
            "if (!store || !state.has('routingModes')",
            "if (true || !store || !state.has('routingModes')",
        ),
        (
            "indirect-insert",
            "server/rust-auth.cjs",
            "WHEN NEW.key='routing_modes_allowed' BEGIN",
            "WHEN NEW.key='synthetic_unowned' BEGIN",
        ),
        (
            "allowed-persistence",
            "server/routes/routing-mode.cjs",
            "const allowed = rm.setAllowedModes(store, body?.allowed);",
            "const allowed = rm.setAllowedModes({ ...store, set: () => {} }, body?.allowed);",
        ),
        (
            "audit-append",
            "server/routes/routing-mode.cjs",
            "audit('routing.allowed', authn.user.id, { allowed });",
            "void allowed;",
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
        let result = qualify(core);
        drop(guard);
        require(
            result.is_err(),
            &format!("production mutant {name} survived"),
        )?;
        println!(
            "production mutant {name} rejected: {}",
            result.err().unwrap_or_default()
        );
    }
    Ok(())
}
fn run() -> Result<(), String> {
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
    if mode == "mutants" {
        mutants(&core)?;
    } else {
        require(mode == "qualify", "unknown routing qualification mode")?;
    }
    Ok(())
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("routing qualification failed: {e}");
            ExitCode::FAILURE
        }
    }
}
