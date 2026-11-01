"""Current-font numeral evidence from audited original pixels, independent of OCR text."""
from __future__ import annotations

import numpy as np
from PIL import Image

from .trade_template_reader import unpacked_mask, quantity_mask


def split_glyphs(mask, *, context="warehouse"):
    if mask is None or not mask.any():
        return None
    columns = np.flatnonzero(mask.any(axis=0))
    groups = np.split(columns, np.where(np.diff(columns) > 1)[0] + 1)
    if any(b[0]-a[-1]-1 > max(4, round(mask.shape[0]*.4)) for a,b in zip(groups,groups[1:])):
        return None
    pieces = []
    for group in groups:
        glyph = mask[:, group[0]:group[-1]+1]
        ys, xs = np.nonzero(glyph)
        glyph = glyph[ys.min():ys.max()+1, xs.min():xs.max()+1]
        if not 7 <= glyph.shape[0] <= 16 or not 2 <= glyph.shape[1] <= (28 if context == "trade" else 12):
            return None
        pieces.append(glyph)
    return pieces if 1 <= len(pieces) <= 4 else None


def token_glyphs(image, *, warehouse=False, context="warehouse", joined=False):
    import cv2
    image = image.convert("RGB")
    if warehouse:
        image = image.crop((0, round(image.height*.58), image.width, image.height))
    rgb = np.asarray(image, dtype=np.int16)
    white = ((rgb.min(axis=2) > 145) & (rgb.max(axis=2)-rgb.min(axis=2) < 55)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(white, 8)
    minimum = max(6, round(image.height*.35))
    large = [i for i in range(1,count) if stats[i,3] >= minimum and stats[i,2] >= 2]
    if not large:
        return None
    anchor = stats[max(large, key=lambda i: stats[i,0]+stats[i,2])]
    chosen, left = [], int(anchor[0]+anchor[2])
    for i in sorted(large, key=lambda i:stats[i,0], reverse=True):
        value = stats[i]
        if abs(int(value[1]+value[3]-anchor[1]-anchor[3])) > 2 or value[0]+value[2] > anchor[0]+anchor[2]+1:
            continue
        if left-(value[0]+value[2]) > max(4, round(anchor[3]*.4)):
            break
        chosen.append(i)
        left = min(left, int(value[0]))
    mask = np.isin(labels, chosen)
    ys, xs = np.nonzero(mask)
    if (not len(xs) or xs.min() == 0 or xs.max() == image.width-1
            or ys.min() == 0 or ys.max() == image.height-1):
        return None
    # A nearby, aligned component may be a dropped leading digit, even if OCR ignores it.
    for i in large:
        value = stats[i]
        if (i not in chosen and abs(int(value[1]+value[3]-anchor[1]-anchor[3])) <= 2
                and 0 <= xs.min()-(value[0]+value[2]) <= 6):
            return None
    low = ((rgb.min(axis=2) > 100) & (rgb.max(axis=2)-rgb.min(axis=2) < 80)).astype(np.uint8)
    _, _, faint, _ = cv2.connectedComponentsWithStats(low, 8)
    for x, y, width, height, _ in faint[1:]:
        overlap = min(ys.max()+1, y+height)-max(ys.min(), y)
        near_left = x < xs.min()-1 and 0 <= xs.min()-(x+width) <= max(12, anchor[3])
        near_right = x+width > xs.max()+2 and 0 <= x-(xs.max()+1) <= max(12, anchor[3])
        if height >= anchor[3]*.6 and overlap >= .6*max(anchor[3], height) and (near_left or near_right):
            return None
    tight = mask[ys.min():ys.max()+1,xs.min():xs.max()+1]
    return tight if joined else split_glyphs(tight, context=context)


def outlined_image(image):
    import cv2
    rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    dark = (rgb.max(axis=2)<100).astype(np.uint8)
    outlined = cv2.dilate(dark, np.ones((3,3), dtype=np.uint8)).astype(bool)
    return Image.fromarray(np.where(outlined[:,:,None], rgb, 0).astype(np.uint8))


def mask_distance(a, b):
    if any(abs(x-y) > 1 for x,y in zip(a.shape,b.shape)):
        return 999
    height, width = max(a.shape[0],b.shape[0])+2, max(a.shape[1],b.shape[1])+2
    canvas = np.zeros((height,width), dtype=bool)
    canvas[1:1+b.shape[0],1:1+b.shape[1]] = b
    distance = 999
    for y in range(3):
        for x in range(3):
            query = np.zeros((height,width), dtype=bool)
            query[y:y+a.shape[0],x:x+a.shape[1]] = a
            distance = min(distance, int(np.count_nonzero(query != canvas)))
    return distance


class VisualNumbers:
    def __init__(self, entries):
        self.entries = [(entry,unpacked_mask(entry)) for entry in entries
                        if entry.get("verification") == "ORIGINAL_GLYPH_AUDIT"
                        and type(entry.get("value")) is int and 0 <= entry["value"] <= 9]

    def match(self, pieces, *, context="warehouse"):
        if not pieces or not self.entries:
            return None
        digits, evidence = [], []
        for mask in pieces:
            scores = {}
            for entry,reference in self.entries:
                if context != "trade" and entry.get("context") == "trade":
                    continue
                distance = mask_distance(mask, reference)
                value = entry["value"]
                if value not in scores or distance < scores[value][0]:
                    scores[value] = (distance, entry)
            ordered = sorted(scores.items(), key=lambda item:item[1][0])
            if len(ordered) < 2:
                return None
            digit,(distance,entry) = ordered[0]
            if distance > 2 or ordered[1][1][0]-distance < 3:
                return None
            digits.append(str(digit))
            evidence.append({"referenceId":entry["referenceId"], "digit":digit,
                             "pixelDifference":distance, "nextDifference":ordered[1][1][0]})
        text = "".join(digits)
        if len(text) > 1 and text.startswith("0"):
            return None
        return {"value":int(text), "digits":evidence, "completeToken":True}

    def warehouse(self, image):
        return self.match_run(token_glyphs(image, warehouse=True, joined=True))

    def outlined_warehouse(self, image):
        return self.warehouse(outlined_image(image))

    def match_run(self, mask, *, context="warehouse"):
        if mask is None or not 7 <= mask.shape[0] <= 16 or mask.shape[1] > 48:
            return None
        direct = self.match(split_glyphs(mask, context=context), context=context)
        if direct:
            return direct
        # Adjacent digits need not have an empty column between them. Every foreground
        # pixel must belong to a verified glyph; no prefix or artwork is discarded.
        paths = [(0, "", [])]; completed = {}; cache = {}
        while paths:
            start, text, evidence = paths.pop()
            gap_start = start
            while start < mask.shape[1] and not mask[:,start].any():
                start += 1
            if start-gap_start > max(4, round(mask.shape[0]*.4)):
                continue
            if start == mask.shape[1]:
                if text and not (len(text)>1 and text.startswith('0')):
                    completed[text] = evidence
                continue
            if len(text) >= 4:
                continue
            for end in range(start+2, min(mask.shape[1],start+12)+1):
                if not mask[:,end-1].any():
                    continue
                key = start,end
                if key not in cache:
                    glyph = mask[:,start:end]; ys = np.flatnonzero(glyph.any(axis=1))
                    cache[key] = self.match([glyph[ys.min():ys.max()+1]], context=context)
                hit = cache[key]
                if hit:
                    paths.append((end,text+str(hit['value']),evidence+hit['digits']))
            if len(paths)>40:
                return None
        if len(completed)!=1:
            return None
        text,evidence = next(iter(completed.items()))
        return {'value':int(text),'digits':evidence,'completeToken':True,'segmentation':'complete-variable-width'}

    def isolated(self, image):
        return self.match(token_glyphs(image, context="trade"), context="trade")

    def trade(self, row, field, extractor):
        found = quantity_mask(row, field, extractor)
        return self.match_run(found[0], context="trade") if found is not None else None
