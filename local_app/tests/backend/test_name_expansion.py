import copy
from contextlib import closing
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image, ImageDraw
from barter.tools.expand_verified_trade_names import build, encoded, replay, FONT_POLICY, ROOT
from barter.tools.trade_live_ocr import NAME_BOUNDS, _crop


class NameExpansionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "source.sqlite3"
        catalog = json.loads((ROOT / "barter/frontend/data/trade-catalog.json").read_text(encoding="utf-8"))
        names = [catalog["islands"][0], catalog["masterData"]["1"][0], catalog["masterData"]["1"][1]]
        image = Image.new("RGB", (987, 456)); draw = ImageDraw.Draw(image)
        fields = {}
        for index, ((field, bounds), value) in enumerate(zip(NAME_BOUNDS.items(), names)):
            crop = _crop(image.crop((0, 0, 987, 70)), bounds)
            x, y = round(bounds[0]*987), round(bounds[1]*70)
            draw.rectangle((x+8, y+4, x+14+index*5, y+11), fill="white")
            fields[field] = {"corrected": value, "reviewRequired": False, "valueSource": "MASTER",
                             "box": {"x": x, "y": y, "width": crop.width, "height": crop.height}}
        fields["fromItem"].update(valueSource="VERIFIED_ICON", iconEvidence={"distance": .1, "gap": .1})
        fields["count"] = {"corrected": 3, "valueSource": "NUMERIC_OCR_CONSENSUS"}
        self.details = {"metadata": {"captureId": "fixture", "sourceType": "native-screen",
                         "fidelity": {"rescaled": False, "evidence": "native-pixels"}},
                        "snapshot": {"phase": "reviewed", "rows": [{"ordinal": 0,
                         "rowBox": {"x": 0, "y": 0, "width": 987, "height": 70}, "fields": fields}]}}
        raw = io.BytesIO(); image.save(raw, format="PNG"); self.image = raw.getvalue()
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("CREATE TABLE trade_correction (created_at TEXT, image_png BLOB, details_json TEXT, feedback_id TEXT, capture_id TEXT)")
        self.insert(self.details, "first")

    def tearDown(self):
        self.temp.cleanup()

    def insert(self, details, identity, created="2026-10-27T03:24:00Z"):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("INSERT INTO trade_correction VALUES (?,?,?,?,?)", (created, self.image, json.dumps(details, ensure_ascii=False), identity, identity))

    def test_read_only_deterministic_names_only_and_master_is_not_ground_truth(self):
        before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        first = build(self.db, self.root / "first")
        second = build(self.db, self.root / "second")
        self.assertTrue(first["readyForReplay"])
        self.assertEqual(first["verifiedSamples"], 1)
        self.assertEqual(first["candidateNames"], 3)
        self.assertEqual(first["newReferences"], 1)
        self.assertEqual(first, second)
        bank = json.loads((self.root / "first/candidate-bank.json").read_text(encoding="utf-8"))
        self.assertTrue(all(key.startswith("item|") for key in bank["lookup"]))
        self.assertEqual((self.root / "first/candidate-bank.json").read_bytes(), (self.root / "second/candidate-bank.json").read_bytes())
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), before)

    def test_independent_audit_required_for_master_and_user_review_values(self):
        self.details["snapshot"]["rows"][0]["fields"]["island"]["valueSource"] = "USER_REVIEW"
        self.insert(self.details, "reviewed")
        build(self.db, self.root / "extract")
        samples = json.loads((self.root / "extract/samples.json").read_text(encoding="utf-8"))
        island = next(s for s in samples if s["field"] == "island")
        labels = {"version": 1, "fontPolicy": FONT_POLICY, "labels": [{"sampleId": island["sampleId"], "value": island["value"],
                   "verification": "ORIGINAL_IMAGE_AUDIT", "verifiedAt": "2026-10-27T04:00:00Z"}]}
        path = self.root / "labels.json"; path.write_bytes(encoded(labels))
        result = build(self.db, self.root / "verified", labels=path)
        self.assertEqual(result["newReferences"], 2)
        labels["labels"][0]["verification"] = "HIGH_CONFIDENCE"
        path.write_bytes(encoded(labels))
        with self.assertRaises(ValueError):
            build(self.db, self.root / "bad", labels=path)

    def test_collision_blocks_replay_and_legacy_frames_are_ignored(self):
        changed = copy.deepcopy(self.details)
        changed["snapshot"]["rows"][0]["fields"]["fromItem"]["corrected"] = changed["snapshot"]["rows"][0]["fields"]["toItem"]["corrected"]
        self.insert(changed, "collision")
        self.insert(self.details, "old", "2026-10-27T01:00:00Z")
        result = build(self.db, self.root / "collision")
        self.assertFalse(result["readyForReplay"])
        self.assertTrue(result["collisions"])
        self.assertEqual(result["skipped"]["old_font_or_non_native"], 1)

    def test_unknown_audit_id_and_overwriting_output_are_rejected(self):
        build(self.db, self.root / "extract")
        with self.assertRaises(ValueError):
            build(self.db, self.root / "extract")
        labels = {"version": 1, "fontPolicy": FONT_POLICY, "labels": [{"sampleId": "missing", "value": "unknown",
                  "verification": "ORIGINAL_IMAGE_AUDIT", "verifiedAt": "2026-10-27T04:00:00Z"}]}
        path = self.root / "labels.json"; path.write_bytes(encoded(labels))
        with self.assertRaises(ValueError):
            build(self.db, self.root / "unknown", labels=path)

    def test_replay_blocks_numeric_changes_without_changing_source_bank(self):
        from barter.backend.services import trade_batch_runtime as runtime
        model = self.root / "model"; model.mkdir()
        for name in ("inference.onnx", "inference.yml"):
            (model / name).write_bytes(b"model-fixture")
        model_hash = hashlib.sha256(b"model-fixture").hexdigest()
        source = (ROOT / "barter/recognition_data/trade-templates.json").read_bytes()
        for changed in (False, True):
            out = self.root / str(changed); build(self.db, out)
            def recognize(captures, model_dir, batch, *, template_bank_path=None):
                candidate = template_bank_path is not None
                return {"rows": [{"captureId": "fixture", "ordinal": 0, "fields": {
                    "count": {"corrected": 4 if candidate and changed else 3, "reviewRequired": False}}}],
                    "templateMetrics": {"modelCalls": 4 if candidate else 8, "hits": 1 if candidate else 0}}
            with patch.object(runtime, "MODEL_ONNX_SHA256", model_hash), patch.object(runtime, "MODEL_CONFIG_SHA256", model_hash), \
                    patch("barter.tools.trade_live_ocr.recognize_live", side_effect=recognize), \
                    patch("barter.tools.expand_verified_trade_names.time.perf_counter", side_effect=[0, 10, 20, 29]):
                result = replay(out, model)
            self.assertEqual(result["canApply"], not changed)
            self.assertEqual(bool(result["differences"]), changed)
        self.assertEqual((ROOT / "barter/recognition_data/trade-templates.json").read_bytes(), source)

    def test_verified_names_bypass_batch_prewarming_as_well_as_field_ocr(self):
        from barter.tools.trade_live_ocr import recognize_live
        catalog = json.loads((ROOT / "barter/frontend/data/trade-catalog.json").read_text(encoding="utf-8"))
        image = self.root / "capture.png"; image.write_bytes(self.image)
        def match(kind, crop, **kwargs):
            if kind not in {"item", "island"}:
                return None
            name = (catalog["islands"][0] if kind == "island" else
                    catalog["masterData"]["2"][0] if crop.width == 215 else catalog["masterData"]["3"][0])
            return {"corrected": name, "rawOCR": "", "reviewRequired": False, "confidence": None, "valueSource": "VERIFIED_TEMPLATE"}
        numeric = {"corrected": 2, "rawOCR": "2", "reviewRequired": False, "confidence": .99}
        with patch("barter.tools.trade_template_reader.TemplateReader") as reader, \
                patch("barter.tools.item_icon_reader.ItemIconReader", side_effect=OSError), \
                patch("barter.tools.trade_live_ocr.LocalReader"), \
                patch("barter.tools.trade_live_ocr.detect_live_rows", return_value=[(0, 70)]), \
                patch("barter.tools.trade_live_ocr._name_images", return_value=[]) as prewarm, \
                patch("barter.tools.trade_live_ocr._outlined_quantity_image", return_value=None), \
                patch("barter.tools.trade_live_ocr.read_catalog_name") as name_ocr, \
                patch("barter.tools.trade_live_ocr.read_count", return_value=numeric), \
                patch("barter.tools.trade_live_ocr.read_yield", return_value=numeric):
            reader.return_value.match.side_effect = match
            reader.return_value.stats = {}
            result = recognize_live([{"captureId": "fixture", "imagePath": image}], Path("unused"), "fixture")
        name_ocr.assert_not_called()
        self.assertEqual(prewarm.call_count, 1, "only the count crop should reach text prewarming")
        self.assertEqual(result["rows"][0]["fields"]["island"]["valueSource"], "VERIFIED_TEMPLATE")
