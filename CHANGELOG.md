# Changelog

## 1.0.0
- First release: HomeKit switches that speak configured sentences on HomePods.
- Voice engines: ElevenLabs, Google Cloud (Chirp 3 HD), Microsoft Edge, Google Translate, with automatic fallback.
- Audio cache with automatic cleanup and pre-generation at startup.
- Per-announcement speakers and volume, with previous volume restored.
- Optional webhook (`/say`, `/announce`, `/status`) with token, for iPhone Shortcuts.
- No install scripts — clear instructions when pyatv is missing.
