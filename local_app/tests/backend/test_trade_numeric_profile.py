import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

from barter.tools.numeric_profile import canonical_bytes
from barter.tools.trade_numeric_profile import TradeNumericProfile, native_frame_offset
from barter.tools.fit_trade_numeric_profile import fit_profile, load_dataset


class TradeNumericProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = json.loads((Path(__file__).resolve().parents[3]/
            "barter/recognition_data/numeric-profile-trade-experimental.json").read_text(encoding="utf-8"))
        cls.masks = {}
        for kind, context in cls.profile["contexts"].items():
            cls.masks[kind] = {}
            for glyph in context["glyphs"]:
                cls.masks[kind].setdefault(glyph["digit"], np.array(glyph["mask"], dtype=bool))

    def white_row(self, text, field="reqAmount", shift=0):
        # Synthetic layout checks using native glyph shapes, not accuracy evidence.
        row = np.zeros((70, 987, 3), dtype=np.uint8)
        left = (283 if field == "reqAmount" else 658)+shift
        for index, char in enumerate(text):
            digit = int(char)
            mask = self.masks["white"][digit]
            height, width = mask.shape
            end = (36 if digit == 1 else 39 if digit == 4 else 38)-9*(len(text)-index-1)
            row[41:41+height, left+end-width:left+end][mask] = 255
        return row

    def count_row(self, text, suffix=True):
        row = np.zeros((70, 987, 3), dtype=np.uint8)
        context = self.profile["contexts"]["yellow"]
        tile = np.full((43, 43, 3), context["outline"], dtype=np.uint8)
        for index, char in enumerate(text):
            digit = int(char)
            mask = self.masks["yellow"][digit]
            height, width = mask.shape
            x = (4 if digit == 1 else 1 if digit == 4 else 2)+11*index
            tile[22:22+height, x:x+width][mask] = context["foreground"]
        if suffix:
            tail = np.array(self.profile["countSuffix"]["mask"], dtype=bool)
            tail_x = 24 if len(text) == 2 else 14 if text == "4" else 13
            tile[21:21+tail.shape[0], tail_x:tail_x+tail.shape[1]][tail] = context["foreground"]
        row[17:60, 183:226] = tile
        return row

    def test_quantity_sequence_and_complete_zeroes(self):
        core = TradeNumericProfile(self.profile)
        for text in ["1", "2", "3", "41", "47", "70", "85", "100", "101", "300", "485", "1243"]:
            with self.subTest(text=text):
                self.assertEqual(core.read(self.white_row(text), "reqAmount", layout_offset=-4)["value"], int(text))

    def test_both_item_columns_and_verified_translation(self):
        core = TradeNumericProfile(self.profile)
        for field in ["reqAmount", "yield"]:
            for shift in [-1, 0, 2]:
                with self.subTest(field=field, shift=shift):
                    self.assertEqual(core.read(self.white_row("300", field, shift), field,
                                               layout_offset=-4+shift)["value"], 300)

    def test_yellow_single_and_two_digit_counts(self):
        core = TradeNumericProfile(self.profile)
        for text in ["0", "1", "2", "3", "4", "5", "6", "10"]:
            with self.subTest(text=text):
                self.assertEqual(core.read(self.count_row(text), "count", layout_offset=-4)["value"], int(text))

    def test_suffix_cannot_be_treated_as_the_number_zero(self):
        core = TradeNumericProfile(self.profile)
        self.assertIsNone(core.read(self.count_row("5", suffix=False), "count", layout_offset=-4)["value"])
        self.assertEqual(core.read(self.count_row("10"), "count", layout_offset=-4)["value"], 10)

    def test_faint_prefix_is_not_dropped_in_either_color(self):
        core = TradeNumericProfile(self.profile)
        row = self.white_row("17")
        row[41:52, 283+23:283+27] = (row[41:52, 283+23:283+27].astype(float)*.45).astype(np.uint8)
        self.assertIsNone(core.read(row, "reqAmount", layout_offset=-4)["value"])
        row = self.count_row("10")
        front = np.array(self.profile["contexts"]["yellow"]["foreground"])
        back = np.array(self.profile["contexts"]["yellow"]["outline"])
        region = row[39:53, 187:191]
        region[(region == front).all(2)] = (back+.4*(front-back)).astype(np.uint8)
        self.assertIsNone(core.read(row, "count", layout_offset=-4)["value"])

    def test_unknown_is_not_zero_and_zero_item_quantity_is_rejected(self):
        core = TradeNumericProfile(self.profile)
        self.assertIsNone(core.read(np.zeros((70,987,3), dtype=np.uint8), "reqAmount", layout_offset=-4)["value"])
        self.assertIsNone(core.read(self.white_row("0"), "reqAmount", layout_offset=-4)["value"])

    def test_geometry_and_unverified_layout_are_rejected(self):
        core = TradeNumericProfile(self.profile)
        self.assertIsNone(core.read(self.white_row("1"), "reqAmount")["value"])
        self.assertIsNone(core.read(np.zeros((140,987,3)), "reqAmount", layout_offset=-4)["value"])

    def test_profile_and_state_are_not_mutated_by_count_decoding(self):
        core = TradeNumericProfile(self.profile)
        before = canonical_bytes(core.profile)
        core.read(self.count_row("10"), "count", layout_offset=-4)
        core.read(self.count_row("5"), "count", layout_offset=-4)
        self.assertEqual(before, canonical_bytes(core.profile))

    def test_integrity_failure_is_not_ignored(self):
        profile = copy.deepcopy(self.profile)
        profile["layoutOffset"] += 1
        with self.assertRaises(ValueError):
            TradeNumericProfile(profile)

    def test_frame_translation_needs_both_native_panel_edges(self):
        array = np.zeros((456,987,3), dtype=np.uint8)
        array[:,3:] = 70
        array[:,268:] = 150
        metadata = {"sourceType":"native-screen", "fidelity":{"rescaled":False}}
        self.assertEqual(native_frame_offset(Image.fromarray(array), metadata), -4)
        self.assertIsNone(native_frame_offset(Image.fromarray(array), {"sourceType":"native-screen"}))
        array[:,268:] = 70
        array[:,269:] = 150
        self.assertIsNone(native_frame_offset(Image.fromarray(array), metadata))

    def test_dev_or_unverified_glyphs_cannot_be_fitted(self):
        annotation = {"field":"white", "rowIndex":0, "sourceField":"reqAmount", "verification":"unchecked"}
        for split, verification in [("dev", "ORIGINAL_IMAGE_AUDIT"), ("train", "ORIGINAL_IMAGE_AUDIT")]:
            manifest = {"records":[{"rowIndex":0, "field":"reqAmount", "split":split, "verification":verification}]}
            with self.assertRaises(ValueError):
                fit_profile(manifest, np.zeros((1,70,987,3), dtype=np.uint8), [annotation], {})

    def test_source_leak_across_batches_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            np.savez_compressed(path/"rows.npz", pixels=np.zeros((1,70,987,3), dtype=np.uint8))
            records = [{"id":str(i), "group":str(i), "split":role, "sourceSha256":"same-source",
                "verification":"ORIGINAL_IMAGE_AUDIT", "field":"count", "value":5, "rowIndex":0}
                for i, role in enumerate(["train", "test"])]
            (path/"dataset.json").write_text(json.dumps({"rowArchive":"rows.npz", "records":records}))
            with self.assertRaises(ValueError):
                load_dataset(path/"dataset.json")


if __name__ == "__main__":
    unittest.main()
