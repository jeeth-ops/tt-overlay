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

## E. Second pass — camera/capture-card, poller, disk, audio

### E1. The camera's REAL resolution was never reported — highest risk for a capture card

`live-output.html` asks for `width: 1920, height: 1080` as **ideal** constraints, so
`getUserMedia` never fails on a device that cannot deliver it — it quietly returns a
lower mode and every stage downstream upscales. Nothing anywhere read
`videoTrack.getSettings()`, so the actual mode was invisible.

This exact failure is already in the codebase's own history: the AVMATRIX card was
opened at 640x480 and upscaled to 1080p for the stream — "soft, blocky output that
looks nothing like the source, with no error anywhere" (root-cause note in
`nativePipeline.js`). A laptop webcam hides it, because its native mode is usually
close to what was asked for. A capture card is exactly where it bites.

**Fix.** `live-output.html` reports the negotiated `getSettings()` to a new
`POST /capture-window/camera-info`. The engine records it, says so plainly in the log,
and exposes it on `/status` and `/capture-window/status` so the operator can confirm
the real resolution **before** going live. A mode below what was requested logs a
three-line warning naming the usual capture-card causes.

Verified live: posting a simulated 640x480 open against a 1920x1080 request returns
`downgraded: true` and logs the warning; a matching 1920x1080 open logs the tick and
appears in `/status`.

### E2. One status poller instead of one per clip

`pollRenderStatus` was a detached async loop **per forwarded clip** — each sleeping 3s
and issuing its own request for up to 5 minutes. A busy over is a dozen overlapping
loops; a backlog draining at once is dozens, putting ~17 requests/second at Render
purely to ask about status, precisely while it is also uploading those clips. Nothing
bounded it and nothing cancelled it on shutdown.

Replaced with a single timer over a map of jobs, polling at most 4 per tick
round-robin, existing only while something needs polling, cleared on shutdown.

### E3. Retry timers are now tracked and cancellable

`scheduleRetry` used raw `setTimeout`s nobody held collectively. Harmless only because
shutdown ends in `process.exit(0)` — but a retry could fire and start streaming a file
to the network while the engine was mid-shutdown killing its children. They are now in
a set, cleared in `gracefulShutdown`, and both `scheduleRetry` and `processRetryEntry`
bail when `shuttingDown`.

### E4. The flush guard tracks the actual flush

`flushRetryQueueNow`'s re-entry guard released after a fixed 1 second. A backlog of 50
clips on a slow line takes far longer, so the gate re-opened while those were still in
flight and the next success could start a second overlapping flush of the same entries.
It now releases when the entries that flush started have settled.

### E5. Disk state is a value the UI can act on

The console already warned, but a warning nobody is watching during a match is no
warning. `diskHealth()` returns `ok` / `low` / `critical` / `unknown` with a message,
exposed on `/status`, `/health` and `/recording-info`; `critical` (< 2 GB) fires well
before a write fails and truncates `master.mp4`. The existing hard floor at recording
start is unchanged.

### E6. Audio is 48 kHz everywhere

Every path encoded at 44100. HDMI embedded audio — what an AV Matrix delivers — is
48000 Hz by specification, so every stage resampled 48k → 44.1k at a non-integer
160:147 ratio for the whole match, for no benefit; YouTube's own ingest recommendation
is 48 kHz AAC, so it was not buying compatibility either. Recorder, live encoder and
the compositor relay now all use `AUDIO_SAMPLE_RATE_HZ = 48000`.

**This one is a deliberate behaviour change and could not be listened to here — check
audio on the first test stream.**

## F. NVENC / RTMPS — audited by reading, found sound

The live encoder arguments are correct for a YouTube RTMPS push and need no change:
CBR with `-maxrate` equal to `-b:v` and `-bufsize` at 2x; `-g` and `-keyint_min` both
pinned to `fps × keyframeInterval`; `-bf 0`; forced CFR via whichever of
`-fps_mode`/`-vsync` the build accepts; `-max_muxing_queue_size 4096`;
`-flvflags no_duration_filesize`. NVENC uses `p4` and adds `-tune ll` only after a
runtime check that the build accepts it — a build that does not would otherwise exit
instantly on every Go Live.

ABR is a rate-limited hot-restart of the live encoder only. Because the live encoder
does its own capture, that restart cannot touch the recorder process — recording and
clips are unaffected by any bitrate or resolution change.

**Not verifiable here:** actual NVENC session behaviour, GPU scaling, RTMPS smoothness
under real packet loss, and the multi-hour soak. This container has no GPU, camera or
ffmpeg build.

## G. Still open

1. **Upload throttling under load** (brief §42). Clip cuts already run at
   below-normal priority and are capped at 2 concurrent, but the forward itself is
   not throttled when CPU/disk are saturated. Low risk — a forward is a single
   ~20 s file over HTTP, not a sustained load — but it is the one place where a
   large backlog draining could, in principle, compete with the media pipeline.
2. **Program-feed health on the native path** (README "Known gaps"). The gdigrab
   path samples real `blackdetect`/`freezedetect`; the `NATIVE_PROGRAM_FEED` path
   only checks the preview snapshot exists and is recent, so it cannot actually
   detect an all-black frame. Only affects the opt-in path, which is off by default.
3. **The README's "Known gaps" section is out of date.** It still lists "dshow
   format negotiation isn't probed" as a gap for the native path; `nativePipeline.js`
   has since grown full `-list_options` auto-detection with AVMATRIX-specific
   root-cause fixes. Worth correcting so it does not mislead before a match.

## H. If you are moving from a laptop webcam to a real camera + AV Matrix

What actually changes, and what to check:

- **Which path runs.** `NATIVE_PROGRAM_FEED` is **off** by default, so the camera is
  opened by the browser (`getUserMedia`), not by ffmpeg — same as the laptop webcam.
  The AV Matrix is just another device to that code. The native-dshow path, where
  ffmpeg opens the card directly and the AVMATRIX format auto-detection lives, only
  runs if you set `NATIVE_PROGRAM_FEED=true`.
- **Resolution is the real risk**, and it is now visible: check `/status` →
  `captureWindow.cameraInfo`, or the engine console, right after Live Output opens.
  `downgraded: true` means the card gave less than 1080p and everything is upscaling.
- **Audio moves.** HDMI audio arrives as its own dshow device, opened directly by
  ffmpeg — it is not the laptop mic any more. Select the card's audio device in the
  panel, and listen to the first test stream (also because of the 48 kHz change above).
- **No-signal is already handled** — `live-output.html` watches the track's
  `mute`/`unmute` events, which is exactly what a capture card reports when HDMI has
  no signal, and reports it to the engine.
- **Clips are unaffected by any of this.** They are cut from `master.mp4`, so the
  camera type cannot change clip behaviour.
