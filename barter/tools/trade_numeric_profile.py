"""Offline trade adapters for the shared original-pixel sequence decoder."""
from __future__ import annotations

import hashlib
from copy import copy
import numpy as np

from .numeric_profile import NumericProfile, canonical_bytes


VERSION = "trade-palette-sequence-v1"


def native_frame_offset(image, metadata):
    from .trade_live_ocr import FIXED_TRADE_SIZE, FIXED_TRADE_ANCHORS

    if (image.size != FIXED_TRADE_SIZE or metadata.get("sourceType") != "native-screen"
            or metadata.get("fidelity", {}).get("rescaled") is not False):
        return None
    rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    edges = np.mean(np.max(np.abs(np.diff(rgb, axis=1)), axis=2) > 20, axis=0)
    offsets = []
    for anchor in FIXED_TRADE_ANCHORS:
        left, right = max(0, anchor-8), min(len(edges), anchor+9)
        actual = left+int(np.argmax(edges[left:right]))
        if edges[actual] < .75:
            return None
        offsets.append(actual-anchor)
    return offsets[0] if len(set(offsets)) == 1 else None


class TradeFieldSequence(NumericProfile):
    def __init__(self, profile, context):
        data = dict(profile)
        checksum = data.pop("sha256")
        if data["version"] != VERSION or hashlib.sha256(canonical_bytes(data)).hexdigest() != checksum:
            raise ValueError("trade numeric profile integrity/version mismatch")
        self.profile = profile
        self.context = profile["contexts"][context]
        self.parameters = self.context["parameters"]
        self.glyphs = [(entry, np.array(entry["mask"], dtype=bool)) for entry in self.context["glyphs"]]
        self.foreground = np.array(self.context["foreground"], dtype=float)
        self.outline = np.array(self.context["outline"], dtype=float)
        self._outlined_glyphs = []
        if self.context.get("outlineDistance"):
            import cv2
            for entry, mask in self.glyphs:
                padded = np.pad(mask, 1)
                ring = cv2.dilate(padded.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~padded
                self._outlined_glyphs.append((entry, mask, ring))

    def _placements(self, ink, tops, difference):
        if not self.context.get("outlineDistance"):
            return super()._placements(ink, tops, difference)
        candidates = {}
        for entry, mask, ring in self._outlined_glyphs:
            height, width = mask.shape
            windows = np.lib.stride_tricks.sliding_window_view(ink, (height+2, width+2))
            for y in tops:
                if y < 1 or y+height >= ink.shape[0]:
                    continue
                strips = windows[y-1]
                scores = (np.count_nonzero(mask & ~strips[:, 1:-1, 1:-1], axis=(1, 2)) +
                          np.count_nonzero(ring & strips, axis=(1, 2)))
                for index in np.flatnonzero(scores <= difference):
                    x, distance = int(index)+1, int(scores[index])
                    key = entry["digit"], x, y, width, height
                    if key not in candidates or distance < candidates[key]["difference"]:
                        candidates[key] = {"digit": entry["digit"], "x": x, "y": y, "end": x+width,
                            "height": height, "difference": distance, "source": entry["source"]}
        return list(candidates.values())

    def _extra_ink(self, ink, left, top, height):
        if not self.context.get("outlineDistance"):
            return super()._extra_ink(ink, left, top, height)
        import cv2
        _, _, stats, _ = cv2.connectedComponentsWithStats(ink[:, :left].astype(np.uint8), 8)
        return any(abs(h-height) <= 1 and w >= 2 and abs(y-top) <= 1 and abs(y+h-top-height) <= 1
                   for x, y, w, h, area in stats[1:])

    def _gap_clear(self, ink, left, right):
        if not self.context.get("outlineDistance"):
            return super()._gap_clear(ink, left, right)
        import cv2
        _, labels, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), 8)
        top, height = left["y"], left["height"]
        for label in np.unique(labels[top:top+height, left["end"]:right["x"]]):
            if not label:
                continue
            x, y, w, h, area = stats[label]
            if abs(h-height) <= 1 and abs(y-top) <= 1:
                return False
        return True

    def ink(self, rgb, *, minimum=None):
        axis = self.foreground-self.outline
        level = ((rgb-self.outline)*axis).sum(2)/(axis*axis).sum()
        residual = np.abs(rgb-(self.outline+level[:, :, None]*axis)).max(2)
        return ((residual <= self.context["colorTolerance"]) & (level <= 1.02) &
                (level > (self.context["minimumLevel"] if minimum is None else minimum)))


