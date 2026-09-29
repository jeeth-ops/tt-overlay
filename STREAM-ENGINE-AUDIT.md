# Stream Engine — reliability audit

Scope of this pass: the offline / failure-isolation half of the brief —
"local pipeline must never stop because the internet stopped, and pending
uploads must drain when it returns."

Audited: `stream-engine/server.js` (4,459 lines), `stream-engine/nativePipeline.js`,
`stream-engine/overlayBridge.js`, the clip-ingest and retry half of the Render
`server.js`, and `cricket-panel.html`'s clip-status UI.

---

## A. What is already correct

These were checked against the brief and found genuinely implemented — no
change needed. Listing them matters as much as the bugs: the fix for a
requirement that is already met is to leave it alone.

| Requirement | Where | Verdict |
|---|---|---|
| Recording and streaming are separate OS processes | `startRecorder` / encoder state machine | Correct. A YouTube reconnect, ABR restart or RTMPS crash never touches the recorder process. |
| Clips are cut from the local master recording, never from YouTube/HLS | `cutLocalClip` | Correct, and enforced explicitly. |
| `/recording-start` and `/clip` do not gate on connectivity | endpoints | Correct. `checkNetwork()` is called from exactly one place — `/go-live` pre-flight — so it can only ever block the stream. |
| Clip windows are frozen per job at T0 | `acceptClipEvent`, `Object.freeze(window)` | Correct. Back-to-back clips cannot truncate each other. |
| Clip dedupe by stable id | `buildClipId` (matchId+eventType+timestamp) | Correct and idempotent. |
| R2 and Drive tracked independently | Render `server.js`: `needsR2` / `needsDrive`, separate `r2Status`/`driveStatus`, separate "already uploaded" short-circuits | Correct. One failing does not fail the other, and a retry does not duplicate an object. |
| Clip cut queue is bounded and non-blocking | `pumpClipQueue`, `CLIP_MAX_CONCURRENT_CUTS` | Correct. |
| Post-roll/retry timers are tracked and cleared | `clipTimers` set, cleared in `gracefulShutdown` | Correct — no timer leak on that path. |
| Clip job map is bounded | `pruneClipJobs`, `CLIP_JOBS_KEEP_IN_MEMORY` | Correct — cannot grow for a whole match. |
| Clip-job persistence is debounced and async | `persistClipJobs` | Correct — was already fixed away from a per-change `writeFileSync`. |
| Connectivity failures never become permanent | `isConnectivityFailure`, `OFFLINE_RETRY_INTERVAL_MS` | Correct. Only a 4xx rejection can exhaust attempts. |
| Backlog flushes at once on recovery | `flushRetryQueueNow` | Correct — the whole queue is retried the moment one upload proves the line is back, not one per backoff. |
| Graceful shutdown is ordered and bounded | `gracefulShutdown` | Correct, with a hard deadline. Verified by booting the engine and sending SIGTERM (below). |

---

## B. What was fragile — root causes and fixes

### B1. The offline upload queue silently stopped being written — CRITICAL

**Symptom it would have produced:** clips cut during a long outage are on
disk, but after a Stream Engine restart only the first one ever uploads.
Nobody finds out until after the match.

**Root cause.** The queue was persisted with

```js
try { fs.writeFileSync(FILE, JSON.stringify(retryQueue)); } catch (e) { /* best effort */ }
```

Each queued entry also carries `timer`, the live `setTimeout` handle for its
next retry. A Node `Timeout` is circular (`_idlePrev` → `TimersList` →
`_idleNext` → back), so `JSON.stringify` **throws**, and the empty catch ate it.

The ordering is what makes it bite exactly during an outage:

1. Clip 1 fails to forward → pushed → persisted **successfully** (its own timer is still `null`) → timer armed.
2. Clip 2 fails → pushed → persist **throws**, because clip 1's timer is now live → file unchanged.
3. Every clip after that, and every write for the rest of the outage. After a restart re-arms all timers, the file can never be written again at all.

**Fix** — `stream-engine/retryQueueStore.js` (new):

- Persist a **projection** of each entry (the fields describing the work),
  never runtime handles. Serialising became total — it cannot throw on a live
  timer because a live timer is no longer part of what gets written.
- Write to a temp file and `rename`, so a crash mid-write cannot leave a
  truncated queue that fails to parse next start.
- **Report** a failed write instead of swallowing it.
- Load tolerantly: missing file = first run; corrupt file = empty, not a throw.

**Why it cannot recur:** the failure was possible only because the persisted
shape was "whatever happens to be on the object". It is now an explicit field
list, and a write failure is loud.

### B2. No second record of pending work

