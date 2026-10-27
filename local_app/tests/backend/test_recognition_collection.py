import base64
import copy
import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from pathlib import Path
from PIL import Image
from local_app.backend.app import create_app


class WarehouseCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "db.sqlite3"
        self.app = create_app(self.database, testing=True)
        self.store = self.app.extensions["bdo_storage"]
        self.client = self.app.test_client()
        self.name = next(n for n, t in self.store.catalog.items() if t == 1)
        png = io.BytesIO(); Image.new("RGB", (10, 10)).save(png, format="PNG"); self.png = png.getvalue()
        self.report = {"slots": [{"slot": "R1C1", "decision": "MATCH", "finalItem": self.name,
                                  "quantity": {"value": 5, "status": "QUANTITY_MATCH"}}]}

    def tearDown(self):
        self.temp.cleanup()

    def rows(self, table):
        with closing(self.store.connect()) as db:
            return [dict(r) for r in db.execute("SELECT * FROM " + table)]

    def body(self, scan_id, value=5, source=False):
        feedback = {"version": 2, "scanId": scan_id, "rows": [{"slot": "R1C1", "name": self.name,
                     "quantity": value, "excluded": False, "agreement": "unchecked"}]}
        if source:
            feedback["sourceImagePng"] = base64.b64encode(self.png).decode()
        return {"mutationId": "apply", "baseRevision": 0, "kind": "warehouse",
                "patch": {"type": "master_inventory_patch", "version": 1, "items": {self.name: value}}, "feedback": feedback}

    def test_normal_scan_keeps_metadata_without_image_and_applies(self):
        scan = self.store.record_warehouse_scan(self.png, self.report, {})
        self.assertEqual(self.rows("warehouse_scan")[0]["image_png"], b"")
        body = self.body(scan)
        self.assertEqual(self.client.patch("/api/inventory", json=body).status_code, 200)
        self.assertTrue(self.client.patch("/api/inventory", json=body).get_json()["idempotent"])
        self.assertEqual(self.rows("warehouse_feedback"), [])
        inventory = self.client.get("/api/bootstrap").get_json()["inventory"]
        self.assertEqual(next(r["stock"] for r in inventory if r["programName"] == self.name), 5)
        response = self.client.get("/api/warehouse-dataset")
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            self.assertEqual(json.loads(archive.read("manifest.json"))["scanCount"], 0)
        response.close()

    def test_review_image_deduplicates_across_restart_without_promoting_feedback(self):
        report = copy.deepcopy(self.report); report["slots"][0]["decision"] = "QUANTITY_UNKNOWN"
        scan = self.store.record_warehouse_scan(self.png, report, {})
        self.store.initialize()
        self.assertEqual(self.store.record_warehouse_scan(self.png, report, {}), scan)
        self.assertEqual(len(self.rows("warehouse_scan")), 1)
        self.assertEqual(self.rows("warehouse_scan")[0]["image_png"], self.png)
        self.assertEqual(self.client.patch("/api/inventory", json=self.body(scan)).status_code, 200)
        self.assertEqual(self.rows("warehouse_feedback"), [])

    def test_correction_restores_matching_original_atomically(self):
        scan = self.store.record_warehouse_scan(self.png, self.report, {})
        body = self.body(scan, value=6, source=True)
        self.assertEqual(self.client.patch("/api/inventory", json=body).status_code, 200)
        self.assertTrue(self.client.patch("/api/inventory", json=body).get_json()["idempotent"])
        self.assertEqual(self.rows("warehouse_scan")[0]["image_png"], self.png)
        feedback = json.loads(self.rows("warehouse_feedback")[0]["feedback_json"])
        self.assertNotIn("sourceImagePng", feedback)
        self.assertEqual(feedback["rows"][0]["quantity"], 6)

    def test_missing_mismatched_source_and_database_error_never_change_stock(self):
        scan = self.store.record_warehouse_scan(self.png, self.report, {})
        before = self.client.get("/api/bootstrap").get_json()
        body = self.body(scan, value=6)
        self.assertEqual(self.client.patch("/api/inventory", json=body).status_code, 422)
        body["feedback"]["sourceImagePng"] = base64.b64encode(b"invalid").decode()
        self.assertEqual(self.client.patch("/api/inventory", json=body).status_code, 422)
        with closing(sqlite3.connect(self.database)) as db:
            db.execute("CREATE TRIGGER fail_stock BEFORE UPDATE ON inventory BEGIN SELECT RAISE(ABORT,'failure'); END")
            db.commit()
        self.assertEqual(self.client.patch("/api/inventory", json=self.body(scan, value=6, source=True)).status_code, 503)
        self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)
        self.assertEqual(self.rows("warehouse_scan")[0]["image_png"], b"")
        self.assertEqual(self.rows("warehouse_feedback"), [])
