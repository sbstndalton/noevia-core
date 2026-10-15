//! Candidate-core qualification against immutable merged RS source; never changes its pin checks.
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
    time::{SystemTime, UNIX_EPOCH},
};
const FIXTURE: &str = "cb865f4baf9f788e0aa0df90d935c0ea0de0a512";
const RS_REF: &str = "2fe1a15b4112e2c0a581745701a4c533cd3e414e";
const ARCHIVE: &str = "246c1a87cfc0390f09199087431e1be90a029b77e339744b311f57638a910289";
const TEMPLATES: [(&str, &str); 3] = [
    (
        "input",
        "dd88408668d3153dcb2973b8fc81c6a0f467c1077141f61a63c20024a7fa2820",
    ),
    (
        "launch",
        "b38e7b6aa6c12c66717032694f6b66c844ee5518e99804a35d0e21e955416492",
    ),
    (
        "verify",
        "e1b27d9fdc0030fb0b5c1efd01280ad98b45b6ecf48cb140883ffd4554ad87e6",
    ),
];
fn env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("required {name} missing"))
}
fn hash(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = [0; 8192];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(buf.get(..n).ok_or("hash buffer range invalid")?);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn text(path: &Path) -> Result<String, String> {
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("qualification input exceeds cap".into());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}
fn js(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
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
    String::from_utf8(o.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| e.to_string())
}
fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().ok_or("mode required")?;
    let core = PathBuf::from(args.next().ok_or("candidate core required")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let extra = args.next();
    if args.next().is_some() {
        return Err("too many arguments".into());
    }
    let head = env("CORE_ACCEPTANCE_HEAD")?;
    if head.len() != 40
        || !head.bytes().all(|b| b.is_ascii_hexdigit())
        || git(&core, &["rev-parse", "HEAD"])? != head
    {
        return Err("candidate HEAD does not match workflow input".into());
    }
    if !git(&core, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("candidate tracked tree must be clean".into());
    }
    git(&core, &["merge-base", "--is-ancestor", FIXTURE, &head])?;
    let rs = PathBuf::from(env("CORE_ACCEPTANCE_RS")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if hash(Path::new(&env("CORE_ACCEPTANCE_ARCHIVE")?))? != ARCHIVE {
        return Err("actual merged RS archive checksum mismatch".into());
    }
    if text(&rs.join("contracts/http/core.ref"))?.trim() != FIXTURE {
        return Err("immutable fixture source pin mismatch".into());
    }
    let mut templates = std::collections::BTreeMap::new();
    for (name, expected) in TEMPLATES {
        let p = rs.join(format!("tools/replay/src/synthetic-host-{name}.cjs"));
        if hash(&p)? != expected {
            return Err(format!("immutable {name} template checksum mismatch"));
        }
        templates.insert(name, text(&p)?);
    }
    let source = serde_json::json!({"candidateCore":head,"fixtureCore":FIXTURE,"acceptanceRs":RS_REF,"acceptanceArchiveSha256":ARCHIVE,"templates":TEMPLATES,"adapterSha256":hash(&std::env::current_exe().map_err(|e|e.to_string())?)?,"shimSha256":hash(Path::new(&env("CORE_ACCEPTANCE_SHIM")?))?,"hostMemTotalKib":8388608});
    if mode == "provenance" {
        std::fs::write(
            extra.ok_or("provenance output required")?,
            serde_json::to_vec_pretty(&source).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    if mode == "oracle" {
        let actual: serde_json::Value =
            serde_json::from_str(&text(Path::new(&extra.ok_or("actual oracle required")?))?)
                .map_err(|e| e.to_string())?;
        let expected: serde_json::Value = serde_json::from_str(&text(
            &rs.join("crates/server-reasoning-settings/tests/fixtures/node-reasoning.v1.json"),
        )?)
        .map_err(|e| e.to_string())?;
        if actual.get("core").and_then(serde_json::Value::as_str) != Some(&head)
            || actual.get("cases") != expected.get("cases")
            || actual.get("routeSha256") != expected.get("routeSha256")
            || actual
                .get("cases")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                != Some(52)
        {
            return Err(
                "actual candidate 52-case module oracle differs from immutable acceptance".into(),
            );
        }
        println!("actual candidate52 cases match immutable merged acceptance");
        return Ok(());
    }
    if extra.is_some()
        || !["serve", "wrong-host", "verify", "verify-omission"].contains(&mode.as_str())
    {
        return Err("unsupported qualification mode".into());
    }
    let tick = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("core-acceptance-{}-{tick}", std::process::id()));
    std::fs::create_dir(&temp).map_err(|e| e.to_string())?;
    let result = (|| {
        let input = templates
            .get("input")
            .ok_or("input template missing")?
            .replace(
                "__BUDGET__",
                &js(&core.join("server/inference-budget.cjs").to_string_lossy())?,
            )
            .replace(
                "__MEMINFO__",
                &js(if mode == "wrong-host" {
                    "MemTotal:        12582912 kB\n"
                } else {
                    "MemTotal:        8388608 kB\n"
                })?,
            );
        let preload = temp.join("host-input.cjs");
        std::fs::write(&preload, input).map_err(|e| e.to_string())?;
        let wrapper = temp.join("launch.cjs");
        let mut launch = templates
            .get("launch")
            .ok_or("launch template missing")?
            .clone();
        for (key, value) in [
            ("__SERVER__", core.join("server/index.cjs")),
            (
                "__GUARD__",
                core.join("tools/contract-corpus/net-guard.cjs"),
            ),
            ("__PRELOAD__", preload),
            ("__ENTRY__", core.join("tools/contract-corpus/serve.cjs")),
            ("__TEMP__", temp.clone()),
        ] {
            launch = launch.replace(key, &js(&value.to_string_lossy())?);
        }
        launch = launch.replace("__ARGS__", "[]");
        // The merged launcher fills this with a dependency override in its prompts modes only and
        // with nothing otherwise (corpus-launcher.rs prepare); none of these modes is a prompts mode.
        launch = launch.replace("__PROMPTS_OVERRIDE__", "");
        if mode == "verify-omission" {
            let omitted = launch.replace("[args[0],args[1],'--require',preload,args[2]]", "args");
            if omitted == launch {
                return Err("omission target missing".into());
            }
            launch = omitted;
        }
        std::fs::write(&wrapper, launch).map_err(|e| e.to_string())?;
        if mode.starts_with("verify") {
            let verify = templates
                .get("verify")
                .ok_or("verify template missing")?
                .replace("__WRAPPER__", &js(&wrapper.to_string_lossy())?)
                .replace("__CORE__", &js(&core.to_string_lossy())?);
            let o = Command::new("node")
                .args(["-e", &verify])
                .output()
                .map_err(|e| e.to_string())?;
            if mode == "verify" && o.status.success() {
                print!("{}", String::from_utf8_lossy(&o.stdout));
                return Ok(());
            }
            if mode == "verify-omission"
                && !o.status.success()
                && String::from_utf8_lossy(&o.stderr).contains("FIXTURE_SPAWN_PRELOAD_REQUIRED")
            {
                println!("missing fixture preload decisively rejected");
                return Ok(());
            }
            return Err("actual candidate spawn/factory verification failed".into());
        }
        Err(Command::new("node").arg(&wrapper).exec().to_string())
    })();
    let _ = std::fs::remove_dir_all(&temp);
    result
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("core-acceptance: {e}");
            ExitCode::from(2)
        }
    }
}
