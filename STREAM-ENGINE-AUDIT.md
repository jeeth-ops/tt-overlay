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

### B5. WITHDRAWN — I audited the wrong panel

I reported that `CJ_ACTIVE` and `clipJobLine()` were missing the Stream Engine's
status names, and changed `cricket-panel.html` to add them.

That was wrong. `cricket-panel.html` is the **Clipper Helper** panel — its own
comment says "Live per-clip status from the local Clipper Helper" — and it never
receives Stream Engine statuses, so nothing was broken there.

The Stream Engine panel is `cricket-panel3.html` (67 references to the engine,
against 1 in `cricket-panel.html`). It has its own `clipJobStageLine()` polling
`STREAM_ENGINE_URL/clip-jobs/:clipId`, and it already handled
`WAITING_FOR_POSTROLL`, `CUTTING`, `LOCAL_SAVED`, `FORWARDING`, `RETRY_PENDING`,
`COMPLETE` and `FAILED_PERMANENT` correctly.

The change to `cricket-panel.html` has been reverted in full. The only thing
genuinely needed was `LOCAL_ONLY` — the status this audit's B3 introduced — which
is now added to `cricket-panel3.html`, where it belongs.

Lesson for the rest of this audit: this repo has several same-shaped panel files,
and matching code in one is not evidence about the one actually in use.

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

---

## I. Offline-first audit — "internet gaya to recording ruk jaati hai aur 2 parts ban jaate hain"

The rule being audited against: **REMOTE FAILURE ≠ LOCAL MEDIA FAILURE.** The
internet may only affect YouTube, R2, Drive and remote sync. Camera, program
output, master recording, clip cutting, preview, scoring, panel and overlay
must all continue without it.

### I1. YouTube judders on a 20 Mbps line — CONFIRMED, FIXED

This one is not a network problem at all, which is why more bandwidth never
helped.

```
EVENT    operator selects 60 FPS in Live Studio and goes live
  ↓
CODE     panel3 → /go-live → resolveEncodeSettings()  fps = 30 | 60
  ↓
CODE     ensureCompositor() created the Compositor with  fps: 30   ← HARDCODED
  ↓
CODE     buildLiveEncoderArgs() received fps = 60 and emitted
             -fps_mode cfr  -r 60
  ↓
PROCESS  the relay carries 30 real frames/sec; ffmpeg must fill a 60-frame
         grid, so it DUPLICATES every frame
  ↓
FAILURE  YouTube receives 60 fps of which half are duplicates: uneven
         cadence, and roughly half the CBR bitrate spent re-sending frames
         the viewer already has
  ↓
SYMPTOM  juddery/laggy stream regardless of uplink speed; YouTube Studio
         reports "not receiving enough video to maintain smooth streaming"
```

The same function already took `relayWidth`/`relayHeight` from the compositor,
with the comment *"the compositor is the authority on that"* — frame rate was
simply never given the same treatment.

**Fixed.** The program feed now runs at the rate that was actually requested
instead of a hardcoded 30, and every consumer runs at
`min(requested, programFps)` (`effectiveOutputFps`). A higher request is
clamped to what really exists; a lower one still decimates evenly (60 → 30
keeps every other frame, which is correct). Frames are never duplicated, the
GOP follows the real rate so keyframes stay 2 s apart, and the clamp is
reported in the log, on `/status` (`encoderRequestedFps` /
`encoderEffectiveFps`, `compositor.fps`) and in the panel — never silent.

### I2. The master recording splitting — root cause report

Traced honestly, and the answer is **not** what it looks like from the
outside. In native program-feed mode there is no code path where losing the
internet stops the recorder. Each of these was read and, where it is logic
rather than configuration, pinned with a test:

| Path | What it actually does |
|---|---|
| `RelayConsumer.deliver` | one object per consumer process; a dead YouTube encoder cannot touch the recorder's writes |
| back-pressure | a backed-up consumer **skips** frames; the shared source is never paused, so the recorder cannot be starved by a collapsing uplink |
| `superviseRecorder` | gated on `programFeedFlowing()` — it will not blame the recorder for a source that has stopped |
| `ensureCompositor` | never restarts a running compositor; refcounted, so stopping the stream leaves the recorder's feed alone |
| overlay Chromium dies | pacer keeps re-sending the last frame from a getter; ffmpeg never sees EOF |
| `releaseLiveOutputWindowIfUnused` | returns early while `recordingDesired` |
| panel `socket.on('disconnect')` | dims an indicator; touches nothing else |

