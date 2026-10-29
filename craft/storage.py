from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import threading
from urllib.request import Request, urlopen

from .catalog import index, parse_item, SOURCE


class CraftStorage:
    def __init__(self, shared_storage):
        self.shared = shared_storage
        self.lock = threading.Lock()
        self.ready = False

    def connect(self):
        db = self.shared.connect()
        if not self.ready:
            with self.lock:
                db.execute("CREATE TABLE IF NOT EXISTS craft_cache (item_id TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL)")
                db.execute("CREATE TABLE IF NOT EXISTS craft_preferences (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL)")
                db.execute("INSERT OR IGNORE INTO craft_preferences VALUES (1,0,?)", (json.dumps({"favorites": []}),))
                db.commit()
                self.ready = True
        return db

    def inventory(self):
        # Shared tables are read only; notebook calculations never consume stock.
        with closing(self.connect()) as db:
            db.execute("BEGIN")
            rows = db.execute("SELECT item_id,quantity FROM inventory").fetchall()
            override = db.execute("SELECT value FROM settings WHERE key='catalog'").fetchone()
            catalog = json.loads(override[0]) if override else json.loads((Path(__file__).resolve().parents[1] / "alchemy/data/catalog.json").read_text(encoding="utf-8"))
            ids = {item["item_id"]: str(item["game_item_id"]) for item in catalog["items"] if item.get("game_item_id")}
            return {ids[row[0]]: row[1] for row in rows if row[0] in ids}

    def preferences(self):
        with closing(self.connect()) as db:
            revision, payload = db.execute("SELECT revision,payload FROM craft_preferences WHERE id=1").fetchone()
            return {"revision": revision, **json.loads(payload)}

    def save_preferences(self, revision, favorites):
        if type(revision) is not int or revision < 0 or not isinstance(favorites, list) or len(favorites) > 100:
            raise ValueError("즐겨찾기 저장 내용을 확인하세요.")
        known = {item["id"] for item in index()["items"]}
        if any(not isinstance(key, str) or key not in known for key in favorites) or len(set(favorites)) != len(favorites):
            raise ValueError("즐겨찾기는 등록된 품목을 중복 없이 선택하세요.")
        with closing(self.connect()) as db, db:
            cursor = db.execute("UPDATE craft_preferences SET revision=revision+1,payload=? WHERE id=1 AND revision=?",
                                (json.dumps({"favorites": favorites}), revision))
            if cursor.rowcount != 1:
                raise RuntimeError("다른 창에서 즐겨찾기가 변경됐습니다. 새로 불러온 뒤 다시 선택하세요.")
        return {"revision": revision + 1, "favorites": favorites}

    def item(self, item_id):
        with closing(self.connect()) as db:
            cached = db.execute("SELECT payload,fetched_at FROM craft_cache WHERE item_id=?", (item_id,)).fetchone()
        if cached:
            return {**json.loads(cached[0]), "fetchedAt": cached[1], "cached": True}
        starter = Path(__file__).parent / "data" / (item_id + ".json")
        if starter.is_file():
            payload = json.loads(starter.read_text(encoding="utf-8"))
        else:
            url = SOURCE + "/xml/ko-kr/" + item_id + ".xml"
            with urlopen(Request(url, headers={"User-Agent": "BDO-Suite-CraftNotebook/1.0"}), timeout=12) as response:
                if response.url.split("?")[0] != url:
                    raise ValueError("품목 자료의 응답 주소가 다릅니다.")
                payload = parse_item(response.read(2 * 1024 * 1024 + 1), item_id)
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with closing(self.connect()) as db, db:
            db.execute("INSERT OR IGNORE INTO craft_cache VALUES (?,?,?)", (item_id, json.dumps(payload, ensure_ascii=False), timestamp))
        return {**payload, "fetchedAt": timestamp, "cached": False}
