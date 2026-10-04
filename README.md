# FocusDJ

**A Chrome extension that notices when you lose focus while studying and
changes your music to pull you back.**

FocusDJ watches for the signs of drifting: tab hopping, doomscrolling, going
idle, looking away from the screen. It turns them into a live focus score,
and when the score drops it steps in through YouTube Music, then learns which
kind of nudge actually works for you.

## How it works

```
Signals                      Focus score            Decision                 Action
tab switches, site type,  →  0 to 100, updated   →  intervene? which one?  →  YouTube Music
idle time, scrolling,        every few seconds      (UCB1 bandit)             or a popup
webcam (optional)
                                    ↑                                            │
                                    └────── reward: did focus improve? ──────────┘
```

### Focus score

The score starts at 100 and loses points for each sign of distraction
(`extension/src/background/focus_model.js`):

| Signal | Effect |
|--------|--------|
| Tab switching in the last minute | Up to 35 points |
| Being on a distracting site | Scaled by category: social media, games, entertainment |
| Scrolling a distracting site | Doomscroll penalty, up to 25 points |
| Long stretches on distracting sites | Up to 20 points |
| No mouse or keyboard activity | Up to 20 points after a grace period |
| Face away from the screen (webcam, opt-in) | Up to 25 points |
| Productive site, active typing | Small bonuses |

Three modes (gentle, normal, strict) change how quickly penalties build.

### Interventions

| Intervention | What it does |
|--------------|--------------|
| Smart recommend | Plays a track picked for your focus history and tempo preferences |
| Boost energy | Skips to the next track |
| Pattern break | Pauses briefly, then resumes |
| Viola popup | A nudge on the page from Viola, the built-in assistant, when you're on a distracting site |
| Nuclear | Max volume for a few seconds. Strict mode only, and off by default |

### Learning what works

Choosing a music intervention is a multi-armed bandit problem, solved with
UCB1 (`extension/src/background/decision_engine.js`):

1. Each intervention is an arm with a running average reward.
2. About 45 seconds after an intervention, FocusDJ measures how much the focus
   score changed and converts it to a reward between 0 and 1.
3. UCB1 picks the arm with the best average plus an exploration bonus, so an
   intervention that keeps failing fades out while rarely tried ones still get
   a chance.

Over a few sessions the extension settles on what brings you, specifically,
back on task.

## Setup

1. Clone this repo.
2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**,
   and select the `extension` folder.
3. Open [music.youtube.com](https://music.youtube.com) and start a playlist.
4. Click the FocusDJ icon, choose a mode, and start a session.

Optional: add a [Groq](https://console.groq.com) API key on the options page
to turn on AI site categorization and track recommendations, and a
[SerpAPI](https://serpapi.com) key for tempo lookups. Without keys the
extension uses its built-in site lists and skips to the next track.

## Development

```bash
npm test              # unit tests for the focus model and decision engine

cd web
npm install
npm run dev           # onboarding and settings dashboard
```

The tests need only Node 20 or newer; there are no dependencies to install.

## Project structure

```
extension/
  manifest.json                 Chrome MV3 manifest
  src/background/
    service_worker.js           Orchestrates sensing, scoring, and acting
    focus_model.js              Focus score
    decision_engine.js          When to intervene and the UCB1 bandit
    recommendation_engine.js    Track recommendations
    music_controller.js         Talks to the YouTube Music tab
    storage.js                  State, settings, site categories
  src/content/
    ytm_controller.js           Controls the YouTube Music page
    activity_tracker.js         Mouse, keyboard, and scroll activity
    viola_popup.js              On-page nudge
  src/ui/                       Popup, options, and camera pages
web/                            React dashboard for onboarding and settings
tests/                          Unit tests
```

## Privacy

- Focus scoring, the bandit, and face detection all run in your browser.
  Webcam frames are never stored or sent anywhere.
- Everything FocusDJ learns stays in `chrome.storage.local`.
- If you add API keys, site hostnames and track titles are sent to Groq and
  SerpAPI to categorize sites and pick music. Without keys, nothing leaves
  the browser.

## Team

Built by [@IshaJ721](https://github.com/IshaJ721) and
[@afafMaliha0716](https://github.com/afafMaliha0716). This is a fork of
[IshaJ721/focus-dj](https://github.com/IshaJ721/focus-dj).
