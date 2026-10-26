import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from uuid import uuid4
from unittest.mock import patch
from PIL import Image
from werkzeug.datastructures import MultiDict
from local_app.backend.app import create_app
from barter.backend.services.trade_batch_runtime import ENGINE_ID, MODEL_BUNDLE_SHA256, WORKER_VERSION
from .test_recognition_contracts import capture_metadata
from .test_trade_batch_runtime import ReadyRuntime, fake_worker, live_result


class LiveApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name)/"data.sqlite3"
        self.app = create_app(self.database, testing=True)
        self.app.extensions["trade_batch_runtime"] = ReadyRuntime(runner=fake_worker)
        self.client = self.app.test_client()
        self.headers = {"Origin": "http://localhost:18765", "Sec-Fetch-Site": "same-origin"}
        self.metadata = capture_metadata(width=80, height=50, task="trade")
        self.capture = {"captureId": self.metadata["captureId"], "metadata": self.metadata}
        output = io.BytesIO(); Image.new("RGB", (80,50)).save(output, format="PNG"); self.image = output.getvalue()

    def tearDown(self):
        self.temp.cleanup()

    def post(self, payload, *, field="batch", headers=None, image=None, copies=1):
        form = [(field, json.dumps(payload))] + [("image", (io.BytesIO(self.image if image is None else image), "capture.png", "image/png")) for _ in range(copies)]
        return self.client.post("/api/recognition/trade-live-list" if field=="batch" else "/api/recognition/trade-corrections",
                                data=MultiDict(form), headers=self.headers if headers is None else headers,
                                base_url="http://localhost:18765")

    def batch(self):
        return {"version":1, "batchId":str(uuid4()), "captures":[self.capture]}

    def feedback(self):
        result = self.post(self.batch()).get_json()["result"]
        row=result["rows"][0]; value=row["fields"]["island"]
        return {"version":1, "feedbackId":str(uuid4()), "captures":[self.capture],
                "engineId":ENGINE_ID, "modelVersion":MODEL_BUNDLE_SHA256, "workerVersion":WORKER_VERSION,
                "corrections":[{"captureId":row["captureId"], "ordinal":row["ordinal"], "rowBox":row["rowBox"],
                                "field":"island", "box":value["box"], "rawOCR":value["rawOCR"],
                                "confidence":value["confidence"], "automaticCorrected":value["corrected"], "finalValue":"새 섬"}]}

    def records(self, include_automatic=False):
        with closing(sqlite3.connect(self.database)) as db:
            rows = db.execute("SELECT * FROM trade_correction").fetchall()
            return rows if include_automatic else [row for row in rows if json.loads(row[5]).get("snapshot", {}).get("phase") != "recognized"]

    def covered_result(self, batch=None):
        batch = batch or self.batch()
        result = live_result(batch["batchId"], batch["captures"])
        result["runtime"] = {"engineId": ENGINE_ID, "modelBundleSha256": MODEL_BUNDLE_SHA256,
                             "workerVersion": WORKER_VERSION}
        for row in result["rows"]:
            for name, field in row["fields"].items():
                field.update(reviewRequired=False, valueSource="TRADE_RULE" if name == "reqAmount" else "VERIFIED_TEMPLATE")
                if field["valueSource"] == "VERIFIED_TEMPLATE":
                    field["templateEvidence"] = {"bankSha256": "fixture-bank", "references": ["fixture-reference"]}
        return batch, result

    def post_result(self, batch, result, **kwargs):
        with patch.object(self.app.extensions["trade_batch_runtime"], "recognize_live", return_value=result):
            return self.post(batch, **kwargs)

    def snapshot_feedback(self, result, phase="reviewed"):
        return {"version": 2, "feedbackId": str(uuid4()), "captures": [self.capture], "engineId": ENGINE_ID,
                "modelVersion": MODEL_BUNDLE_SHA256, "workerVersion": WORKER_VERSION, "corrections": [],
                "snapshot": {"phase": phase, "result": result}}

    def test_fully_covered_capture_does_not_grow_history_or_change_result(self):
        batch, result = self.covered_result()
        before = self.client.get("/api/bootstrap").get_json()
        response = self.post_result(batch, result)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["result"], result)
        self.assertEqual(self.records(include_automatic=True), [])
        feedback = self.snapshot_feedback(result)
        self.assertFalse(self.post(feedback, field="feedback").get_json()["created"])
        self.assertFalse(self.post(feedback, field="feedback").get_json()["created"])
        self.assertEqual(self.records(include_automatic=True), [])
        self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)

    def test_only_capture_with_missing_field_is_collected_with_all_source_rows(self):
        metadata = capture_metadata(width=80, height=50, task="trade")
        batch = self.batch()
        batch["captures"].append({"captureId": metadata["captureId"], "metadata": metadata})
        batch, result = self.covered_result(batch)
        result["rows"][1]["fields"]["count"].update(valueSource="OCR", rawOCR="2")
        response = self.post_result(batch, result, copies=2)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["result"], result)
        rows = self.records(include_automatic=True)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], metadata["captureId"])
        self.assertEqual(rows[0][4], self.image)
        details = json.loads(rows[0][5])
        self.assertEqual(details["snapshot"]["rows"], [result["rows"][1]])
        self.assertEqual(details["collection"]["missingFields"], [{"ordinal": 0, "field": "count", "reason": "OCR_FALLBACK"}])

    def test_identical_missing_evidence_is_not_saved_again_after_review_or_restart(self):
        batch, result = self.covered_result()
        result["rows"][0]["fields"]["count"].update(valueSource="OCR")
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        original = self.records(include_automatic=True)
        self.assertEqual(len(original), 1)
        for field in result["rows"][0]["fields"].values():
            field["automaticCorrected"] = field["corrected"]
        for phase in ("reviewed", "applied"):
            feedback = self.snapshot_feedback(result, phase)
            self.assertFalse(self.post(feedback, field="feedback").get_json()["created"])
            self.assertEqual(self.records(include_automatic=True), original)
        self.app.extensions["bdo_storage"].initialize()
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        self.assertEqual(self.records(include_automatic=True), original)

    def test_same_image_with_new_upload_ids_is_deduplicated(self):
        batch, result = self.covered_result()
        result["rows"][0]["fields"]["count"].update(valueSource="OCR")
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        self.metadata["captureId"] = str(uuid4())
        self.capture["captureId"] = self.metadata["captureId"]
        batch, result = self.covered_result()
        result["rows"][0]["fields"]["count"].update(valueSource="OCR")
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        self.assertEqual(len(self.records(include_automatic=True)), 1)

    def test_changed_evidence_and_template_bank_are_not_hidden_as_duplicates(self):
        batch, result = self.covered_result()
        result["rows"][0]["fields"]["count"].update(valueSource="OCR")
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        result["rows"][0]["fields"]["count"]["corrected"] = 3
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        result["rows"][0]["fields"]["island"]["templateEvidence"]["bankSha256"] = "new-bank"
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        self.assertEqual(len(self.records(include_automatic=True)), 3)

    def test_human_correction_of_covered_field_is_preserved(self):
        batch, result = self.covered_result()
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        field = result["rows"][0]["fields"]["island"]
        field.update(corrected="수정한 섬", valueSource="USER_REVIEW", automaticCorrected="품목")
        feedback = self.snapshot_feedback(result)
        self.assertTrue(self.post(feedback, field="feedback").get_json()["created"])
        self.assertFalse(self.post(feedback, field="feedback").get_json()["created"])
        details = json.loads(self.records()[0][5])
        self.assertEqual(details["snapshot"]["rows"], result["rows"])
        self.assertEqual(details["collection"]["missingFields"][0]["reason"], "USER_FEEDBACK")

    def test_unresolved_and_empty_results_are_retained_for_diagnosis(self):
        batch, result = self.covered_result()
        result["rows"][0]["fields"]["count"].update(corrected=None, reviewRequired=True)
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        details = json.loads(self.records(include_automatic=True)[0][5])
        self.assertEqual(details["collection"]["missingFields"][0]["reason"], "REVIEW_REQUIRED")
        result["rows"] = []
        self.assertEqual(self.post_result(batch, result).status_code, 200)
        self.assertEqual(len(self.records(include_automatic=True)), 2)

    def test_duplicate_check_uses_index_without_scanning_image_history(self):
        self.assertEqual(self.client.get("/api/bootstrap").status_code, 200)
        with closing(sqlite3.connect(self.database)) as db:
            plan = db.execute("""EXPLAIN QUERY PLAN SELECT 1 FROM trade_correction
                WHERE json_extract(details_json, '$.collection.fingerprint') = ?""", ("fixture",)).fetchall()
        self.assertTrue(any("trade_correction_collection_fingerprint" in row[-1] for row in plan), plan)

    def test_existing_history_survives_collection_index_initialization(self):
        self.assertEqual(self.post(self.batch()).status_code, 200)
        with closing(sqlite3.connect(self.database)) as db:
            record = db.execute("SELECT * FROM trade_correction").fetchone()
            details = json.loads(record[5])
            details.pop("collection")
            db.execute("DROP INDEX trade_correction_collection_fingerprint")
            db.execute("UPDATE trade_correction SET details_json = ?", (json.dumps(details, ensure_ascii=False),))
            db.commit()
            legacy = db.execute("SELECT * FROM trade_correction").fetchall()
        self.app.extensions["bdo_storage"].initialize()
        self.assertEqual(self.records(include_automatic=True), legacy)

    def test_live_recognition_preserves_all_source_rows_without_changing_working_state(self):
        before=self.client.get("/api/bootstrap").get_json()
        response=self.post(self.batch())
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertEqual(response.get_json()["result"]["version"],3)
        self.assertEqual(self.records(),[])
        records = self.records(include_automatic=True)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0][4], self.image)
        self.assertEqual(json.loads(records[0][5])["snapshot"]["rows"], response.get_json()["result"]["rows"])
        self.assertEqual(self.client.get("/api/bootstrap").get_json(),before)
        self.assertEqual([p.name for p in Path(self.temp.name).rglob('*.sqlite3')],["data.sqlite3"])

    def test_correction_source_values_restart_and_retry_are_preserved(self):
        feedback=self.feedback()
        before=self.client.get("/api/bootstrap").get_json()
        self.assertTrue(self.post(feedback,field="feedback").get_json()["created"])
        self.assertFalse(self.post(feedback,field="feedback").get_json()["created"])
        rows=self.records();self.assertEqual(len(rows),1)
        self.assertEqual(rows[0][4],self.image)
        details=json.loads(rows[0][5]);self.assertEqual(details["corrections"],feedback["corrections"])
        self.assertEqual(details["modelVersion"],MODEL_BUNDLE_SHA256)
        self.assertEqual(self.client.get("/api/bootstrap").get_json(),before)
        create_app(self.database,testing=True)
        self.assertEqual(self.records(),rows)
        feedback["corrections"][0]["finalValue"]="다른 섬"
        self.assertEqual(self.post(feedback,field="feedback").status_code,409)
        self.assertEqual(self.records(),rows)

    def test_invalid_samples_are_rejected_without_writes(self):
        for change in ({"finalValue":"품목"},{"confidence":True},{"confidence":2},{"field":[]},
                       {"box":{"x":79,"y":0,"width":2,"height":1}}, {"captureId":[]}):
            feedback=self.feedback();feedback["corrections"][0].update(change)
            with self.subTest(change=change):
                self.assertEqual(self.post(feedback,field="feedback").status_code,422)
        self.assertEqual(self.records(),[])

    def test_image_frame_ids_parts_and_origin_are_checked(self):
        batch=self.batch()
        for headers in ({},{"Origin":"https://example.com"},{"Origin":"http://localhost","Sec-Fetch-Site":"cross-site"}):
            self.assertEqual(self.post(batch,headers=headers).status_code,403)
        self.assertEqual(self.post(batch,image=b'bad png').status_code,422)
        batch["captures"][0]["metadata"]["frame"]["width"]=81
        self.assertEqual(self.post(batch).status_code,422)
        batch["captures"][0]["metadata"]["frame"]["width"]=80
        batch["captures"]=batch["captures"]*2
        self.assertEqual(self.post(batch,copies=2).get_json()["error"]["code"],"duplicate_capture_id")

    def test_removed_routes_have_no_registration(self):
        rules={rule.rule for rule in self.app.url_map.iter_rules()}
        self.assertEqual({r for r in rules if r.startswith('/api/recognition/')},
                         {'/api/recognition/trade-runtime','/api/recognition/trade-live-list','/api/recognition/trade-corrections',
                          '/api/recognition/trade-progress/<uuid:batch_id>'})
        self.assertFalse(any(r.startswith('/api/master') for r in rules))

    def test_progress_lookup_does_not_mutate_state(self):
        batch = self.batch()
        url = f'/api/recognition/trade-progress/{batch["batchId"]}'
        before = self.client.get('/api/bootstrap').get_json()
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.post(batch).status_code, 200)
        history = self.records(include_automatic=True)
        response = self.client.get(url)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.get_json()['progress']['stage'], 'complete')
        self.assertEqual(response.get_json()['progress']['completedCaptures'], 1)
        self.assertEqual(self.client.get('/api/bootstrap').get_json(), before)
        self.assertEqual(self.records(include_automatic=True), history)

    def test_feedback_database_failure_records_no_success(self):
        feedback = self.feedback()
        with closing(sqlite3.connect(self.database)) as db:
            db.execute("CREATE TRIGGER fail_feedback BEFORE INSERT ON trade_correction BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        self.assertEqual(self.post(feedback,field='feedback').status_code,503)
        self.assertEqual(self.records(),[])

    def test_full_review_keeps_unchanged_confirmation_exclusion_and_original_ocr(self):
        result = self.post(self.batch()).get_json()["result"]
        row = result["rows"][0]
        row["excluded"] = True
        row["fields"]["island"].update(automaticCorrected="품목", corrected="새 섬", reviewRequired=False, valueSource="USER_REVIEW")
        feedback = {"version": 2, "feedbackId": str(uuid4()), "captures": [self.capture], "engineId": ENGINE_ID,
                    "modelVersion": MODEL_BUNDLE_SHA256, "workerVersion": WORKER_VERSION, "corrections": [],
                    "snapshot": {"phase": "reviewed", "result": result}}
        before = self.client.get("/api/bootstrap").get_json()
        self.assertEqual(self.post(feedback, field="feedback").status_code, 200)
        self.assertFalse(self.post(feedback, field="feedback").get_json()["created"])
        details = json.loads(self.records()[0][5])
        self.assertEqual(details["snapshot"]["rows"], [row])
        self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)
        feedback["feedbackId"] = str(uuid4())
        row["rowBox"]["width"] = 81
        self.assertEqual(self.post(feedback, field="feedback").status_code, 422)
        self.assertEqual(len(self.records()), 1)

    def test_previous_worker_review_still_saves_after_recognition_upgrade(self):
        result = self.post(self.batch()).get_json()["result"]
        feedback = {"version": 2, "feedbackId": str(uuid4()), "captures": [self.capture], "engineId": ENGINE_ID,
                    "modelVersion": MODEL_BUNDLE_SHA256, "workerVersion": "trade-live-worker-v9", "corrections": [],
                    "snapshot": {"phase": "reviewed", "result": result}}
        before = self.client.get("/api/bootstrap").get_json()
        self.assertEqual(self.post(feedback, field="feedback").status_code, 200)
        self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)
        self.assertEqual(json.loads(self.records()[0][5])["workerVersion"], "trade-live-worker-v9")

    def test_automatic_unused_exclusion_preserves_unknowns_sources_and_operational_state(self):
        result = self.post(self.batch()).get_json()["result"]
        row = result["rows"][0]
        row.update(excluded=True, exclusionSource="AUTO_UNUSED", autoUnusedReason="미사용 획득품 · 화려한 암염 주괴")
        row["fields"]["count"].update(corrected=None, rawOCR="uncertain", reviewRequired=True)
        feedback = {"version": 2, "feedbackId": str(uuid4()), "captures": [self.capture], "engineId": ENGINE_ID,
                    "modelVersion": MODEL_BUNDLE_SHA256, "workerVersion": WORKER_VERSION, "corrections": [],
                    "snapshot": {"phase": "reviewed", "result": result}}
        before = self.client.get("/api/bootstrap").get_json()
        self.assertEqual(self.post(feedback, field="feedback").status_code, 200)
        self.assertFalse(self.post(feedback, field="feedback").get_json()["created"])
        record = self.records()[0]
        self.assertEqual(record[4], self.image)
        self.assertEqual(json.loads(record[5])["snapshot"]["rows"], [row])
        self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)
