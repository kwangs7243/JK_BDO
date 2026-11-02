"""Offline current-font numeric prototype; deliberately not wired into the app.

The profile contains original-pixel glyph masks, not rendered OCR answers.
Scores are pixel distances, not probabilities. Whole-field caches are not used.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path

import numpy as np


VERSION = "warehouse-palette-sequence-v1"


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_dataset(path):
    path = Path(path)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    with np.load(path.parent / manifest["pixelArchive"], allow_pickle=False) as archive:
        pixels = archive["pixels"].copy()
    records = manifest["records"]
    if pixels.shape != (len(records), 43, 43, 3) or pixels.dtype != np.uint8:
        raise ValueError("expected native 43x43 RGB slots")
    identifiers, roles, sources = set(), {}, {}
    for record in records:
        if record["id"] in identifiers:
            raise ValueError("duplicate observation")
        identifiers.add(record["id"])
        split = record["split"]
        if split not in {"train", "dev", "test", "retrospective"}:
            raise ValueError("unknown split")
        for mapping, key in [(roles, record["group"]), (sources, record["sourceSha256"])]:
            if key in mapping and mapping[key] != split:
                raise ValueError("a scan/source crosses dataset splits")
            mapping[key] = split
        if record.get("verification") != "ORIGINAL_IMAGE_AUDIT":
            raise ValueError("OCR or unchecked labels are not training truth")
        if type(record["value"]) is not int or not 0 <= record["value"] <= 9999:
            raise ValueError("unsupported or unknown quantity label")
    return manifest, pixels


def fit_profile(manifest, pixels, glyph_annotations):
    """Fit only the explicitly audited TRAIN crops; DEV/TEST labels are unused."""
    import cv2

    records = {record["id"]: (record, image) for record, image in zip(manifest["records"], pixels)}
    glyphs, foreground, outlines, labels_by_mask = [], [], [], {}
    for annotation in glyph_annotations:
        record, image = records[annotation["recordId"]]
        if record["split"] != "train":
            raise ValueError("glyph provenance must be TRAIN")
        if record.get("verification") != "ORIGINAL_IMAGE_AUDIT" or type(record["value"]) is not int or not 0 <= record["value"] <= 9999:
            raise ValueError("token requires independently audited numeric truth")
        if annotation.get("verification") != "ORIGINAL_GLYPH_AUDIT":
            raise ValueError("unverified segmentation")
        digit = annotation["digit"]
        position = annotation["digitIndex"]
        text = str(record["value"])
        if type(digit) is not int or not 0 <= position < len(text) or text[position] != str(digit):
            raise ValueError("glyph and independently verified token label disagree")
        x, y, width, height = annotation["box"]
        if min(x, y) < 1 or width < 2 or not 7 <= height <= 16 or x+width >= 43 or y+height >= 43:
            raise ValueError("glyph must include its surrounding outline")
        rgb = image[y:y+height, x:x+width].astype(np.int16)
        mask = (rgb.min(2) > 145) & (np.ptp(rgb, axis=2) < 55)
        if not mask.any() or not mask[0].any() or not mask[-1].any() or not mask[:, 0].any() or not mask[:, -1].any():
            raise ValueError("glyph annotation is not a tight original-pixel crop")
        key = mask.shape, mask.tobytes()
        if key in labels_by_mask and labels_by_mask[key] != digit:
            raise ValueError("the same original glyph has contradictory labels")
        labels_by_mask[key] = digit
        foreground.extend(map(tuple, rgb[mask].tolist()))
        padded = np.pad(mask, 1)
        ring = cv2.dilate(padded.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~padded
        outlines.extend(map(tuple, image[y-1:y+height+1, x-1:x+width+1][ring].tolist()))
        glyphs.append({"digit": digit, "mask": mask.astype(int).tolist(), "source": {
            "recordId": record["id"], "sourceSha256": record["sourceSha256"],
            "group": record["group"], "digitIndex": position, "box": annotation["box"],
            "verification": "ORIGINAL_GLYPH_AUDIT"}})
    if {entry["digit"] for entry in glyphs} != set(range(10)):
        raise ValueError("the profile requires audited examples of all ten digits")
    front = list(Counter(foreground).most_common(1)[0][0])
    back = list(Counter(outlines).most_common(1)[0][0])
    if min(front)-max(back) < 100:
        raise ValueError("foreground and outline are not separable")
    profile = {"version": VERSION, "status": "OFFLINE_EXPERIMENT_ONLY", "fontProfile": manifest["profile"],
        "slotSize": [43, 43], "foreground": front, "outline": back,
        "parameters": {"minimumInk": 145, "colorTolerance": 2, "maxGlyphDifference": 3,
            "minimumTokenMargin": 3, "tops": [27, 28, 29], "maximumGap": 6,
            "rightEnds": {str(digit): ([36, 37] if digit == 1 else [38, 39]) for digit in range(10)},
            "maxDigits": 4, "maximumPaths": 256},
        "glyphs": glyphs,
        "trainGroups": sorted({record["group"] for record in manifest["records"] if record["split"] == "train"})}
    return {**profile, "sha256": hashlib.sha256(canonical_bytes(profile)).hexdigest()}


class NumericProfile:
    def __init__(self, profile):
        supplied = dict(profile)
        checksum = supplied.pop("sha256")
        if hashlib.sha256(canonical_bytes(supplied)).hexdigest() != checksum or supplied["version"] != VERSION:
            raise ValueError("profile integrity/version mismatch")
        self.profile = profile
        self.parameters = profile["parameters"]
        self.glyphs = [(entry, np.array(entry["mask"], dtype=bool)) for entry in profile["glyphs"]]
        self.foreground = np.array(profile["foreground"], dtype=float)
        self.outline = np.array(profile["outline"], dtype=float)

    def ink(self, rgb):
        axis = self.foreground-self.outline
        level = ((rgb-self.outline)*axis).sum(2)/(axis*axis).sum()
        residual = np.abs(rgb-(self.outline+level[:, :, None]*axis)).max(2)
        return ((residual <= self.parameters["colorTolerance"]) &
                (rgb.min(2) > self.parameters["minimumInk"]) &
                (rgb.max(2) < self.foreground.max()+3))

    def _placements(self, ink, tops, difference):
        candidates = []
        for entry, mask in self.glyphs:
            height, width = mask.shape
            for y in tops:
                if y < 1 or y+height >= ink.shape[0]:
                    continue
                for x in range(1, ink.shape[1]-width):
                    distance = int(np.count_nonzero(ink[y:y+height, x:x+width] != mask))
                    if distance <= difference:
                        candidates.append({"digit": entry["digit"], "x": x, "y": y,
                            "end": x+width, "height": height, "difference": distance,
                            "source": entry["source"]})
        return candidates

    def _extra_ink(self, ink, left, top, height):
        import cv2

        width = left
        if not width:
            return True
        _, _, stats, _ = cv2.connectedComponentsWithStats(
            ink[:, :left].astype(np.uint8), 8)
        return any(7 <= h <= 16 and w >= 2 and y >= top-1 and abs(y+h-top-height) <= 1
                   for x, y, w, h, area in stats[1:])

    def _gap_clear(self, ink, left, right):
        if not self.parameters.get("requireClearGap", False):
            return True
        top = min(left["y"], right["y"])
        bottom = max(left["y"]+left["height"], right["y"]+right["height"])
        return not ink[top:bottom, left["end"]:right["x"]].any()

    def read(self, image):
        rgb = np.asarray(image, dtype=float)
        unknown = {"status": "QUANTITY_UNKNOWN", "value": None, "candidate": None,
                   "valueSource": "NUMERIC_PROFILE_EXPERIMENT", "profileSha256": self.profile["sha256"]}
        if rgb.shape != (43, 43, 3):
            return {**unknown, "reason": "profile_geometry_mismatch"}
        ink = self.ink(rgb)
        candidates = self._placements(ink, self.parameters["tops"], self.parameters["maxGlyphDifference"])
        completed, visited = {}, 0

        def grow(sequence):
            nonlocal visited
            visited += 1
            if visited > self.parameters["maximumPaths"]:
                return
            first = sequence[0]
            left, top = first["x"], first["y"]
            if not self._extra_ink(ink, left, top, first["height"]):
                text = "".join(str(candidate["digit"]) for candidate in sequence)
                if len(text) == 1 or not text.startswith("0"):
                    score = sum(candidate["difference"] for candidate in sequence)
                    if text not in completed or score < completed[text][0]:
                        completed[text] = score, sequence
            if len(sequence) >= self.parameters["maxDigits"]:
                return
            for candidate in candidates:
                if (candidate["y"] == top and 0 <= left-candidate["end"] <= self.parameters["maximumGap"]
                        and self._gap_clear(ink, candidate, first)):
                    grow([candidate]+sequence)

        for candidate in candidates:
            if candidate["end"] in self.parameters["rightEnds"][str(candidate["digit"])]:
                grow([candidate])
        if visited > self.parameters["maximumPaths"]:
            return {**unknown, "reason": "segmentation_limit"}
        ranked = sorted(completed.items(), key=lambda item: item[1][0])
        if not ranked:
            return {**unknown, "reason": "no_complete_token"}
        text, (score, sequence) = ranked[0]
        candidate = int(text)
        if len(ranked) > 1 and ranked[1][1][0]-score < self.parameters["minimumTokenMargin"]:
            return {**unknown, "candidate": candidate, "reason": "ambiguous_token"}
        first, last = sequence[0], sequence[-1]
        # A different faint digit to either side must not be silently dropped.
        low = (rgb.min(2) > 100) & (np.ptp(rgb, axis=2) < 80)
        import cv2
        _, low_labels, edges, _ = cv2.connectedComponentsWithStats(low.astype(np.uint8), 8)
        for x, y, width, height, area in edges[1:]:
            clipped_left = x == 0 and 0 <= first["x"]-width <= self.parameters["maximumGap"]
            clipped_right = x+width == 43 and 0 <= x-last["end"] <= self.parameters["maximumGap"]
            aligned = y >= first["y"]-1 and abs(y+height-first["y"]-first["height"]) <= 1
            if 7 <= height <= 16 and aligned and (clipped_left or clipped_right):
                return {**unknown, "candidate": candidate, "reason": "clipped_adjacent_ink"}
        for extra in self._placements(low, [first["y"]], 3):
            before = 0 <= first["x"]-extra["end"] <= self.parameters["maximumGap"]
            after = 0 <= extra["x"]-last["end"] <= self.parameters["maximumGap"]
            if before or after:
                labels = np.unique(low_labels[extra["y"]:extra["y"]+extra["height"], extra["x"]:extra["end"]])
                if any(edges[label, 1] < extra["y"]-1 or
                       edges[label, 1]+edges[label, 3] > extra["y"]+extra["height"]+1
                       for label in labels if label):
                    continue
                return {**unknown, "candidate": candidate, "reason": "unexplained_adjacent_digit"}
        return {"status": "QUANTITY_MATCH", "value": candidate, "candidate": candidate,
                "valueSource": "NUMERIC_PROFILE_EXPERIMENT", "profileSha256": self.profile["sha256"],
                "numericEvidence": {"completeToken": True, "difference": score, "glyphs": sequence,
                    "nextDifference": ranked[1][1][0] if len(ranked) > 1 else None}}
