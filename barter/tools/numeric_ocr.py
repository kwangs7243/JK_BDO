"""Whole-number neural recognition; no fixed-width digit cells or glyph templates."""
from __future__ import annotations

import re
import numpy as np
from PIL import Image, ImageOps


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
        if left - (b[0] + b[2]) > 3:
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


def decide_number(readings, *, minimum=0, maximum=9999):
    variants, votes, methods = [], {}, {}
    for method, (text, confidence) in readings:
        match = re.fullmatch(r"[^\w+\-]*([0-9]+(?:[,. ][0-9]+)*)[^\w+\-]*", text)
        token = re.sub(r"[,. ]", "", match[1]) if match else ""
        value = int(token) if token and len(token) <= 4 else None
        if value is not None and not minimum <= value <= maximum:
            value = None
        variants.append({"text": text, "confidence": confidence, "method": method})
        if value is not None and confidence >= .85:
            votes.setdefault(value, []).append(confidence)
            methods.setdefault(value, set()).add(method.split(":")[-1])
    agreed = [value for value in votes if len(methods[value]) >= 2]
    strong = {value for value, scores in votes.items() if max(scores) >= .97}
    accepted = len(agreed) == 1 and not (strong - set(agreed))
    value = agreed[0] if accepted else None
    return {"status": "QUANTITY_MATCH" if accepted else "QUANTITY_UNKNOWN", "value": value,
            "rawOCR": variants[0]["text"] if variants else "", "variants": variants,
            "confidence": min(votes[value]) if accepted else None,
            "method": "whole-number-onnx-consensus", "valueSource": "NUMERIC_OCR_CONSENSUS",
            **({"reason": "ocr_disagreement_or_uncertain"} if not accepted else {})}


class NumericOCR:
    def __init__(self, reader):
        self.reader = reader

    def read_many(self, images, *, warehouse=False, minimum=0, maximum=9999):
        groups = [number_views(image, warehouse=warehouse) for image in images]
        values = iter(self.reader.read_many([image for group in groups for _, image in group]))
        results = []
        for group in groups:
            readings = [(method, next(values)) for method, _ in group]
            result = decide_number(readings, minimum=minimum, maximum=maximum)
            if result["value"] is None:
                for method, image in group:
                    if method in {"whole", "tight-color"}:
                        readings.append(("full-width:" + method, self.reader.read(image)))
                result = decide_number(readings, minimum=minimum, maximum=maximum)
            results.append(result)
        return results
