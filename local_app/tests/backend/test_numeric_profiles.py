import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

import barter.recognition_profiles as registry
from barter.backend.storage import _trade_sample_collection
from barter.tools.numeric_ocr import NumericOCR
from barter.tools.visual_numbers import VisualNumbers


class RuntimeNumericProfileTests(unittest.TestCase):
    def tearDown(self):
        registry.load_numeric_profile.cache_clear()
        registry._references.cache_clear()

    def warehouse_image(self):
        profile = registry.load_numeric_profile("warehouse")
        image = np.full((43,43,3), profile["outline"], dtype=np.uint8)
        for digit, x in [(4,21),(1,32)]:
            glyph = next(g for g in profile["glyphs"] if g["digit"] == digit)
            mask = np.array(glyph["mask"], dtype=bool)
            image[29:29+mask.shape[0], x:x+mask.shape[1]][mask] = profile["foreground"]
        return Image.fromarray(image)

    def reader(self):
        reader = Mock()
        reader.read_many.side_effect = lambda images: [("41",.99) for _ in images]
        reader.read.return_value = ("41",.99)
        ocr = NumericOCR(reader)
        ocr.bank_data = {}
        ocr.warehouse_bank = {}
        ocr.visual = VisualNumbers([])
        return ocr

    def count_row(self):
        profile = registry.load_numeric_profile("trade")
        context = profile["contexts"]["yellow"]
        tile = np.full((43,43,3),context["outline"],dtype=np.uint8)
        glyph = next(g for g in context["glyphs"] if g["digit"]==5)
        mask = np.array(glyph["mask"],dtype=bool)
        tile[22:22+mask.shape[0],2:2+mask.shape[1]][mask] = context["foreground"]
        suffix = np.array(profile["countSuffix"]["mask"],dtype=bool)
        tile[21:21+suffix.shape[0],13:13+suffix.shape[1]][suffix] = context["foreground"]
        row = np.zeros((70,987,3),dtype=np.uint8)
        row[17:60,183:226] = tile
        return Image.fromarray(row)

    def configured(self):
        image = np.zeros((456,987,3),dtype=np.uint8)
        image[:,3:] = 70
        image[:,268:] = 150
        templates = Mock()
        templates.match.return_value = None
        ocr = NumericOCR(Mock())
        ocr.configure_trade(Image.fromarray(image),{"sourceType":"native-screen",
            "fidelity":{"rescaled":False,"evidence":"native-pixels"}},templates)
        return ocr

    def test_verified_native_warehouse_quantity_needs_no_ocr(self):
        ocr = self.reader()
        result = ocr.read_many([self.warehouse_image()],warehouse=True,source_sizes=[(43,43)])[0]
        self.assertEqual(result["value"],41)
        self.assertEqual(result["valueSource"],"VERIFIED_NUMERIC_PROFILE")
        self.assertEqual(len(result["numericEvidence"]["digits"]),2)
        self.assertEqual(result["numericEvidence"]["profileFileSha256"],registry.PROFILE_FILES["warehouse"][1])
        ocr.reader.read_many.assert_not_called()

    def test_resized_or_unproven_source_cannot_use_native_profile(self):
        for sizes in [None,[(44,44)]]:
            ocr = self.reader()
            result = ocr.read_many([self.warehouse_image()],warehouse=True,source_sizes=sizes)[0]
            self.assertIsNone(result["value"])
            self.assertEqual(ocr.profile_hits,0)

    def test_whole_field_cache_still_has_priority(self):
        from barter.tools.numeric_ocr import warehouse_number_key
        ocr = self.reader()
        image = self.warehouse_image()
        ocr.warehouse_bank = {warehouse_number_key(image):[{"value":41,"referenceId":"original"}]}
        result = ocr.read_many([image],warehouse=True,source_sizes=[(43,43)])[0]
        self.assertEqual(result["valueSource"],"VERIFIED_TEMPLATE")
        self.assertEqual(ocr.profile_hits,0)

    def test_registered_counter_proof_is_resolved_without_collecting_duplicates(self):
        ocr = self.configured()
        field = ocr.trade_count(self.count_row())
        self.assertEqual(field["corrected"],5)
        self.assertTrue(registry.verified_numeric_profile_field(field,"count"))
        details={"engineId":"test","modelVersion":"test","workerVersion":"test","corrections":[],
                 "snapshot":{"rows":[{"ordinal":0,"rowBox":{"x":0,"y":0,"width":987,"height":70},"fields":{"count":field}}]}}
        self.assertIsNone(_trade_sample_collection({"imageBytes":b"source"},details))
        changed=copy.deepcopy(details)
        changed["snapshot"]["rows"][0]["fields"]["count"]["corrected"]=6
        self.assertIsNotNone(_trade_sample_collection({"imageBytes":b"source"},changed))

    def test_tag_stale_hash_missing_suffix_and_bad_references_are_not_proof(self):
        field=self.configured().trade_count(self.count_row())
        variants=[]
        value=copy.deepcopy(field);value.pop("numericEvidence");variants.append(value)
        value=copy.deepcopy(field);value["numericEvidence"]["profileFileSha256"]="0"*64;variants.append(value)
        value=copy.deepcopy(field);value["numericEvidence"].pop("suffix");variants.append(value)
        value=copy.deepcopy(field);value["numericEvidence"]["digits"][0]["referenceId"]=[];variants.append(value)
        value=copy.deepcopy(field);value["numericEvidence"]=None;variants.append(value)
        value=copy.deepcopy(field);value["reviewRequired"]=True;variants.append(value)
        for value in variants:
            self.assertFalse(registry.verified_numeric_profile_field(value,"count"))

    def test_broken_profile_falls_back_instead_of_trusting_modified_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/registry.PROFILE_FILES["warehouse"][0]).write_text('{}')
            registry.load_numeric_profile.cache_clear()
            with patch.object(registry,"PROFILE_ROOT",root):
                self.assertIsNone(registry.load_numeric_profile("warehouse"))

    def test_current_capture_cache_is_cleared_and_profile_result_is_not_recounted(self):
        ocr=self.configured();row=self.count_row()
        ocr.trade_count(row);ocr.trade_count(row)
        self.assertEqual(ocr.profile_hits,1)
        self.assertEqual(len(ocr._profile_cache),1)
        ocr.configure_trade(Image.new('RGB',(987,456)),{},Mock())
        self.assertEqual(ocr._profile_cache,{})
        self.assertIsNone(ocr.trade_count(row))


if __name__ == '__main__':
    unittest.main()
