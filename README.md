<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-homepod-israel-hebrew"><img src="https://img.shields.io/npm/v/homebridge-homepod-israel-hebrew?color=F99211" /></a>
  <a href="https://paypal.me/orenasher"><img src="https://img.shields.io/badge/donate-PayPal-red" /></a>
</p>

# HomePod Israel Hebrew

**Natural-voice spoken announcements on your HomePods — from Apple Home switches, Siri and automations. Built for Hebrew, works in English too.**

🇮🇱 [מדריך בעברית](README.he.md) (default language of the plugin)

Type a sentence → it becomes a switch in Apple Home → turn it on and the HomePod says it. For every sentence you choose which HomePod speaks (one, several or all together), which voice and what volume.

## Highlights

- 🇮🇱 **Made for Israelis** — Hebrew by default, bilingual settings screen (Hebrew / English toggle).
- 💬 **One phrase = one switch.**
- 🔊 **Pick the HomePods per phrase** — kitchen only, bedroom only, or both together.
- 🎙️ **Many voices** — free Hila & Avri in several styles (natural, calm, bright, deep), multilingual voices, 16 Google Chirp 3 HD voices and ElevenLabs.
- ▶️ **Test playback** right from the settings screen.
- 🔍 **Automatic HomePod discovery** — no IP hunting.
- 🔁 **Cache & fallback** — each phrase is generated once; if a voice service fails it falls back to a free voice.
- 🔗 **Webhook** — say any text from iPhone Shortcuts.
- 🧩 **Fully self-contained** — no other plugins, nothing to install by hand.

## Independence & backup

- The plugin **installs and maintains its own AirPlay engine** (pyatv) in a private environment with pinned, known-good versions. No commands to run.
- **Settings** live in the Homebridge config and **audio files** in the Homebridge storage folder — both are part of the Homebridge **backup**.
- Restore Homebridge from a backup and everything comes back; the voice engine rebuilds itself on first start.

---

## Step-by-step setup

1. **Install** — Homebridge UI → **Plugins** → search **homebridge-homepod-israel-hebrew** → **Install**.
2. **Voice engine** — open the plugin settings (⚙️). If the badge says *"Voice engine not installed"*, tap **Install voice engine** and wait a few minutes (one time).
3. **Add HomePods** — tap **🔍 Find HomePods**, then **Add** next to each. Rename them and set a default volume if you like. Tip: give each HomePod a fixed IP in your router.
4. **Write phrases** — tap **➕ Add phrase**. Type the text, tick **who speaks** (none ticked = all), pick a voice, optionally a custom volume, and tap **▶️ Play now** to hear it.
5. **Save** and restart Homebridge. The switches appear in Apple Home.
6. **Use it** — tap the switch, ask Siri, or trigger it from an Apple Home automation.

---

## Voices

| Voice | Type | Cost |
|---|---|---|
| 👩 Hila — natural / calm / bright / soft | Native Hebrew | Free |
| 👨 Avri — natural / deep / calm / quick | Native Hebrew | Free |
| 👩👨 Ava, Emma, Seraphina, Andrew, Brian, Remy | Multilingual (may have an accent) | Free |
| 👩👨 16 Google Chirp 3 HD voices | Very clear Hebrew | Google key (free tier) |
| ⭐ ElevenLabs | Most human | ElevenLabs key (free tier) |

Thanks to the cache each phrase is generated only once, so even paid voices cost almost nothing.

**ElevenLabs:** sign up at [elevenlabs.io](https://elevenlabs.io) → **API Keys** → create a key; pick a voice in the **Voice Library** and copy its **Voice ID**; paste both under **Premium voices** and choose the **ElevenLabs** voice.

**Google Chirp 3 HD:** in [Google Cloud Console](https://console.cloud.google.com) enable **Cloud Text-to-Speech API**, create an API key (restrict it to Text-to-Speech), paste it under **Premium voices** and choose a Google voice.

---

## Webhook — say any text from iPhone Shortcuts

Enable **Webhook** in the settings (default port `8095`) and set a token.

| Request | What it does |
|---|---|
| `GET /say?text=Hello&speakers=Kitchen,Bedroom&voice=avri&volume=50&token=…` | Say any text |
| `POST /say` with JSON `{"text":"…","speakers":"Kitchen"}` | Same, for long text |
| `GET /announce?name=Laundry done&token=…` | Play a configured phrase |
| `GET /status?token=…` | State, HomePods and phrases |

Shortcut: *Text* → *Get Contents of URL* `http://<homebridge-ip>:8095/say`, Method **POST**, Request Body **JSON** with `text` and `token`.

---

## Config example (for reference — the settings screen writes this for you)

```json
{
  "platform": "HomePodIsraelHebrew",
  "name": "HomePod Israel Hebrew",
  "language": "he",
  "voice": "hila",
  "speakers": [
    { "name": "Kitchen", "host": "192.168.1.50", "id": "AA:BB:CC:DD:EE:FF", "volume": 50 },
    { "name": "Bedroom", "host": "192.168.1.51", "id": "11:22:33:44:55:66" }
  ],
  "phrases": [
    { "text": "The laundry is done", "speakers": ["Kitchen"], "voice": "avri-deep", "volume": 60 },
    { "text": "Good night everyone", "name": "Good night", "speakers": ["Kitchen", "Bedroom"] },
    { "text": "Dinner is ready" }
  ],
  "webhook": { "enabled": true, "port": 8095, "token": "change-me" }
}
```

## Troubleshooting

- **Voice engine can't install** — run once in the terminal: `sudo apt install -y python3-venv`, then tap *Install voice engine* again.
- **"HomePod not found on the network"** — check the IP and that Homebridge and the HomePod are on the same network.
- **Permission error** — Home app → Home Settings → *Allow Speaker & TV Access* → *Everyone on the same network*.
- **Devices marked "needs pairing"** (TVs, Apple TV) are not supported — HomePods and open AirPlay speakers only.

## Support

If this plugin helps you, [buy me a coffee ☕](https://paypal.me/orenasher). Issues and ideas: [GitHub](https://github.com/orenasher/homebridge-homepod-israel-hebrew/issues).

MIT © Oren Asher
