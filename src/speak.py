#!/usr/bin/env python3
"""Small pyatv helper used by homebridge-homepod-israel-hebrew.

Usage: speak.py '<json>'
  {"cmd": "speak", "host": "10.0.0.5", "id": "AA:BB:...", "files": ["/chime.wav", "/x.mp3"], "volume": 50, "restore": true}
  {"cmd": "ping", "host": "10.0.0.5", "id": "AA:BB:..."}
  {"cmd": "scan", "timeout": 6}
  {"cmd": "check"}
Prints one JSON line. Exit codes: 0 ok, 2 bad input, 3 pyatv missing, 4 device not found, 5 playback error.
"""
import asyncio
import json
import sys


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


try:
    import pyatv
    from pyatv.const import Protocol
except Exception as exc:  # pragma: no cover
    out({"ok": False, "error": f"pyatv not available: {exc}"})
    sys.exit(3)


async def find(loop, host, ident, timeout):
    attempts = []
    if host and ident:
        attempts.append({"hosts": [host], "identifier": ident})
    if host:
        attempts.append({"hosts": [host]})
    if ident:
        attempts.append({"identifier": ident})
    for kw in attempts:
        found = await pyatv.scan(loop, timeout=timeout, **kw)
        if found:
            return found[0]
    return None


class SpeakError(Exception):
    def __init__(self, reply, code):
        super().__init__(reply.get("error", "failed"))
        self.reply, self.code = reply, code


async def speak(args, cache=None):
    """One-shot mode: prints the reply and returns an exit code."""
    try:
        reply = await speak_reply(args, cache)
    except SpeakError as err:
        out(err.reply)
        return err.code
    out(reply)
    return 0


async def speak_reply(args, cache=None):
    files = args.get("files") or ([args["file"]] if args.get("file") else [])
    if not files:
        raise SpeakError({"ok": False, "error": "missing file"}, 2)
    loop = asyncio.get_running_loop()
    key = f'{args.get("host") or ""}|{args.get("id") or ""}'
    conf = cache.get(key) if cache is not None else None
    fresh = conf is None
    if conf is None:
        conf = await find(loop, args.get("host"), args.get("id"), args.get("timeout", 4))
    if conf is None:
        raise SpeakError({"ok": False, "error": "HomePod not found on the network"}, 4)
    try:
        atv = await pyatv.connect(conf, loop)
    except Exception:
        if fresh:
            raise
        # cached details went stale (new IP, reboot…) — look it up again once
        cache.pop(key, None)
        conf = await find(loop, args.get("host"), args.get("id"), args.get("timeout", 4))
        if conf is None:
            raise SpeakError({"ok": False, "error": "HomePod not found on the network"}, 4)
        atv = await pyatv.connect(conf, loop)
    if cache is not None:
        cache[key] = conf
    previous = None
    volume = args.get("volume")
    warnings = []
    try:
        if volume is not None:
            target = float(volume)
            if args.get("restore", True):
                try:
                    previous = float(atv.audio.volume)
                except Exception as exc:
                    warnings.append(f"read volume: {exc}")
            try:
                await atv.audio.set_volume(target)
            except Exception as exc:
                warnings.append(f"set volume: {exc}")
        # Several files (e.g. a chime, then the announcement) play back to back on one connection.
        for index, file in enumerate(files):
            try:
                await atv.stream.stream_file(file)
            except Exception as exc:
                # A sleeping HomePod sometimes drops the very first connection — reconnect once and retry.
                warnings.append(f"retry after: {exc}")
                pending = atv.close()
                if pending:
                    await asyncio.wait(pending, timeout=3)
                await asyncio.sleep(1)
                atv = await pyatv.connect(conf, loop)
                try:
                    await atv.stream.stream_file(file)
                except Exception as exc2:
                    if index < len(files) - 1:
                        warnings.append(f"skipped {file}: {exc2}")
                        continue
                    raise SpeakError({"ok": False, "error": f"playback failed: {exc2}", "warnings": warnings}, 5)
        if previous is not None and volume is not None and abs(previous - float(volume)) > 0.5:
            try:
                await atv.audio.set_volume(previous)
            except Exception as exc:
                warnings.append(f"restore volume: {exc}")
    finally:
        pending = atv.close()
        if pending:
            await asyncio.wait(pending, timeout=3)
    return {"ok": True, "previousVolume": previous, "warnings": warnings}


