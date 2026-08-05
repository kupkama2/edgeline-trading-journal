"""Seed sample trades so the dashboard has data during QA."""
import json, random, urllib.request
from datetime import datetime, timedelta

BASE = "http://127.0.0.1:5000/api"
random.seed(11)


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read().decode())


def get(path):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=30).read().decode())


tags = get("/mistake-tags")
tag_ids = [t["id"] for t in tags]
symbols = ["NQ", "ES", "CL", "GC", "EURUSD", "BTCUSD"]
reasons = ["target", "stop", "trailed", "manual_early", "manual_late", "breakeven"]

now = datetime.now()
for i in range(24):
    sym = random.choice(symbols)
    direction = random.choice(["long", "short"])
    sign = 1 if direction == "long" else -1
    entry = round(random.uniform(100, 21500), 2)
    risk = round(entry * random.uniform(0.002, 0.006), 2)
    stop = round(entry - sign * risk, 2)
    target = round(entry + sign * risk * random.uniform(1.5, 3.2), 2)
    size = random.choice([1, 2, 3, 5])
    t_entry = now - timedelta(days=random.randint(0, 40), hours=random.randint(0, 8))
    hold = timedelta(minutes=random.randint(8, 220))

    mfe_r = max(0.1, random.gauss(1.4, 1.0))
    mae_r = -abs(random.gauss(0.5, 0.35))
    actual_r = min(mfe_r, max(-1.05, random.gauss(mfe_r * 0.55, 0.8)))
    reason = random.choice(reasons)
    if reason == "target":
        actual_r = round(abs(target - entry) / risk, 2)
        mfe_r = max(mfe_r, actual_r)
    elif reason == "stop":
        actual_r = -1.0
    elif reason == "breakeven":
        actual_r = 0.0

    nmo = "target_first" if mfe_r >= abs(target - entry) / risk else "stop_first"
    if random.random() < 0.15:
        nmo = "undetermined"

    body = {
        "trade": {
            "symbol": sym,
            "direction": direction,
            "size": size,
            "entryPrice": entry,
            "initialStop": stop,
            "initialTarget": target,
            "entryTime": t_entry.isoformat(),
            "exitPrice": round(entry + sign * actual_r * risk, 2),
            "exitTime": (t_entry + hold).isoformat(),
            "status": "closed",
            "exitReason": reason,
            "mae": round(entry + sign * mae_r * risk, 2),
            "mfe": round(entry + sign * mfe_r * risk, 2),
            "noManagementOutcome": nmo,
            "notes": None,
        },
        "mistakeTagIds": random.sample(tag_ids, random.choice([0, 1, 1, 2]))
        if actual_r < mfe_r * 0.8
        else [],
    }
    post("/trades", body)

# two open trades
for sym, direction, entry, stop, target, size in [
    ("NQ", "long", 21450.0, 21400.0, 21560.0, 2),
    ("ES", "short", 5480.25, 5492.0, 5455.5, 1),
]:
    post("/trades", {
        "trade": {
            "symbol": sym, "direction": direction, "size": size,
            "entryPrice": entry, "initialStop": stop, "initialTarget": target,
            "entryTime": (now - timedelta(hours=2)).isoformat(), "status": "open",
        }
    })

print("seeded", len(get("/trades")), "trades")
