//! Fixed finite child limits. All pipe workers are joined after process-group kill/reap.
use std::{
    io::{Read, Write},
    os::unix::process::CommandExt,
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
pub const INPUT: usize = 2 * 1024 * 1024;
const OUTPUT: usize = 2 * 1024 * 1024;
const STDERR: usize = 64 * 1024;
struct Owned(Child, bool);
impl Owned {
    fn stop(&mut self) {
        if self.1 {
            return;
        }
        self.1 = true;
        if let Some(pid) = rustix::process::Pid::from_raw(self.0.id() as i32) {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        self.stop();
    }
}
fn read(mut pipe: impl Read, cap: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buf = [0; 4096];
    loop {
        let n = pipe.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(bytes);
        }
        if bytes.len() + n > cap {
            return Err("child output limit exceeded".into());
        }
        bytes.try_reserve(n).map_err(|e| e.to_string())?;
        bytes.extend(buf.get(..n).ok_or("invalid child read count")?);
    }
}
pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
pub fn bounded(mut command: Command, input: Vec<u8>, deadline: Duration) -> Result<Output, String> {
    bounded_with(&mut command, input, deadline, |_| {})
}
pub fn bounded_with(
    command: &mut Command,
    input: Vec<u8>,
    deadline: Duration,
    spawned: impl FnOnce(u32),
) -> Result<Output, String> {
    if input.len() > INPUT {
        return Err("child input limit exceeded".into());
    }
    let start = Instant::now();
    command
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = Owned(
        command
            .spawn()
            .map_err(|e| format!("child spawn failed: {e}"))?,
        false,
    );
    spawned(child.0.id());
    let stdin = child.0.stdin.take().ok_or("child stdin unavailable")?;
    let stdout = child.0.stdout.take().ok_or("child stdout unavailable")?;
    let stderr = child.0.stderr.take().ok_or("child stderr unavailable")?;
    let (send, receive) = mpsc::channel();
    let tx = send.clone();
    let write = thread::spawn(move || {
        let result = {
            let mut stdin = stdin;
            stdin
                .write_all(&input)
                .map(|_| Vec::new())
                .map_err(|e| format!("child stdin failed: {e}"))
        };
        let _ = tx.send((0, result));
    });
    let tx = send.clone();
    let out = thread::spawn(move || {
        let _ = tx.send((1, read(stdout, OUTPUT)));
    });
    let err = thread::spawn(move || {
        let _ = send.send((2, read(stderr, STDERR)));
    });
    let mut stdout = None;
    let mut stderr = None;
    let mut wrote = false;
    let result = (|| loop {
        while let Ok((stream, result)) = receive.try_recv() {
            let bytes = result?;
            match stream {
                0 => wrote = true,
                1 => stdout = Some(bytes),
                2 => stderr = Some(bytes),
                _ => return Err("unknown child stream".into()),
            }
        }
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            if wrote && stdout.is_some() && stderr.is_some() {
                return Ok(Output {
                    status,
                    stdout: stdout.take().ok_or("child stdout absent")?,
                    stderr: stderr.take().ok_or("child stderr absent")?,
                });
            }
        }
        if start.elapsed() >= deadline {
            return Err("child deadline exceeded".into());
        }
        thread::sleep(Duration::from_millis(2));
    })();
    child.stop();
    for worker in [write, out, err] {
        if worker.join().is_err() {
            return Err("child pipe worker panicked".into());
        }
    }
    result
}
pub fn json_input(value: &serde_json::Value) -> Result<Vec<u8>, String> {
    struct Limited(Vec<u8>);
    impl Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.0.len() + bytes.len() > INPUT {
                return Err(std::io::Error::other("child input limit exceeded"));
            }
            self.0
                .try_reserve(bytes.len())
                .map_err(std::io::Error::other)?;
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Limited(Vec::new());
    serde_json::to_writer(&mut writer, value).map_err(|e| e.to_string())?;
    Ok(writer.0)
}