So the two real defects were not "recording stops on network loss". They were:

1. **No boundary carried a cause.** A match that came back as
   `master.mp4` + `master_part2.mp4` was indistinguishable from one that split
   for a genuine local fault. "It splits when the internet drops" could not be
   confirmed, refuted or fixed, because nothing recorded why.
2. **The parts were the deliverable.** The operator recorded one match and was
   handed pieces to join themselves.

**Leading hypothesis for the mechanism** (stated as a hypothesis — it is not
yet proven on hardware): when the uplink dies the live encoder dies and
reconnects with backoff, churning NVENC encode sessions. Consumer GPUs cap
concurrent NVENC sessions, so the recorder's own session can fail or stall,
the 30 s stall watchdog fires, and the recorder continues in a new segment.
That is a **local** encoder fault with a remote *trigger* — which is why
`classifyBoundaryReason` deliberately classifies it local: calling it "remote"
would hide the actual defect (two encoders contending for one GPU resource).

**Fixed / instrumented:**

- `recordingSession.js` — one durable session per match
  (`recording-session.json`, atomic writes). Every part boundary is recorded
  with its reason, and the reason is **classified** local / remote / unknown.
- A boundary classified `remote` now logs
  `⛔ ARCHITECTURE VIOLATION` at the moment it happens, and shows red in the
  panel. It can no longer pass as normal.
- An engine restart mid-match **adopts** the running session instead of
  declaring a second recording.
- On stop, parts are joined losslessly back into one `master_complete.mp4`
  (concat demuxer, `-c copy` — no re-encode, no quality change, no second pass
  over a 7-hour NVENC encode). **The parts are kept**: the join is the
  convenience, the parts are the evidence, and deleting footage to tidy up is
  not a trade worth making.
- Clips are unaffected either way — they are cut from the part covering the
  moment (`findRecordingSegmentFor`), never from the joined file.

On the operator's next split, the session file names the cause. If it reads
`nvenc` or `stalled`, the hypothesis above is confirmed and the fix is to stop
the two encoders contending. If it ever reads `[remote]`, that is a real
architecture bug and the log says so.

### I3. Overlay and scoring ARE internet-dependent — NOT fixed, needs its own pass

This is the part of the brief that is genuinely not done, and it is not a
small change.

```
cricket-overlay.html:10    <script src="/socket.io/socket.io.js">
cricket-overlay.html:1507  const socket = io({ query: { room: matchId } });
server.js (compositor)     overlayUrl = `${mainServerUrl}/cricket-overlay?room=…`
```

`io()` with no URL connects to the origin the page was loaded from, and that
origin is `mainServerUrl` — the Render deployment, i.e. the internet. So:

- the overlay **page** is fetched over the internet;
- its score updates arrive over a Socket.IO connection **to the internet**;
- the scoring panel is served from, and writes to, the same remote origin.

With the line down, the video keeps recording correctly — but the overlay
freezes at the last score it received, and scoring cannot be entered or
persisted. Requirements 8–13, 34 and 35 of the brief are therefore **not met**
and cannot be met by anything in the Stream Engine alone. Doing it properly
needs:

1. the Stream Engine serving `cricket-overlay` and a **local** Socket.IO on
   localhost, so the compositor's Chromium never needs the internet;
2. the panel writing to a **local authoritative match state** first, with the
   remote server as a follower;
3. durable local persistence of that state (ball-by-ball, striker, bowler,
   extras, over state);
4. idempotent sync on reconnect — stable `matchId`/`inningsId`/`ballId` plus a
   local sequence number, so nothing is replayed, duplicated or reverted.

That is the next pass, and it should be taken as one piece of work rather than
bolted on.

### I4. What could NOT be verified in this container

Stated plainly rather than as "should work":

- there is **no ffmpeg build, no capture device and no GPU** here, so the
  offline integration test (brief §31–§33) — cut the internet, record, score,
  cut clips, restore, verify the master's duration/speed/sync — has to be run
  on the operator's PC;
- the frame-rate clamp, the timebase measurement and the lossless join are
  verified as **logic** (58 unit tests across six suites) and as ffmpeg
  argument construction, not as rendered video.

