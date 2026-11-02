"""Original-pixel numeric evidence first; OCR supplies unverified proposals."""
from __future__ import annotations

import re
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps
from barter.recognition_profiles import load_numeric_profile, numeric_profile_result


def warehouse_number_key(image):
    # Preserve the entire slot at two thresholds, including every possible leading digit.
    rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    if rgb.shape != (43, 43, 3):
        return None
    low, high = rgb.min(axis=2), rgb.max(axis=2)
    masks = [(low > 100) & (high-low < 80), (low > 145) & (high-low < 55)]
    return "43x43:" + hashlib.sha256(b"".join(np.packbits(mask).tobytes() for mask in masks)).hexdigest()


def number_views(image, *, warehouse=False):
    import cv2
    image = image.convert("RGB")
    if not warehouse:
        return [("whole", image), ("inverted", ImageOps.invert(image))]
    if warehouse:
        image = image.crop((0, round(image.height * .58), image.width, image.height))
    rgb = np.asarray(image)
    white = ((rgb.min(axis=2) > 145) & (rgb.max(axis=2) - rgb.min(axis=2) < 55)).astype(np.uint8)
    raw = ImageOps.expand(image, 5, fill="black")
    views = [("whole", raw)]
    count, labels, stats, _ = cv2.connectedComponentsWithStats(white, 8)
    minimum = max(3, round(image.height * .35))
    large = [i for i in range(1, count) if stats[i, 3] >= minimum and stats[i, 2] >= 2]
    if not large:
        return views
    anchor = max(large, key=lambda i: stats[i, 0] + stats[i, 2])
    a = stats[anchor]; selected = []; left = int(a[0] + a[2])
    for i in sorted(large, key=lambda i: stats[i, 0], reverse=True):
        b = stats[i]
        if abs(int(b[1] + b[3] - a[1] - a[3])) > 2 or b[0] + b[2] > a[0] + a[2] + 1:
            continue
        # A narrow '1' leaves four blank columns before the next digit in the current font.
        if left - (b[0] + b[2]) > max(3, round(a[3] * .4)):
            break
        selected.append(i); left = min(left, int(b[0]))
    keep = np.isin(labels, selected)
    ys, xs = np.nonzero(keep)
    if not len(xs):
        return views
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    core = Image.fromarray((keep * 255).astype(np.uint8)).convert("RGB").crop(box)
    color = image.crop(box)
    views.extend([("glyphs", ImageOps.expand(core, 5, fill="black")),
                  ("glyphs-inverted", ImageOps.expand(ImageOps.invert(core), 5, fill="white")),
                  ("tight-color", ImageOps.expand(color, 5, fill="black")),
                  ("tight-color-inverted", ImageOps.expand(ImageOps.invert(color), 5, fill="white"))])
    return views


def decide_number(readings, *, minimum=0, maximum=9999, require_whole=False):
    variants, votes, methods, whole = [], {}, {}, set()
    for method, (text, confidence) in readings:
        match = re.fullmatch(r"[^\w+\-]*([0-9]+(?:[,. ][0-9]+)*)[^\w+\-]*", text)
        token = re.sub(r"[,. ]", "", match[1]) if match else ""
        value = int(token) if token and len(token) <= 4 else None
        if value is not None and not minimum <= value <= maximum:
            value = None
        variants.append({"text": text, "confidence": confidence, "method": method})
        if value is not None and method.split(":")[-1] == "whole" and confidence >= .80:
            whole.add(value)
        if value is not None and confidence >= .85:
            votes.setdefault(value, []).append(confidence)
            methods.setdefault(value, set()).add(method.split(":")[-1])
    agreed = [value for value in votes if len(methods[value]) >= 2]
    strong = {value for value, scores in votes.items() if max(scores) >= .97}
    accepted = len(agreed) == 1 and not (strong - set(agreed)) and not (whole - set(agreed))
    if require_whole:
        accepted = accepted and bool(whole & set(agreed))
    value = agreed[0] if accepted else None
    return {"status": "QUANTITY_MATCH" if accepted else "QUANTITY_UNKNOWN", "value": value,
            "rawOCR": variants[0]["text"] if variants else "", "variants": variants,
            "confidence": min(votes[value]) if accepted else None,
            "method": "whole-number-onnx-consensus", "valueSource": "NUMERIC_OCR_CONSENSUS",
            **({"reason": "ocr_disagreement_or_uncertain"} if not accepted else {})}