**Root cause.** The retry queue file was the *only* thing driving retries. When
B1 corrupted it, the clips' `.mp4` files and their `clip-jobs.local.json`
entries both still existed — but nothing read them.

**Fix** — `recoverOrphanedClipUploads()` runs at startup and re-queues any clip
whose job is `RETRY_PENDING` / `FORWARDING` / `LOCAL_SAVED`, whose file is on
disk, and which has no queue entry. This recovers clips already stranded by B1
on operators' machines, and from now on **two independent records must both be
wrong** before a cut clip stops being retried.

### B3. A clip was refused outright when no upload destination was configured

**Root cause.** `acceptClipEvent` rejected the event when `mainServerUrl` was
absent, with "No recording session for this match". That conflated *there is no
footage to cut* with *there is nowhere to send it* — and threw away a clip the
operator could have had on disk. It is a local-vs-remote coupling of exactly
the kind the brief forbids.

**Fix.** The guard now tests what a cut actually needs — a registered recording
session. With no destination, the clip is cut, organised into the player/team
tree and parked as `LOCAL_ONLY`. `adoptLocalOnlyClips()` (called from
`/recording-start`) hands those existing files a destination the moment one is
registered; nothing is re-cut.

### B4. The queue was not persisted on shutdown

Attempt counts and offline flags move during a match, but `gracefulShutdown`
flushed clip jobs only. Now it persists the queue too. (Harmless while B1 meant
the file was never written anyway — it matters now that it is.)

### B5. The panel misreported live clip status

**Root cause.** `CJ_ACTIVE` and `clipJobLine()` in `cricket-panel.html` carry
the *old ClipperHelper.exe* status names. The Stream Engine reports its own
(`WAITING_FOR_POSTROLL`, `FORWARDING`, `RETRY_PENDING`, `FAILED_PERMANENT`),
none of which were listed. So during those phases the panel treated the clip as
finished — it dropped to the idle 8-second poll and rendered the raw status
string instead of a sentence.

This is the brief's "operator must see real status" requirement failing in the
exact situation it exists for: a clip waiting on a dead line showed as a bare
`RETRY_PENDING` rather than "saved locally, upload queued".

**Fix.** The engine's status names are now in `CJ_ACTIVE` and have proper
labels, including `LOCAL_ONLY`.

---

## C. Verification actually performed

- `stream-engine/test/retryQueueStore.test.js` — **8 passing**. Covers the
  regression directly: three clips queued during an outage with retry timers
  armed, all three on disk, all three loaded back after a restart with file
  path, destination, attempt count and ball metadata intact; plus
  missing-file, truncated-file, atomicity and error-reporting paths.
- The engine was booted on this machine, reported its own degraded state
  honestly (no ffmpeg/NVENC here), served, and shut down cleanly on SIGTERM
  through the full `gracefulShutdown` path.
- `node --check` on `stream-engine/server.js`; inline-script syntax check on
  `cricket-panel.html`.

## D. NOT verified here — needs the operator's Windows machine

This container is Linux with no GPU, no camera, no ffmpeg build. The following
parts of the brief were **audited by reading** but cannot be executed here, and
should not be treated as proven:

- NVENC / GPU path, `-tune ll`, GPU scaling.
- gdigrab / dshow capture, the compositor, overlay bridge.
- RTMPS smoothness, ABR behaviour under real packet loss.
- The 1/2/4/7-hour soak, and any RAM/VRAM/handle drift it would reveal.
- The end-to-end offline clip test (brief §35) — it needs a real master
  recording to cut from. The persistence half of it is covered by the unit
  tests above; the cut half is not.

## E. Remaining findings, not yet fixed

Ranked. None are as severe as B1.

1. **`pollRenderStatus` floating promises.** One detached 5-minute poll loop per
   forwarded clip, not cancelled on shutdown and not restarted after a restart
   (a clip left `FORWARDING` relies on B2's recovery instead). Bounded, so not a
   leak — but it should be a single sweep over jobs rather than a promise each.
2. **Retry timers are untracked.** `scheduleRetry` uses a raw `setTimeout` not
   in `clipTimers`. Currently harmless because shutdown ends in `process.exit(0)`,
   but it means a retry can fire mid-shutdown.
3. **`flushRetryQueueNow`'s re-entry guard is a 1-second timer**, not tied to the
   actual completion of the flush.
4. **Disk-space protection** (brief §27) — `diskFreeBytes` is reported via
   `/recording-info` and `/status`, but nothing acts on a critical threshold.
5. **Upload/media priority** (brief §42) — clip cuts run below-normal priority;
   the forward itself is not throttled by system load.