What to run on the match PC, in order:

1. Record for a minute and read **FPS (req/actual)** in the panel — it must
   say `1.00× real time`.
2. Read **Program feed** — it must match what you selected; if it is amber,
   the feed cannot produce the selected rate and the reason is in the tooltip.
3. Pull the network cable for 10 minutes while recording, scoring and cutting
   clips. Restore it.
4. Stop recording. **Master file** should say `one continuous recording`, or
   `✓ one master (master_complete.mp4, from N parts)` with the boundary
   reasons in its tooltip — and none of them may read `[remote]`.

---

## J. Panel 3 camera format — verified against the real device request, not the dropdown

Two bugs survived adding the dropdowns, and both were in the step that
actually talks to the AVMATRIX card.

### J1. A 720×480 program was asking the card for 720×480 — CONFIRMED, FIXED

```
EVENT    operator selects 720×480 output
  ↓
CODE     ensureCompositor() → Compositor{ width:720, height:480 }
  ↓
CODE     probeCameraMode() → pickCameraMode(out, this.width, this.height, this.fps)
             …whose sort prefers  area <= targetArea
  ↓
PROCESS  -video_size 720x480 is handed to dshow
  ↓
FAILURE  the HDMI source is 1920×1080 and the engine discarded it AT THE
         DEVICE, inside the card's firmware, before any filter of ours could
         do a controlled downscale — and on a card that may not offer the
         mode at all, the open simply fails
  ↓
SYMPTOM  soft/low-detail 720×480, or a camera that will not open
```

**Fixed** with `pickCaptureMode()` — a separate picker for a separate
question. It takes the **largest** mode the device offers that can genuinely
carry the required capture rate (still honouring the raw-USB-bandwidth cap and
the compressed-mode preference), with the output size as an optional *ceiling*
rather than a target. The card keeps its native format; the compositor scales
once, with a filter we choose. `Compositor.captureTarget` now carries that
question explicitly, separate from the program format.

### J2. 50i was asking the device for 50 — CONFIRMED, FIXED

`this.fps` is the **program** rate. For 50i that is 50, because each field
becomes a frame. But 50i is 50 **fields** = 25 interlaced **frames**, and
dshow counts frames — so the device was being asked for a mode it does not
have. **Fixed:** the video mode now carries `captureFps` (25 for 50i) and
`programFps` (50) as separate numbers, and the device request uses the capture
rate.

### J3. Frame-rate conversion inventory (brief §19)

Every place the rate changes, after the fix. The goal was exactly one
deliberate conversion, and that is now what there is:

| Stage | Rate | Conversion |
|---|---|---|
| camera input | `-framerate` = the device's real chosen mode | none — plus `-use_wallclock_as_timestamps` so frames are timed by arrival |
| compositor filter | `fps=<programFps>` | **the one conversion**: capture rate → program rate (after `yadif` for 50i, before nothing else) |
| preview branch | `fps=15` | separate `split` branch — decimated for the panel, never feeds the program |
| overlay input | `-framerate 15` | its own input, composited; not a rate change to the camera |
| relay | raw NUT | none |
| recorder | `-r min(requested, programFps)` | **no-op at matching rates** |
| live/RTMPS | `-fps_mode cfr -r min(requested, programFps)` | **no-op at matching rates** |