async def serve():
    """Long-running mode: pyatv stays loaded and HomePod details are remembered between
    announcements, so each announcement starts much faster. One JSON request per line on stdin,
    one JSON reply (with the same "rid") per line on stdout."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    cache = {}
    out({"ok": True, "ready": True, "pyatv": getattr(pyatv, "__version__", "unknown")})

    async def handle(req):
        rid = req.get("rid")
        try:
            cmd = req.get("cmd", "speak")
            if cmd == "speak":
                reply = await speak_reply(req, cache)
            elif cmd == "scan":
                reply = await scan_reply(req)
            elif cmd == "ping":
                reply = await ping_reply(req, cache)
            elif cmd == "warm":
                for d in req.get("devices", []):
                    key = f'{d.get("host") or ""}|{d.get("id") or ""}'
                    if key not in cache:
                        conf = await find(loop, d.get("host"), d.get("id"), 4)
                        if conf is not None:
                            cache[key] = conf
                reply = {"ok": True, "known": len(cache)}
            else:
                reply = {"ok": True, "pyatv": getattr(pyatv, "__version__", "unknown")}
        except SpeakError as err:
            reply = err.reply
        except Exception as exc:
            reply = {"ok": False, "error": str(exc) or exc.__class__.__name__}
        reply["rid"] = rid
        out(reply)

    while True:
        line = await reader.readline()
        if not line:
            break
        try:
            req = json.loads(line)
        except Exception:
            continue
        asyncio.ensure_future(handle(req))


async def ping_reply(args, cache=None):
    """Is the HomePod answering on the network? (a short look-up, nothing is played)"""
    loop = asyncio.get_running_loop()
    conf = await find(loop, args.get("host"), args.get("id"), args.get("timeout", 3))
    if conf is not None and cache is not None:
        cache[f'{args.get("host") or ""}|{args.get("id") or ""}'] = conf
    return {"ok": True, "online": conf is not None}


async def scan(args):
    out(await scan_reply(args))
    return 0


async def scan_reply(args):
    loop = asyncio.get_running_loop()
    found = await pyatv.scan(loop, timeout=args.get("timeout", 6))
    devices = []
    for conf in found:
        raop = conf.get_service(Protocol.RAOP)
        airplay = conf.get_service(Protocol.AirPlay)
        if not (raop or airplay):
            continue
        try:
            model = conf.device_info.model_str
        except Exception:
            model = ""
        needs_pairing = False
        try:
            svc = raop or airplay
            needs_pairing = str(svc.pairing).endswith("Mandatory") or bool(svc.requires_password)
        except Exception:
            pass
        devices.append({
            "name": conf.name,
            "host": str(conf.address),
            "id": conf.identifier,
            "model": model,
            "homepod": "HomePod" in (model or ""),
            "needsPairing": needs_pairing,
        })
    devices.sort(key=lambda d: (not d["homepod"], d["name"]))
    return {"ok": True, "devices": devices}


async def main():
    try:
        args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except Exception:
        out({"ok": False, "error": "bad arguments"})
        return 2
    cmd = args.get("cmd", "speak")
    if cmd == "check":
        out({"ok": True, "pyatv": getattr(pyatv, "__version__", "unknown")})
        return 0
    if cmd == "scan":
        return await scan(args)
    if cmd == "ping":
        out(await ping_reply(args))
        return 0
    if cmd == "serve":
        await serve()
        return 0
    return await speak(args)


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as exc:
        out({"ok": False, "error": str(exc) or exc.__class__.__name__})
        sys.exit(5)
