import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from barter.tools.numeric_profile import NumericProfile, canonical_bytes, fit_profile, load_dataset
from barter.tools.fit_numeric_profile import evaluate
from barter.tools.trade_template_reader import unpacked_mask


class NumericProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Synthetic layout harness using native glyph shapes; not an accuracy dataset.
        bank = json.loads((Path(__file__).resolve().parents[3]/"barter/recognition_data/trade-templates.json").read_text(encoding="utf-8"))
        cls.masks = {}
        for entry in bank["digitGlyphs"]:
            mask = unpacked_mask(entry)
            if entry.get("context") == "warehouse" and mask.shape[0] == 11:
                digit = entry["value"]
                if digit not in cls.masks or mask.shape[1] < cls.masks[digit].shape[1]:
                    cls.masks[digit] = mask
        assert set(cls.masks) == set(range(10))
        cls.manifest = {"profile": "synthetic-test-harness", "pixelArchive": "pixels.npz",
            "evaluationType": "synthetic mechanics only", "records": []}
        cls.annotations, pixels = [], []
        for digit in range(10):
            image, boxes = cls.render(str(digit))
            pixels.append(image)
            cls.manifest["records"].append({"id": str(digit), "group": "train-scan", "split": "train",
                "sourceSha256": "train-source", "value": digit, "verification": "ORIGINAL_IMAGE_AUDIT"})
            cls.annotations.append({"recordId": str(digit), "digit": digit, "digitIndex": 0,
                "box": boxes[0], "verification": "ORIGINAL_GLYPH_AUDIT"})
        cls.pixels = np.stack(pixels)
        cls.profile = fit_profile(cls.manifest, cls.pixels, cls.annotations)

    @classmethod
    def render(cls, text):
        image = np.full((43, 43, 3), [31, 30, 30], dtype=np.uint8)
        boxes = []
        for position, char in enumerate(text):
            digit = int(char)
            mask = cls.masks[digit]
            x = 31-9*(len(text)-position-1)+(1 if digit == 1 else -1 if digit == 4 else 0)
            height, width = mask.shape
            image[29:29+height, x:x+width][mask] = [233, 228, 228]
            boxes.append([x, 29, width, height])
        return image, boxes

    def test_blank_is_unknown_and_real_zero_is_zero(self):
        core = NumericProfile(self.profile)
        self.assertIsNone(core.read(np.full((43, 43, 3), 31, dtype=np.uint8))["value"])
        self.assertEqual(core.read(self.render("0")[0])["value"], 0)

    def test_variable_width_sequences_without_a_whole_value_reference(self):
        core = NumericProfile(self.profile)
        for text in ["17", "41", "47", "70", "85", "124", "485", "1243", "5639"]:
            with self.subTest(text=text):
                self.assertEqual(core.read(self.render(text)[0])["value"], int(text))

    def test_faint_leading_digit_is_not_discarded(self):
        core = NumericProfile(self.profile)
        for text in ["17", "41", "70"]:
            image, boxes = self.render(text)
            x, y, width, height = boxes[0]
            image[y:y+height, x:x+width][self.masks[int(text[0])]] = [130, 130, 130]
            self.assertIsNone(core.read(image)["value"])

    def test_clipped_additional_ink_is_not_discarded(self):
        core = NumericProfile(self.profile)
        image, _ = self.render("1243")
        image[29:40, 0] = [130, 130, 130]
        self.assertIsNone(core.read(image)["value"])
        image, _ = self.render("70")
        image[29:40, 42] = [130, 130, 130]
        self.assertIsNone(core.read(image)["value"])

    def test_distant_prefix_cannot_be_silently_treated_as_background(self):
        image, _ = self.render("70")
        image[29:40, 3:7][self.masks[1]] = [233, 228, 228]
        self.assertIsNone(NumericProfile(self.profile).read(image)["value"])

    def test_ink_inside_an_interdigit_gap_cannot_be_discarded(self):
        image, _ = self.render("11")
        image[34, 29] = [233, 228, 228]
        profile = copy.deepcopy(self.profile)
        profile["parameters"]["requireClearGap"] = True
        profile["sha256"] = hashlib.sha256(canonical_bytes({k:v for k,v in profile.items() if k!='sha256'})).hexdigest()
        self.assertIsNone(NumericProfile(profile).read(image)["value"])

    def test_tall_artwork_is_not_truncated_into_an_adjacent_digit(self):
        image, _ = self.render("70")
        image[3:41, 41:43] = [130, 130, 130]
        self.assertEqual(NumericProfile(self.profile).read(image)["value"], 70)

    def test_geometry_font_and_support_mismatch_are_unknown(self):
        core = NumericProfile(self.profile)
        self.assertIsNone(core.read(np.zeros((44, 43, 3)))["value"])
        image, _ = self.render("41")
        image[(image == [233, 228, 228]).all(2)] = [255, 255, 255]
        self.assertIsNone(core.read(image)["value"])
        crowded = np.full((43, 43, 3), [31, 30, 30], dtype=np.uint8)
        for x in [11, 16, 21, 26, 31]:
            crowded[29:40, x:x+4][self.masks[1]] = [233, 228, 228]
        self.assertIsNone(core.read(crowded)["value"])

    def test_small_color_change_preserves_supported_ink(self):
        image, _ = self.render("5639")
        image = (image.astype(np.int16)+1).astype(np.uint8)
        self.assertEqual(NumericProfile(self.profile).read(image)["value"], 5639)

    def test_integrity_and_unverified_or_nontrain_glyphs_rejected(self):
        profile = copy.deepcopy(self.profile)
        profile["foreground"][0] += 1
        with self.assertRaises(ValueError):
            NumericProfile(profile)
        annotations = copy.deepcopy(self.annotations)
        annotations[0]["verification"] = "OCR_MATCH"
        with self.assertRaises(ValueError):
            fit_profile(self.manifest, self.pixels, annotations)
        manifest = copy.deepcopy(self.manifest)
        manifest["records"][0]["split"] = "dev"
        with self.assertRaises(ValueError):
            fit_profile(manifest, self.pixels, self.annotations)
        manifest = copy.deepcopy(self.manifest)
        manifest["records"][0]["verification"] = "OCR_MATCH"
        with self.assertRaises(ValueError):
            fit_profile(manifest, self.pixels, self.annotations)

    def test_contradictory_labels_do_not_produce_a_profile(self):
        pixels = self.pixels.copy()
        pixels[8] = pixels[0]
        with self.assertRaisesRegex(ValueError, "contradictory"):
            fit_profile(self.manifest, pixels, self.annotations)

    def test_competing_token_values_are_reviewed(self):
        profile = copy.deepcopy(self.profile)
        other = copy.deepcopy(profile["glyphs"][0])
        other["digit"] = 8
        profile["glyphs"].append(other)
        unhashed = {k: v for k, v in profile.items() if k != "sha256"}
        profile["sha256"] = hashlib.sha256(canonical_bytes(unhashed)).hexdigest()
        result = NumericProfile(profile).read(self.render("0")[0])
        self.assertIsNone(result["value"])
        self.assertEqual(result["reason"], "ambiguous_token")

    def test_fitting_does_not_use_dev_truth_or_pixels(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["records"].append({"id": "dev", "group": "dev", "split": "dev", "sourceSha256": "dev",
            "value": 41, "verification": "ORIGINAL_IMAGE_AUDIT"})
        pixels = np.concatenate([self.pixels, self.render("41")[0][None]])
        first = fit_profile(manifest, pixels, self.annotations)
        manifest["records"][-1]["value"] = 9999
        pixels[-1] = 0
        self.assertEqual(first, fit_profile(manifest, pixels, self.annotations))

    def test_source_and_group_leaks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            manifest = copy.deepcopy(self.manifest)
            manifest["records"][0]["split"] = "dev"
            np.savez_compressed(path/"pixels.npz", pixels=self.pixels)
            (path/"dataset.json").write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                load_dataset(path/"dataset.json")
        with self.assertRaises(ValueError):
            evaluate(self.manifest, self.pixels, self.profile, "train")

    def test_search_budget_exhaustion_cannot_auto_accept(self):
        profile = copy.deepcopy(self.profile)
        profile["parameters"]["maximumPaths"] = 0
        unhashed = {k: v for k, v in profile.items() if k != "sha256"}
        profile["sha256"] = hashlib.sha256(canonical_bytes(unhashed)).hexdigest()
        result = NumericProfile(profile).read(self.render("41")[0])
        self.assertEqual(result["reason"], "segmentation_limit")
        self.assertIsNone(result["value"])


if __name__ == "__main__":
    unittest.main()