Before this work there were three conflicting declarations in that chain: the
device asked for one rate, the compositor hardcoded 30, and the encoders were
told the operator's selection — the classic `50p capture → 25 in → 50 filter →
25 encoder` shape the brief names, which is what produced fast playback and
judder.

### J4. Requested vs actual, and what is still unproven

`/status.captureMatch` compares what the device was **asked** for against what
the timebase measurement says is really **arriving**, and the panel shows
`✓ MATCHED` or `⚠ MISMATCH — asked 50, getting 25`. A selection is never
displayed as if it were a measurement.

Honest status on the four profiles. The **logic** is verified — 91 unit tests
across eight suites, including `pickCaptureMode` driven against real
`-list_options` text from an AVMATRIX-shaped device. The **picture** is not,
and cannot be from here: this container has no ffmpeg build, no capture device
and no GPU. So none of the four profiles is claimed as verified end to end:

| Profile | Logic | Real feed |
|---|---|---|
| 1920×1080 / 25p | verified | needs the match PC |
| 1920×1080 / 50p | verified | needs the match PC |
| 1920×1080 / 50i | verified | needs the match PC |
| 720×480 / 25p | verified | needs the match PC |

Per profile, on the match PC: select it, read **CAPTURE CHECK** (must say
MATCHED), record one minute and confirm the file is about one minute long, and
watch the preview for cadence. A MISMATCH row names the real rate, which is
the number that says which mode the card is genuinely in.

---

## K. Laptop camera works, Sony → AVMATRIX does not — the first divergence, proven

The laptop webcam is the control: the same Stream Engine code downstream,
working end to end. So the question was never "is the Stream Engine
broken?" but **"what does the AVMATRIX source make the SAME code do
differently, and at which stage first?"**

Every claim below was either run against real ffmpeg 7.0.2 (the Windows
"full" build is the same codebase) or is marked as not verified. The
container has no Windows, no capture card and no GPU, so the camera was
replaced by real-time lavfi sources that behave like each device —
everything downstream of the camera is the real code, real processes.

### K0. The pipeline as implemented (native program feed)

```
CAMERA dshow  ──┐ raw YUY2 1920×1080 @ 60.0002 (AVMATRIX: every mode fixed at 60)
AUDIO  dshow  ──┤ pcm 48 kHz
OVERLAY png   ──┤ Chromium screencast → Node OverlayPacer → TCP, 15 fps
                ▼
COMPOSITOR ffmpeg (one process, CPU filters)
  camera: [normalize chain] → [scale if needed] → yuv420p
  overlay: scale → rgba ;  overlay=format=auto → yuv420p
  ├─ relay  : -fps_mode cfr -r <program>  rawvideo+pcm in NUT → Node stdout
  ├─ preview: MJPEG 960 px → TCP → /capture-preview
  └─ meter  : 64×36 point-sampled copy of every RAW camera frame → showinfo  (NEW)
                ▼ Node NutUnitSplitter / RelayConsumer (bounded, skip-on-backlog)
   ├─ RECORDER ffmpeg: h264_nvenc VBR (libx264 fallback), 2 s GOP, fMP4 → master.mp4
   └─ LIVE     ffmpeg: h264_nvenc CBR, -bf 0, 2 s GOP, FLV → RTMPS