class TradeNumericProfile:
    def __init__(self, profile):
        self.profile = profile
        self.white = TradeFieldSequence(profile, "white")
        self.yellow = TradeFieldSequence(profile, "yellow")

    def _unknown(self, reason, candidate=None):
        return {"status": "QUANTITY_UNKNOWN", "value": None, "candidate": candidate,
                "reason": reason, "valueSource": "NUMERIC_PROFILE_EXPERIMENT",
                "profileSha256": self.profile["sha256"]}

    def read(self, row, field, *, layout_offset=None):
        rgb = np.asarray(row, dtype=float)
        if rgb.shape not in {(70, 987, 3), (69, 987, 3)} or field not in {"reqAmount", "yield", "count"}:
            return self._unknown("profile_geometry_mismatch")
        if type(layout_offset) is not int or not -8 <= layout_offset <= 8:
            return self._unknown("unverified_layout")
        shift = layout_offset-self.profile["layoutOffset"]
        if field != "count":
            left = (283 if field == "reqAmount" else 658)+shift
            result = self.white.read(rgb[12:55, left:left+43])
            if result["value"] is not None and result["value"] < 1:
                return self._unknown("quantity_out_of_range", result["value"])
            return result
        tile = rgb[17:60, 183+shift:226+shift].copy()
        ink = self.yellow.ink(tile)
        tail = np.array(self.profile["countSuffix"]["mask"], dtype=bool)
        height, width = tail.shape
        matches = []
        for y in self.profile["countSuffix"]["tops"]:
            for x in range(10, 43-width):
                difference = int(np.count_nonzero(ink[y:y+height, x:x+width] != tail))
                if difference <= 3:
                    matches.append((difference, x, y))
        if not matches:
            return self._unknown("count_suffix_missing")
        matches.sort()
        if len(matches) > 1 and matches[1][0]-matches[0][0] < 3:
            return self._unknown("count_suffix_ambiguous")
        _, tail_x, tail_y = matches[0]
        # Remove only the complete, verified Korean suffix. No numeral is erased.
        tile[:, tail_x:] = self.yellow.outline
        decoder = copy(self.yellow)
        decoder.parameters = {**decoder.parameters, "rightEnds": {
            digit: [end for end in ends if 0 <= tail_x-end <= 5]
            for digit, ends in decoder.parameters["rightEnds"].items()}}
        result = decoder.read(tile)
        if result["value"] is None:
            return result
        value = result["value"]
        if not 0 <= value <= 10:
            return self._unknown("count_out_of_range", value)
        glyphs = result["numericEvidence"]["glyphs"]
        if not 0 <= tail_x-glyphs[-1]["end"] <= 5:
            return self._unknown("count_suffix_gap", value)
        covered = np.zeros((43, 43), dtype=bool)
        for glyph in glyphs:
            covered[max(0, glyph["y"]-1):glyph["y"]+glyph["height"]+1,
                    max(0, glyph["x"]-1):glyph["end"]+1] = True
        if (self.yellow.ink(tile, minimum=.28) & ~covered).any():
            return self._unknown("unexplained_count_ink", value)
        result["numericEvidence"]["suffix"] = {"x": tail_x, "y": tail_y, "verification": "ORIGINAL_GLYPH_AUDIT"}
        return result
