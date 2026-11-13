# Changelog

## 1.5.2
- Fix: a burst of triggers on one switch (e.g. an automation loop) no longer makes the HomePod repeat the phrase over and over. Repeats are ignored while it plays and for 10 seconds after (setting: *Repeat guard*), with a warning in the log.
- At most 5 announcements can wait in line per HomePod.

## 1.5.1
- Homebridge verification checks: `supports-hap` keyword, standard `required` arrays in the config schema, no environment-variable access.

## 1.5.0
- **New (optional): all switches in one group** — one accessory in Apple Home (default name "קבצי הקול שלי") with a switch for each phrase inside. Off by default.

## 1.4.1
- Stability: if the voice helper exits at the exact moment a phrase is sent, the error is now logged instead of being able to stop Homebridge.
- New blue-and-white icon.

## 1.4.0
- The voice engine (pyatv) now lives in the Homebridge storage directory (`homepod-israel-hebrew-engine`), so it is part of Homebridge backups. It is set up again automatically on first start (a few minutes); the old `~/.homepod-israel-hebrew` folder is removed once the new one is ready.
- Prepared for "Verified by Homebridge".

## 1.3.1
- Docs: step-by-step Cartesia key guide (Hebrew and English).
- Docs: every voice provider is now marked free 🆓 or paid 💳, with a note that no payment is needed.

## 1.3.0
- **Voice cloning:** upload a short recording and the HomePod speaks in your own voice (ElevenLabs Instant Voice Clone).
- **Cartesia:** native Hebrew voices — paste the key, tap "Load Hebrew voices" and add the ones you like.
- **OpenAI:** 13 voices (gpt-4o-mini-tts) that follow the speaking style as an instruction.
- Gemini key guide: new `AQ.` key format, "Import projects" window.

## 1.2.0
- Voices that really sound different: 16 Gemini voices (free API key, no credit card) — men and women, each with its own character.
- Speaking styles for every phrase: cheerful, calm, whisper, announcer, urgent, warm, excited, playful. Gemini really performs them; ElevenLabs v3 gets matching audio tags; Microsoft voices get a stronger speed/pitch change.
- Voice and style are now two separate choices (old presets are converted automatically).
- A sleeping HomePod that drops the first connection is retried automatically.
- New plugin icon.
- Faster announcements: a fast mode keeps the voice engine loaded and remembers where each HomePod is, so playback starts without Python start-up or a network search (HomePods are located once at startup). Falls back automatically if needed.
- Settings screen: no more "Not connected to the Homebridge UI server" error while the backend is still starting — requests retry automatically.

## 1.1.0
- New bilingual settings screen — Hebrew by default, with an English toggle.
- Choose which HomePods speak for every phrase (one, several or all together), plus voice and volume per phrase.
- "Find HomePods" button (automatic discovery) and "Play now" test button.
- Voice catalog: Hila and Avri in several styles, multilingual voices, 16 Google Chirp 3 HD voices, ElevenLabs.
- Fully self-contained: the plugin installs and maintains its own pinned pyatv environment — no manual steps, no other plugins.
  Fixes the srptools 2.x incompatibility ("SRPClientSession takes 2 positional arguments").
- Faster playback: one connection per announcement (volume, play, restore) through a small helper.
- 1.0 configs are upgraded automatically.

## 1.0.0
- First release: HomeKit switches that speak configured sentences on HomePods.
- Phrases list: just type the text — each phrase becomes its own switch.
- Voice engines: ElevenLabs, Google Cloud (Chirp 3 HD), Microsoft Edge, Google Translate, with automatic fallback.
- Audio cache with automatic cleanup and pre-generation at startup.
- Per-announcement speakers and volume, with previous volume restored.
- Optional webhook (`/say`, `/announce`, `/status`) with token, for iPhone Shortcuts.
- No install scripts — clear instructions when pyatv is missing.
