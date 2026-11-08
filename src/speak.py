#!/usr/bin/env python3
"""Small pyatv helper used by homebridge-homepod-israel-hebrew.

Usage: speak.py '<json>'
  {"cmd": "speak", "host": "10.0.0.5", "id": "AA:BB:...", "file": "/x.mp3", "volume": 50, "restore": true}
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


async def speak(args):
    if not args.get("file"):
        out({"ok": False, "error": "missing file"})
        return 2
    loop = asyncio.get_running_loop()
    conf = await find(loop, args.get("host"), args.get("id"), args.get("timeout", 6))
    if conf is None:
        out({"ok": False, "error": "HomePod not found on the network"})
        return 4

    atv = await pyatv.connect(conf, loop)
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
        try:
            await atv.stream.stream_file(args["file"])
        except Exception as exc:
            out({"ok": False, "error": f"playback failed: {exc}", "warnings": warnings})
            return 5
        if previous is not None and volume is not None and abs(previous - float(volume)) > 0.5:
            try:
                await atv.audio.set_volume(previous)
            except Exception as exc:
                warnings.append(f"restore volume: {exc}")
    finally:
        pending = atv.close()
        if pending:
            await asyncio.wait(pending, timeout=3)
    out({"ok": True, "previousVolume": previous, "warnings": warnings})
    return 0


async def scan(args):
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
    out({"ok": True, "devices": devices})
    return 0


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
    return await speak(args)


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as exc:
        out({"ok": False, "error": str(exc) or exc.__class__.__name__})
        sys.exit(5)