class NumericOCR:
    def __init__(self, reader, *, template_bank_path=None, use_numeric_profiles=True):
        self.reader = reader
        self.template_bank_path = template_bank_path
        self.warehouse_bank = None
        self.warehouse_bank_sha = None
        self.template_hits = 0
        self.glyph_hits = 0
        self.bank_data = None
        self.visual = None
        self.non_items = []
        self.use_numeric_profiles = use_numeric_profiles
        self.profile_hits = 0
        self._profile_readers = {}
        self._trade_layout = None
        self._trade_templates = None
        self._profile_cache = {}

    def _profile_reader(self, kind):
        if not self.use_numeric_profiles:
            return None
        if kind not in self._profile_readers:
            value = None
            profile = load_numeric_profile(kind)
            if profile is not None:
                try:
                    if kind == "warehouse":
                        from .numeric_profile import NumericProfile
                        value = NumericProfile(profile)
                    else:
                        from .trade_numeric_profile import TradeNumericProfile
                        value = TradeNumericProfile(profile)
                except (ImportError, ValueError, KeyError, TypeError):
                    pass
            self._profile_readers[kind] = value
        return self._profile_readers[kind]

    def configure_trade(self, image, metadata, templates):
        self._profile_cache.clear()
        self._trade_layout = None
        self._trade_templates = templates
        if self.use_numeric_profiles and metadata.get("fidelity", {}).get("evidence") == "native-pixels":
            from .trade_numeric_profile import native_frame_offset
            self._trade_layout = native_frame_offset(image, metadata)

    def _trade_profile_result(self, row, field, alignment_offset=0):
        decoder = self._profile_reader("trade")
        if decoder is None or self._trade_layout is None:
            return None
        digest = hashlib.sha256(row.convert("RGB").tobytes()).hexdigest()
        key = row.size, digest, field, alignment_offset
        if key not in self._profile_cache:
            offset = self._trade_layout-alignment_offset
            raw = decoder.read(row, field, layout_offset=offset)
            result = numeric_profile_result("trade", field, raw, input_sha256=digest)
            if result is not None:
                shift = offset-decoder.profile["layoutOffset"]
                x, y = (183+shift, 17) if field == "count" else ((283 if field == "reqAmount" else 658)+shift, 12)
                result["numericEvidence"].update(region={"x":x,"y":y,"width":43,"height":43}, inputSize=list(row.size))
                self.profile_hits += 1
            self._profile_cache[key] = result
        return self._profile_cache[key]

    def trade_count(self, row, alignment_offset=0):
        result = self._trade_profile_result(row, "count", alignment_offset)
        return {**result, "corrected":result["value"], "reviewRequired":False} if result else None

    def _load_bank(self):
        if self.bank_data is None:
            from .trade_template_reader import BANK_SHA256
            from .visual_numbers import VisualNumbers
            self.bank_data = {}
            try:
                path = self.template_bank_path or Path(__file__).resolve().parents[1] / "recognition_data/trade-templates.json"
                data = Path(path).read_bytes()
                if hashlib.sha256(data).hexdigest() == BANK_SHA256:
                    self.bank_data = json.loads(data)
                    self.warehouse_bank_sha = BANK_SHA256
            except (OSError, ValueError, TypeError):
                pass
            self.visual = VisualNumbers(self.bank_data.get("digitGlyphs", []))
            import zlib
            self.non_items = [(entry, np.frombuffer(zlib.decompress(bytes.fromhex(entry["pixels"])), dtype=np.uint8).reshape(43,43,3))
                              for entry in self.bank_data.get("warehouseNonItems", [])
                              if entry.get("verification") == "ORIGINAL_IMAGE_AUDIT"]
        return self.bank_data

    def visual_result(self, evidence, *, minimum=0, maximum=9999):
        if evidence is None or not minimum <= evidence["value"] <= maximum:
            return None
        self.glyph_hits += 1
        return {"status":"QUANTITY_MATCH", "value":evidence["value"], "rawOCR":"", "variants":[],
                "confidence":None, "method":"audited-complete-numeric-glyphs", "valueSource":"VERIFIED_NUMERIC_GLYPHS",
                "numericEvidence":{"bankSha256":self.warehouse_bank_sha, **evidence}}

    def trade(self, row, field, extractor, *, alignment_offset=0):
        if self.use_numeric_profiles and self._trade_templates is not None:
            cached = self._trade_templates.match("quantity", None, row=row, field=field)
            if cached:
                return {**cached, "value":cached["corrected"], "status":"QUANTITY_MATCH"}
            result = self._trade_profile_result(row, field, alignment_offset)
            if result:
                return result
        self._load_bank()
        return self.visual_result(self.visual.trade(row, field, extractor), minimum=1)

    def non_item(self, image):
        pixels = np.asarray(image.convert("RGB"), dtype=np.int16)
        if pixels.shape != (43,43,3):
            return None
        self._load_bank()
        for entry, reference in self.non_items:
            difference = np.abs(pixels-reference)
            if difference.max() <= 3 and np.mean(difference.astype(float)**2) <= .36:
                return {"kind":entry["kind"], "referenceId":entry["referenceId"], "bankSha256":self.warehouse_bank_sha}
            if (pixels.max(axis=2)-pixels.min(axis=2)).max() <= 12 and (reference.max(axis=2)-reference.min(axis=2)).max() <= 12:
                if all(np.array_equal(pixels.min(axis=2)>level, reference.min(axis=2)>level) for level in (65,95)):
                    return {"kind":entry["kind"], "referenceId":entry["referenceId"], "bankSha256":self.warehouse_bank_sha,
                            "method":"neutral-control-two-mask-exact"}
        return None

    def _warehouse_templates(self):
        if self.warehouse_bank is None:
            self.warehouse_bank = self._load_bank().get("warehouseLookup", {})
        return self.warehouse_bank

    def read_many(self, images, *, warehouse=False, minimum=0, maximum=9999, source_sizes=None):
        if source_sizes is not None and len(source_sizes) != len(images):
            raise ValueError("native source sizes must match image count")
        matches, pending, indices = {}, [], []
        bank = self._warehouse_templates() if warehouse else {}
        for index, image in enumerate(images):
            refs = bank.get(warehouse_number_key(image), []) if warehouse else []
            values = {r["value"] for r in refs}
            if len(values) == 1 and type(next(iter(values))) is int and minimum <= next(iter(values)) <= maximum:
                value = next(iter(values)); self.template_hits += 1
                matches[index] = {"status":"QUANTITY_MATCH", "value":value, "rawOCR":"", "variants":[],
                                  "confidence":None, "method":"whole-slot-two-mask-exact", "valueSource":"VERIFIED_TEMPLATE",
                                  "templateEvidence":{"bankSha256":self.warehouse_bank_sha,"references":refs}}
            else:
                decoder = self._profile_reader("warehouse") if warehouse and source_sizes is not None and tuple(source_sizes[index]) == (43,43) else None
                if decoder is not None:
                    raw = decoder.read(image)
                    if raw["value"] is not None and minimum <= raw["value"] <= maximum:
                        result = numeric_profile_result("warehouse", "quantity", raw,
                            input_sha256=hashlib.sha256(image.convert("RGB").tobytes()).hexdigest())
                        if result is not None:
                            result["numericEvidence"].update(region={"x":0,"y":0,"width":43,"height":43}, inputSize=[43,43])
                            matches[index] = result
                            self.profile_hits += 1
                            continue
                self._load_bank()
                evidence = self.visual.warehouse(image) if warehouse else self.visual.isolated(image)
                visual = self.visual_result(evidence, minimum=minimum, maximum=maximum)
                if visual:
                    matches[index] = visual
                    continue
                indices.append(index); pending.append(image)
        if not pending:
            return [matches[index] for index in range(len(images))]
        groups = [number_views(image, warehouse=warehouse) for image in pending]
        values = iter(self.reader.read_many([image for group in groups for _, image in group]))
        results = []
        for source_image, group in zip(pending, groups):
            readings = [(method, next(values)) for method, _ in group]
            result = decide_number(readings, minimum=minimum, maximum=maximum, require_whole=warehouse)
            if result["value"] is None:
                for method, view_image in group:
                    if method in {"whole", "tight-color"}:
                        readings.append(("full-width:" + method, self.reader.read(view_image)))
                result = decide_number(readings, minimum=minimum, maximum=maximum, require_whole=warehouse)
            visual = self.visual.outlined_warehouse(source_image) if warehouse else None
            if visual and result['value'] == visual['value']:
                whole = [(text,score) for method,(text,score) in readings if method.split(':')[-1]=='whole']
                if any(text.strip()==str(visual['value']) and score>=.90 for text,score in whole):
                    hit = self.visual_result(visual, minimum=minimum, maximum=maximum)
                    hit.update(rawOCR=result['rawOCR'], variants=result['variants'])
                    hit['numericEvidence']['method'] = 'outlined-glyphs-and-whole-ocr'
                    results.append(hit)
                    continue
            # Multiple OCR views share the same model and can agree on the same wrong digit.
            result.update(candidate=result["value"], value=None, status="QUANTITY_UNKNOWN",
                          reason="numeric_visual_evidence_missing", valueSource="NUMERIC_OCR_CANDIDATE")
            results.append(result)
        matches.update(zip(indices, results))
        return [matches[index] for index in range(len(images))]
