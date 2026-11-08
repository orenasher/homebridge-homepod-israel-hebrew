<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-homepod-israel-hebrew"><img src="https://img.shields.io/npm/v/homebridge-homepod-israel-hebrew?color=F99211" /></a>
  <a href="https://paypal.me/orenasher"><img src="https://img.shields.io/badge/donate-PayPal-red" /></a>
</p>

# HomePod Israel Hebrew

**Natural-sounding spoken announcements on your HomePods — from Apple Home switches, automations, Siri and iPhone Shortcuts.**

🇮🇱 [מדריך מלא בעברית](README.he.md)

Every announcement you configure becomes a **switch** in Apple Home. Turn it on — by tapping, by Siri, or from any automation (washing machine finished, door opened, AC on with a window open…) — and your HomePod speaks the sentence in a natural voice, then the switch turns itself off.

## Highlights

- **Voices that sound like people, not like Siri** — choose ElevenLabs (most human), Google Chirp 3 HD (very clear) or free Microsoft Edge neural voices. Excellent Hebrew.
- **Automatic fallback** — if your main voice service fails, it falls back to a free voice so the announcement still happens.
- **Audio cache** — every sentence is generated once and stored. Repeats are instant, work even if the voice service is down, and premium services cost you almost nothing.
- **Any text from Shortcuts** — an optional webhook lets you announce dynamic text (`"Yotam just got home"`, weather, reminders).
- **Volume per announcement** — speaks at the level you choose, then restores the previous volume.
- **Several HomePods at once**, with a queue so announcements never talk over each other.
- **Nothing is installed behind your back** — no install scripts. The plugin tells you exactly what to install.

## How it works

```
HomeKit switch / Siri / automation / webhook
        → text-to-speech (ElevenLabs / Google / Edge)  → cached MP3
        → pyatv streams it over AirPlay → HomePod speaks
```

Apple doesn't let third parties use the HomePod Intercom, so the plugin streams audio over AirPlay (like playing music). Whatever was playing on the HomePod stops for the announcement.

---

## Step-by-step setup

### 1. Install pyatv (one time)

pyatv is the free Python library that talks AirPlay to HomePods. Open the **Homebridge terminal** (Homebridge UI → ⋮ menu → Terminal) or SSH, and paste:

```bash
sudo apt install -y python3-venv
sudo python3 -m venv /opt/pyatv
sudo /opt/pyatv/bin/pip install pyatv
```

This installs it in its own folder (`/opt/pyatv`) so it can't break anything else. The plugin finds it automatically.

### 2. Find your HomePods

```bash
/opt/pyatv/bin/atvremote scan
```

For each HomePod note the **Name**, **Address** (IP) and one of the **Identifiers**. Tip: give each HomePod a fixed IP in your router.

### 3. Install the plugin

Homebridge UI → **Plugins** → search **homebridge-homepod-israel-hebrew** → Install.

### 4. Configure

In the plugin settings:

1. **Speakers** — add each HomePod: a name you choose (e.g. `Kitchen`), its IP, its ID, and an optional default volume.
2. **Announcements** — add sentences: switch name (`Laundry done`), the text, which speakers (empty = all) and volume.
3. **Voice** — pick the engine (see below). The free Edge voice works without any key.

Save and restart Homebridge. The switches appear in Apple Home.

### 5. Use it

- Tap the switch, or say *"Hey Siri, turn on Laundry done"*.
- Apple Home → Automation → e.g. *"When the washing machine power drops"* → turn on **Laundry done**.

---

## Choosing a voice

| Engine | Quality | Cost | What you need |
|---|---|---|---|
| **ElevenLabs** | Most human, expressive | Free tier, then paid | API key + voice ID |
| **Google Chirp 3 HD** | Very clear, natural | Free monthly tier | Google Cloud API key |
| **Microsoft Edge** | Good, clear (Hila / Avri for Hebrew) | Free | Nothing |
| **Google Translate** | Basic | Free | Nothing (used as last-resort fallback) |

Because of the cache, fixed announcements are generated only once — so even a paid voice costs almost nothing.

### ElevenLabs
1. Sign up at [elevenlabs.io](https://elevenlabs.io) → profile → **API Keys** → create a key.
2. Pick a voice in the **Voice Library**, add it to your voices and copy its **Voice ID**.
3. In the plugin: engine = ElevenLabs, paste the key and voice ID. Keep model `eleven_v3` and language `he` for Hebrew.

### Google Chirp 3 HD
1. In [Google Cloud Console](https://console.cloud.google.com) create a project and enable **Cloud Text-to-Speech API** (billing account required; the free tier covers home use).
2. **APIs & Services → Credentials → Create API key** (restrict it to the Text-to-Speech API).
3. In the plugin: engine = Google, paste the key, choose a voice (Kore, Aoede, Charon…).

---

## Webhook — say any text from iPhone Shortcuts

Enable **Webhook** in the settings (port `8095`) and set a token.

| Request | What it does |
|---|---|
| `GET /say?text=Hello&speakers=Kitchen,Bedroom&volume=50&token=…` | Say any text |
| `POST /say` with JSON `{"text":"…","speakers":"Kitchen"}` | Same, for long text |
| `GET /announce?name=Laundry done&token=…` | Play a configured announcement |
| `GET /status?token=…` | Speakers and announcements |

Extra parameters: `engine`, `voice`, `wait=0` (answer immediately without waiting for playback).

**Shortcut example:** *Text* → *Get Contents of URL* `http://<homebridge-ip>:8095/say`, Method **POST**, Request Body **JSON**: `text` = the text, `token` = your token.

---

## Example config

```json
{
  "platform": "HomePodIsraelHebrew",
  "name": "HomePod Israel Hebrew",
  "speakers": [
    { "name": "Kitchen", "host": "192.168.1.50", "id": "AA:BB:CC:DD:EE:FF", "volume": 45 },
    { "name": "Bedroom", "host": "192.168.1.51", "id": "11:22:33:44:55:66" }
  ],
  "announcements": [
    { "name": "Laundry done", "text": "The laundry is done", "speakers": ["Kitchen"], "volume": 60 },
    { "name": "Dinner", "text": "Dinner is ready!" }
  ],
  "tts": { "engine": "edge", "edgeVoice": "en-US-AvaNeural" },
  "webhook": { "enabled": true, "port": 8095, "token": "change-me" }
}
```

## Troubleshooting

- **"pyatv (atvremote) was not found"** — do step 1, then restart Homebridge.
- **"Could not find any device"** — set the HomePod's IP in `host`, and check that Homebridge and the HomePod are on the same network.
- **Pairing/permission error** — Home app → Home Settings → *Allow Speaker & TV Access* → *Everyone on the same network*.
- **Changed a voice and still hear the old one?** — the cache is keyed by voice, so changes take effect immediately; old files are cleaned automatically.
- Audio files are stored in `<homebridge storage>/homepod-israel-hebrew-cache` — safe to delete anytime.

## Support

If this plugin is useful to you, [buy me a coffee ☕](https://paypal.me/orenasher). Issues and ideas: [GitHub](https://github.com/orenasher/homebridge-homepod-israel-hebrew/issues).

MIT © Oren Asher
