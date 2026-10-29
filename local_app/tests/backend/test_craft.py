from contextlib import closing
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

from local_app.backend.app import create_app
from craft.catalog import parse_item, index


class CraftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name)/"barter.sqlite3", testing=True)
        self.client = self.app.test_client()
        self.origin = "http://localhost:18765"
        self.store = self.app.extensions["alchemy_storage"]
        with closing(self.store.connect()) as db, db:
            db.execute("INSERT INTO inventory VALUES ('i-7cf8ffc293b6',17,'test')")

    def tearDown(self):
        self.temp.cleanup()

    def shared_state(self):
        with closing(self.store.connect()) as db:
            return {name: [tuple(row) for row in db.execute(f'SELECT * FROM "{name}" ORDER BY 1')]
                    for name in ["meta", "inventory", "settings", "goals", "jobs", "ledger", "events", "receipts"]}

    def test_notebook_shares_inventory_without_writing_existing_tables(self):
        before = self.shared_state()
        data = self.client.get("/api/craft/bootstrap").get_json()
        self.assertEqual(data["inventory"]["5301"],17)
        item = self.client.get("/api/craft/items/9213").get_json()
        self.assertEqual(item["name"],"맥주")
        self.assertEqual([row["quantity"] for row in item["recipes"][0]["inputs"]],[5,6,2,1])
        self.assertEqual(self.client.get("/api/craft/items/9213").get_json()["cached"],True)
        response = self.client.put("/api/craft/preferences",base_url=self.origin,json={"revision":0,"favorites":["9213"]},headers={"Origin":self.origin})
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.shared_state(),before)
        self.assertEqual(self.client.get("/api/craft/bootstrap").get_json()["preferences"]["favorites"],["9213"])
        self.assertEqual(self.client.put("/api/craft/preferences",base_url=self.origin,json={"revision":0,"favorites":[]},headers={"Origin":self.origin}).status_code,409)

    def test_only_notebook_routes_and_same_origin_changes(self):
        self.assertEqual(self.client.get("/craft/").status_code,200)
        self.assertEqual(self.client.get("/craft/assets/calculator.js").status_code,200)
        self.assertEqual(self.client.get("/api/craft/catalog").status_code,200)
        self.assertGreater(len(index()["items"]),7000)
        self.assertEqual(self.client.put("/api/craft/preferences",base_url=self.origin,json={"revision":0,"favorites":[]}).status_code,403)
        self.assertEqual(self.client.put("/api/craft/preferences",base_url=self.origin,json={"revision":0,"favorites":["not-an-id"]},headers={"Origin":self.origin}).status_code,422)
        self.assertEqual(self.client.get("/api/craft/items/not-an-id").status_code,422)
        with patch("craft.storage.urlopen",side_effect=URLError("offline")):
            response=self.client.get("/api/craft/items/7001")
        self.assertEqual(response.status_code,503)
        with closing(self.store.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM craft_cache WHERE item_id='7001'").fetchone()[0],0)

    def test_xml_directions_unknown_count_and_identity(self):
        raw=b'<itemInfo><itemKey>1</itemKey><itemName>A</itemName><manufacture action="MANUFACTURE_ROYALGIFT_ALCHEMY"><item><id>2</id><name>Box</name><count>1</count></item></manufacture><alchemy><item><id>3</id><name>Raw</name></item></alchemy></itemInfo>'
        data=parse_item(raw,"1")
        self.assertEqual(data["related"][0]["name"],"Box")
        self.assertIsNone(data["recipes"][0]["inputs"][0]["quantity"])
        self.assertIsNone(data["recipes"][0]["outputQuantity"])
        with self.assertRaises(ValueError):parse_item(raw,"4")
        with self.assertRaises(ValueError):parse_item(b'<!DOCTYPE x><itemInfo/>',"1")

    def test_favorites_and_cache_survive_a_new_app(self):
        self.client.get("/api/craft/items/9213")
        self.client.put("/api/craft/preferences",base_url=self.origin,json={"revision":0,"favorites":["9213"]},headers={"Origin":self.origin})
        app=create_app(Path(self.temp.name)/"barter.sqlite3",testing=True)
        self.assertEqual(app.test_client().get("/api/craft/items/9213").get_json()["cached"],True)
        self.assertEqual(app.test_client().get("/api/craft/bootstrap").get_json()["preferences"]["favorites"],["9213"])
