# Changelog

## 1.1.1
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
