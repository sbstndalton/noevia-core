# Native supervisor image qualification

`qualify-native-supervisor.cjs` runs only in the owned Linux CI job. It takes the
actual rendered companion Compose profile, the built sandbox image and the exact
Core checkout. It binds all runtime containers and extracted fault artifacts to
that image's immutable ID. It does not run repository commands on the host.

The required case table has 32 entries, including explicit Node rollback controls,
native identity/session and environment checks, the real Core ACP client,
permissions and filesystem RPC, framing/refusals, output backpressure, observed
worker cancellation, wall/shutdown/capacity and packaged pi bridge propagation.
Every case must complete; there is no optional or skipped qualification path.

The two retained Node controls prove default/explicit selector compatibility,
ACP behavior and worker drain while the Node supervisor stays live. Its existing
PID1 entrypoint has no TERM handler, so the qualifier recycles that already-idle
owned namespace with KILL and requires exit137; this is not graceful Node shutdown
credit. Native cases retain TERM with exit0, including the active-worker shutdown
case, and cannot use that control-only recycling path.

The actual pi bridge CLI runs with its pinned Rust WASM and a fixed readonly
synthetic RPC executable at `pi`'s existing image lookup path. No environment
allowlist is widened and no model inference is performed. The expiry case waits
for the CLI's real five-minute permission deadline, sends the expired approval
and a cancel in TCP order, and requires the backend's cancel barrier to observe
exactly one refused answer. This deliberately adds approximately five minutes to
the required job. It does not substitute a shortened test knob for the CLI path.

Core AbortController cases assert the real client's cancel-notification emission
through a passive, byte-preserving socket observer, then prove disconnect cleanup;
they do not claim that immediate transport destruction guarantees backend delivery.
A separate pending-permission protocol case waits for actual backend refusal,
sends cancel while the connection remains open, and validates both typed backend
receipts before accepting the cancelled ACP response. An omission control uses
Core's public transport stop without a cancel notification. After the host observes
the live supervisor alone, that control must reject the same cancellation-evidence
predicate despite local prompt rejection and successful process cleanup. Missing
backend cancellation cannot silently earn protocol-propagation credit.

The synthetic fixtures are mounted only into owned qualification containers and
are not copied into the shipped image. Startup fault cases exercise the real
selector against missing/non-executable/symlinked helper or corrupt module data;
the source's Node default remains unchanged. The portable selector tests remain
supporting source evidence, not image qualification.

The supervisor owns a verified process session/group, not the verifier's PID1
all-child guarantee. Ordinary cases require all workers gone while the supervisor
is still running. Escape cases instead require an actual adopted process in a
distinct session, an uncertain-output reset, and explicit owned namespace
recycling. They earn no per-session drain claim. No global PID/UID sweep,
additional capability, published port, real credential, production volume or
Docker socket enters the containers.

Run through the required CI step; local syntax/source checks cannot establish
Linux namespace, process, caller or permission behavior. This suite is component
evidence. Release pin coherence, live engine acceptance and activation remain
separate gates.