CLIPS: cut from master.mp4 (never from YouTube); R2/Drive retry queue offline-safe
```

GPU/CPU: capture, normalization, scale, overlay blend and pixel-format
conversion are CPU (swscale — this PC reports "GPU scale not available");
NVENC does only the two encodes. There is no GPU→CPU readback anywhere;
the costly moves are the raw relay through Node pipes (~93 MB/s at
1080p30, ~155 MB/s at 1080p50) and two raw copies into two encoders.

### K1. ROOT CAUSE 1 — the rate filter picks the wrong frame on a 2:1 source

The compositor turned the capture rate into the program rate with
`fps=<program>`. The fps filter anchors its output grid on the **first**
frame. On an exact 2:1 source (AVMATRIX 60 → 30p, or 50 → 25p) every odd
source frame then lies exactly on a rounding edge, and the smallest
timestamp difference decides which frame of each pair is shown.

Measured with the real filter (source frame number written into the
picture, read back from the output; 20 s each):

| Source → program | Chain | Camera steps seen | Verdict |
|---|---|---|---|
| **webcam 30 → 30** (control) | `fps=30` | 1×599 | clean |
| 60 → 30, no jitter | `fps=30` | 1×200 **2×199** 3×200 | **judder** |
| 60 → 30, ±2 ms jitter | `fps=30` | 1×116 **2×366** 3×117 | **judder (39 % wrong)** |
| 60 → 30, any jitter tested | `framestep=2` | **2×599** | clean |
| 50 → 25, ±2 ms | `fps=25` | 1×98 2×303 3×98 | judder |
| 50 → 25, ±2 ms | `framestep=2` | 2×499 | clean |

The webcam never decimates (30 → 30), so it sits in the middle of the
rounding window and is immune. **That is the first divergence between the
two paths**: identical code, a source that needs decimation, and a filter
that is unstable exactly there. Through the full end-to-end pipeline
(K5) the old chain showed wrong-neighbour picks on 0.3–1.5 % of frames
across runs at the low jitter of this Linux box — how often depends entirely
on real timestamp jitter, which is why `test/decimationCadence.test.js`
asserts it deterministically (seeded jitter) instead.

**Fix:** decimation by **count** — `framestep=k` whenever the source rate is
an integer multiple of the program rate. `fps=` remains only for uneven
ratios, which are now reported as judder rather than hidden.

### K2. ROOT CAUSE 2 — a 50 Hz camera behind a 60-only card is 50 fps of motion, not 60

The field console showed every AVMATRIX mode fixed at 60.0002 fps. An
Indian (PAL) Sony outputs 25/50 Hz. A card that only offers 60 has to put
50 camera frames into 60 slots: one repeat in every six. Measured:

| Program | Chain | Camera steps | Verdict |
|---|---|---|---|
| 30p (the previous HOW-TO-CHECK advice) | `fps=30` | 1×236 2×326 3×37 | judder |
| 30p | `framestep=2` | 1×200 2×399 | judder — **cannot** be smooth |
| **50p** | `decimate=cycle=6` | 1×999 | clean |
| **25p** | `decimate=cycle=6,framestep=2` | 2×499 | clean |

**The previous "use 30p on this card" advice was only right if the card is
really carrying 60 fps.** Whether it is depends on the Sony's HDMI output,
which only a measurement can settle — so it is now measured (K4).

### K3. ROOT CAUSE 3 — the inputs had different clocks; every camera frame waited for the overlay

ffmpeg opens inputs one after another and, without `-copyts`, moves each
input's first packet to t = 0 on its own. Measured in the real compositor:

```
0.06 s  Input #0 camera opened        ← camera t=0 here
0.06 s  Input #1 audio opened
7.93 s  Input #2 overlay pipe opened   ← overlay t=0 here
```

The overlay filter cannot emit camera frame *t* until the overlay has a
frame at *t*, so **every camera frame waited 7.9 s**. With the 512-packet
queue this needs ~2 GB at 1080p60 and puts the program ~8 s behind
reality; with anything smaller the queue fills, dshow drops, and the feed
moves in bursts between freezes (reproduced: "More than 1000 frames
duplicated" and the camera meter receiving < 1 fps). A 60 fps card needs
twice the queue a 30 fps webcam does to ride out the same gap. The same
per-input zero put **audio** off the video by however long the audio
device took to open.

**Fix — one program clock:** overlay, audio and camera are all stamped by
the same clock (arrival wall time), `-copyts` keeps those stamps, and one
common `-itsoffset` subtracts the same base from all three. The camera is
opened **last**, so when it starts, overlay and audio are already flowing
and nothing it produces waits. The overlay input also probes only its first
PNG (`-probesize 32 -analyzeduration 0`): startup 7.95 s → 4.3 s. The
camera queue is now bounded to 0.5 s.

### K4. The capture stage is measured, not assumed

`sourceProbe.js` opens the device for 4 s **before** the compositor does
(once per device + mode + program rate) and measures, per frame: wall-clock
arrival, the device's own timestamp, a checksum of a point-sampled
thumbnail (identical successor = repeated frame) and idet on the full
picture; plus the negotiated media type read back from ffmpeg and every
dshow overflow. From that it builds the **normalization plan**:

```
[decimate=cycle=N]  only if the card repeats frames
[yadif send_field]  only if the PIXELS are interlaced — never because "50i" was selected
[passthrough | framestep=k | fps (judder, warned)]
```

Two further defects this replaced:

- **"50i" selected on this card bobbed progressive frames.** 60 progressive
  frames/s were deinterlaced as if they were 25 interlaced ones: half the
  vertical detail, 120 fields/s into an uneven 2.4:1 decimation, and yadif at
  1080p120 on the CPU. Measured: 20 % repeated program frames. Now decided
  by idet, and without a measurement only if the device really runs ≤ 30.
- **CAPTURE CHECK could not fail.** It compared the request against the
  *recorder's* output clock, which after the relay's CFR grid is ~1.0× no
  matter what the camera does. It now uses the **capture meter** inside the
  compositor: a 64×36 copy of every raw camera frame → arrival fps,
  timestamp rate, unique frames, gaps, overflow drops. `/status` also gained
  `failureClasses` (CAPTURE → PROCESSING → ENCODER → NETWORK → PREVIEW, each
  from its own measurement), and `compositor.relay.relayMBps` is now measured
  (it used to print the theoretical value whenever any byte had arrived).

Also found and fixed on the way:

- **The "transparent" placeholder overlay was 50 % blue.** Its bytes decode
  to RGBA (0, 0, 255, 127), scaled over the whole frame until the overlay
  page delivered its first frame — or for the entire match if
  puppeteer/Chromium was unavailable. Found because every camera value in
  the simulation came back at ~0.45× + an offset. Pinned by a test.
- **The preview juddered on its own.** It was a flat `fps=15` — a 2:1 knife
  edge on 30p and 3.33:1 on 50p — so the operator saw stutter even when the
  program was clean. Now an integer `framestep` (25/30p at full rate,
  50/60p at half).

### K5. End-to-end result (real Compositor + recorder, simulated devices)

`test/pipelineSimulation.test.js`, 20 s of recording each, file checked by
`verifyMedia.js`:

| Source → program | Chain chosen by the probe | File vs real time | A/V | Camera steps |
|---|---|---|---|---|
| **webcam 30 → 30** (control) | passthrough | 1.002× | +0.13 s | 1×592 (+3) |
| 60 card → 30, **old chain** | `fps=30` | 0.998–0.999× | +0.15 s | 2×575, **2–9 odd steps per run** |
| 60 card → 30 | `framestep=2` | 1.003× | +0.13 s | 2×584, odd 0 |
| Sony 50 → 60 card → 50 | `decimate=cycle=6` | 0.998× | +0.07 s | **1×993** |
| Sony 50 → 60 card → 25 | `decimate=cycle=6,framestep=2` | 0.997× | +0.17 s | 2×490 |
| Sony 50 → 60 card → 30 | `decimate=cycle=6,fps=30` | 0.998× | +0.14 s | 1×198 2×394 — **flagged JUDDER** |
| card stamping 50 as 60 → 50 | passthrough (stamps flagged nominal) | 0.999× | +0.09 s | 1×977 |

"A/V" is audio duration minus video duration in the file (both streams
start at the recorder's join point, so this includes the audio packet
that straddles it) — it is not a lip-sync measurement; see K7.

The small residue of 0/2 steps in the 1:1 rows (≈ 0.5 %) is the relay's CFR
grid meeting arrival-time jitter on this container. It is the same in the
control, so it is not specific to the capture card.

### K6. What to run on the match PC

```
cd stream-engine
node sourceProbe.js --list
node sourceProbe.js --compare "<laptop camera name>" "AVMATRIX USB Capture Video" --program-fps 50 --out compare.json
```

That prints the §6 table (device, resolution, requested/negotiated/actual
fps, unique fps, scan mode, pixel format, timestamps, interval, drops,
repeats, CPU, old vs new chain) and `FIRST POINT OF DIVERGENCE`. Run it with
the Sony set to each output mode you intend to use. The same probe runs
automatically when the program feed starts and prints to the console;
`POST /diagnostics/source-probe` and `GET /diagnostics/source-compare` do it
from the panel side. After a test recording:

```
node verifyMedia.js "StreamEngineData\Recordings\<match>\master.mp4" --expect-seconds 3600
```

### K7. NOT verified here — genuinely open

- **The real AVMATRIX + Sony numbers.** Everything above proves the
  mechanisms and the fixes against simulated devices. Which of K1/K2 (or
  both) the operator's card actually exhibits is exactly what
  `sourceProbe.js --compare` answers on the match PC — nothing here claims it.
- **Wall-clock precision on Windows.** The program clock is arrival time.
  If this PC's clock ticks at 15.6 ms, 50/60p 1:1 passthrough will show
  occasional dup/drop pairs; the capture meter reports the jitter
  (`CAPTURE: camera timestamps jitter ±X ms`) so it cannot hide.
  `STREAM_ENGINE_WALLCLOCK_TS=0` returns to device stamps (per-input clocks).
- **Lip sync** is correct by construction (one clock for audio and video)
  but was not measured with a real flash-and-beep source through the card.
- **NVENC, GPU load, RTMPS under real loss, the 7-hour soak, internet
  loss/recovery** — unchanged by this pass and still need the match PC. The
  probe adds a few seconds to the FIRST start of the program feed per
  device/mode (cached afterwards); `STREAM_ENGINE_SOURCE_PROBE=0` skips it.
- **Overlay and scoring still need the internet** (§I3) — unchanged.
