"""Verified whole-field foreground matching; unmatched inputs retain the OCR path."""
from __future__ import annotations
import hashlib
import json
import time
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from PIL import Image

VERSION = "trade-field-binary-exact-v1"
BANK_SHA256 = "8d350a7e512eb174babece2af9da1ef5767323725cd94f4df903c2e6327f682d"

def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

def feature_key(mask, scaled=False):
    """Whole foreground, including every component; never match a substring."""
    if mask.size == 0 or not mask.any():
        return None
    ys, xs = np.nonzero(mask)
    tight = mask[ys.min():ys.max()+1, xs.min():xs.max()+1].astype(np.uint8)
    if scaled:
        width = max(1, round(tight.shape[1] * 32 / tight.shape[0]))
        if width > 1600:
            return None
        tight = np.asarray(Image.fromarray(tight).resize((width, 32), Image.Resampling.NEAREST))
    return f"{tight.shape[0]}x{tight.shape[1]}:" + hashlib.sha256(tight.tobytes()).hexdigest()


def text_mask(crop, module):
    mask = module._ink(crop)
    occupied = np.flatnonzero(mask.sum(axis=1) >= 2)
    if not len(occupied):
        return None
    groups = np.split(occupied, np.where(np.diff(occupied) > 2)[0]+1)
    lines = []
    for group in groups:
        if len(group) < 3:
            continue
        band = mask[int(group[0]):int(group[-1])+1]
        ys, xs = np.nonzero(band)
        if not len(xs) or xs.min() == 0 or xs.max() == crop.width-1:
            return None
        lines.append(band[:, xs.min():xs.max()+1])
    if not lines:
        return None
    width = max(x.shape[1] for x in lines)
    result = np.zeros((sum(x.shape[0] for x in lines)+3*(len(lines)-1), width), dtype=bool)
    offset = 0
    for line in lines:
        result[offset:offset+line.shape[0], :line.shape[1]] = line
        offset += line.shape[0]+3
    return result


def count_suffix_mask(crop, module):
    mask = text_mask(crop, module)
    if mask is None:
        return None
    columns = np.flatnonzero(mask.any(axis=0))
    groups = np.split(columns, np.where(np.diff(columns)>1)[0]+1)
    for group in reversed(groups):
        if group[0] < 60 or len(group)>3:
            continue
        ys = np.flatnonzero(mask[:,group].any(axis=1))
        parts = np.split(ys,np.where(np.diff(ys)>1)[0]+1)
        if len(parts)!=2 or not all(1<=len(p)<=3 for p in parts) or not 4<=parts[1][0]-parts[0][-1]<=10:
            continue
        suffix = mask[:,group[-1]+1:]; active = np.flatnonzero(suffix.any(axis=0))
        if len(active) and 12<=active[-1]-active[0]+1<=45:
            return suffix[:,active[0]:active[-1]+1]
    return None


def quantity_mask(row, field, module):
    """Outline extraction with a wider guard against omitted digits."""
    import cv2
    bounds = (.287, .55, .340, .93) if field == "reqAmount" else (.663, .50, .724, .95)
    crop = module._crop(row, bounds)
    rgb = np.asarray(crop.convert("RGB"), dtype=np.int16)
    white = (rgb.min(axis=2)>155) & (rgb.max(axis=2)-rgb.min(axis=2)<55)
    dark = (rgb.max(axis=2)<100).astype(np.uint8)
    mask = white & cv2.dilate(dark, np.ones((3, 3), dtype=np.uint8)).astype(bool)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    candidates = [i for i in range(1, count) if stats[i, cv2.CC_STAT_HEIGHT] >= crop.height*.30]
    if not candidates:
        return None
    anchor = stats[max(candidates, key=lambda i: stats[i, cv2.CC_STAT_LEFT]+stats[i, cv2.CC_STAT_WIDTH])]
    top, bottom = anchor[1], anchor[1]+anchor[3]
    candidates = [i for i in candidates if min(bottom, stats[i, 1]+stats[i, 3])-max(top, stats[i, 1]) >= .7*max(anchor[3], stats[i, 3])]
    selected = np.isin(labels, candidates)
    ys, xs = np.nonzero(selected)
    if not len(xs) or xs.min() == 0 or xs.max() == crop.width-1 or ys.min() == 0 or ys.max() == crop.height-1:
        return None
    # Check the wider visible band before discarding whitespace or artwork.
    guard_bounds = (.270, .45, .350, .99) if field == "reqAmount" else (.645, .45, .745, .99)
    guard = module._crop(row, guard_bounds)
    grgb = np.asarray(guard.convert("RGB"), dtype=np.int16)
    gwhite = (grgb.min(axis=2)>100) & (grgb.max(axis=2)-grgb.min(axis=2)<80)
    gcount, _, gstats, _ = cv2.connectedComponentsWithStats(gwhite.astype(np.uint8), 8)
    cx, cy = round(bounds[0]*row.width), round(bounds[1]*row.height)
    gx, gy = round(guard_bounds[0]*row.width), round(guard_bounds[1]*row.height)
    bx0, by0, bx1, by1 = cx+xs.min(), cy+ys.min(), cx+xs.max()+1, cy+ys.max()+1
    for stat in gstats[1:]:
        x, y, w, h = stat[:4]
        x, y = x+gx, y+gy
        overlap = min(by1, y+h)-max(by0, y)
        if h >= (by1-by0)*.6 and overlap >= .7*max(by1-by0, h):
            if x < bx0-1 or x+w > bx1+1:
                return None
    tight = selected[ys.min():ys.max()+1, xs.min():xs.max()+1]
    columns = np.flatnonzero(tight.any(axis=0))
    groups = np.split(columns, np.where(np.diff(columns)>1)[0]+1)
    return tight, len(groups)


def quantity_context_key(row, field, module):
    # Keep every bright component in the wider band, including a digit joined to artwork.
    bounds = (.270, .40, .350, .99) if field == "reqAmount" else (.645, .40, .745, .99)
    rgb = np.asarray(module._crop(row, bounds).convert("RGB"), dtype=np.int16)
    low, high = rgb.min(axis=2), rgb.max(axis=2)
    masks = [(low>100) & (high-low<80), (low>155) & (high-low<55)]
    if not masks[1].any():
        return None
    return f"{rgb.shape[0]}x{rgb.shape[1]}:" + hashlib.sha256(b"".join(np.packbits(m).tobytes() for m in masks)).hexdigest()


def get_features(kind, crop, module, *, row=None, field=None):
    context = {}
    if kind == "quantity":
        key = quantity_context_key(row, field, module)
        if key is not None:
            context["context"] = key
        found = quantity_mask(row, field, module)
        if found is None:
            return context, None
        mask, group_count = found
    else:
        mask, group_count = text_mask(crop, module), None
    if mask is None:
        return {}, group_count
    return {**context, **{mode: feature_key(mask, mode == "scaled") for mode in ("native", "scaled")}}, group_count


def lookup(bank, kind, features, group_count, modes=("native", "scaled", "context"), allowed=None):
    matched = []
    ambiguous = False
    for mode in modes:
        key = features.get(mode)
        refs = bank["lookup"].get(f"{kind}|{mode}|{key}", []) if key else []
        labels = {_canonical(r["value"]): r["value"] for r in refs}
        if len(labels)>1:
            ambiguous = True
        if len(labels)==1:
            value = next(iter(labels.values()))
            if kind == "quantity" and mode != "context" and len(str(value)) != group_count:
                continue
            if allowed is not None and value not in allowed:
                continue
            matched.append((value, refs, mode))
    labels = {_canonical(x[0]) for x in matched}
    if ambiguous or len(labels) != 1 or kind == "quantity" and not any(mode == "context" for _, _, mode in matched):
        return None
    value = matched[0][0]
    refs = {r["referenceId"]: r for _, items, _ in matched for r in items}
    if kind == "unsupportedOutput" and any(r.get("source", {}).get("verification") != "ORIGINAL_IMAGE_AUDIT" for r in refs.values()):
        return None
    return {"value": value, "references": list(refs), "modes": sorted({x[2] for x in matched}),
            **({"sourceVerification":"ORIGINAL_IMAGE_AUDIT"} if kind == "unsupportedOutput" else {})}


def packed_mask(mask):
    return {"height": mask.shape[0], "width": mask.shape[1], "bits": np.packbits(mask).tobytes().hex()}


def unpacked_mask(value):
    height, width = value["height"], value["width"]
    if type(height) is not int or type(width) is not int or not 3 <= height <= 120 or not 3 <= width <= 1600:
        raise ValueError("invalid complete name mask")
    bits = np.unpackbits(np.frombuffer(bytes.fromhex(value["bits"]), dtype=np.uint8))
    if len(bits) != ((height * width + 7) // 8) * 8:
        raise ValueError("invalid name mask length")
    return bits[:height * width].reshape(height, width).astype(bool)


class IslandPixelIndex:
    """Bounded complete-field variation with separation from competing labels."""
    def __init__(self, bank, kind="island", *, mask_key=None):
        references = {r["referenceId"]: r for key, refs in bank["lookup"].items() if key.startswith(kind+"|") for r in refs}
        self.groups = {}
        self.padded = {}
        self.counter_suffix = mask_key == "countSuffixMasks"
        for entry in bank.get(mask_key or ("islandMasks" if kind == "island" else "countMasks"), []):
            ref = references[entry["referenceId"]]
            mask = unpacked_mask(entry)
            self.groups.setdefault(mask.shape, []).append((mask, ref))

    def match(self, mask, allowed):
        if mask is None:
            return None
        candidates = {}
        for shape, entries in self.groups.items():
            if any(abs(a-b) > 1 for a, b in zip(shape, mask.shape)):
                continue
            h, w = max(shape[0], mask.shape[0])+2, max(shape[1], mask.shape[1])+2
            queries = []
            for y in range(3):
                for x in range(3):
                    canvas = np.zeros((h, w), dtype=bool)
                    canvas[y:y+mask.shape[0], x:x+mask.shape[1]] = mask
                    queries.append(int.from_bytes(np.packbits(canvas).tobytes(), "big"))
            for ref_mask, ref in entries:
                if allowed is not None and ref["value"] not in allowed:
                    continue
                cache_key = (ref["referenceId"], h, w)
                if cache_key not in self.padded:
                    canvas = np.zeros((h,w), dtype=bool)
                    canvas[1:1+shape[0],1:1+shape[1]] = ref_mask
                    self.padded[cache_key] = int.from_bytes(np.packbits(canvas).tobytes(), "big")
                distance = min((query ^ self.padded[cache_key]).bit_count() for query in queries)
                if ref["value"] not in candidates or distance < candidates[ref["value"]][0]:
                    candidates[ref["value"]] = (distance, ref)
        ordered = sorted(candidates.values(), key=lambda entry: entry[0])
        limit = 2 if self.counter_suffix else min(16, max(4, round(mask.size*.01)))
        if not ordered or ordered[0][0] > limit:
            return None
        best, reference = ordered[0]
        next_distance = ordered[1][0] if len(ordered) > 1 else None
        required_margin = 4 + 2*best if self.counter_suffix else 12 + 4*best
        if next_distance is not None and next_distance - best < required_margin:
            return None
        return {"value": reference["value"], "references": [reference], "modes": ["bounded-native-pixels"],
                "pixelDifference": best, "nextLabelDifference": next_distance}


class TemplateReader:
    def __init__(self, path, *, ink, crop):
        self.extractor = SimpleNamespace(_ink=ink, _crop=crop)
        self.bank = None
        self.island_index = None
        self.count_index = None
        self.count_suffix_index = None
        self.enabled = False
        self.stats = {"bankVersion": VERSION, "bankSha256": BANK_SHA256,
                      "available": False, "attempts": 0, "hits": 0, "byKind": {}, "lookupSeconds": 0.0}
        try:
            data = Path(path).read_bytes()
            if hashlib.sha256(data).hexdigest() != BANK_SHA256:
                raise ValueError("bank integrity mismatch")
            bank = json.loads(data)
            if bank.get("version") != VERSION or not isinstance(bank.get("lookup"), dict):
                raise ValueError("unsupported bank")
            self.bank = bank
            self.island_index = IslandPixelIndex(bank)
            self.count_index = IslandPixelIndex(bank, "count")
            self.count_suffix_index = IslandPixelIndex(bank, "count", mask_key="countSuffixMasks")
            self.stats.update(available=True, referenceCount=bank["referenceCount"])
        except (OSError, ValueError, KeyError, TypeError):
            self.bank = None
            self.island_index = None
            self.stats["fallbackReason"] = "bank_missing_or_invalid"

    def configure(self, image, metadata):
        fidelity = metadata.get("fidelity", {})
        self.enabled = (self.bank is not None and self.bank.get("referenceCount", 0) > 0 and image.size == (987, 456)
                        and metadata.get("sourceType") == "native-screen"
                        and fidelity.get("rescaled") is False
                        and fidelity.get("evidence") == "native-pixels")

    def match(self, kind, crop, *, row=None, field=None, allowed=None):
        if not self.enabled:
            return None
        started = time.perf_counter()
        self.stats["attempts"] += 1
        try:
            features, groups = get_features(kind, crop, self.extractor, row=row, field=field)
            hit = lookup(self.bank, kind, features, groups, allowed=allowed)
            if hit is None and kind == "island" and self.island_index is not None:
                hit = self.island_index.match(text_mask(crop, self.extractor), allowed)
            if hit is None and kind == "count" and self.count_index is not None:
                hit = self.count_index.match(text_mask(crop, self.extractor), allowed)
            if hit is None and kind == "count" and self.count_suffix_index is not None:
                hit = self.count_suffix_index.match(count_suffix_mask(crop, self.extractor), allowed)
        except Exception:
            self.stats["lookupErrors"] = self.stats.get("lookupErrors", 0) + 1
            return None
        finally:
            self.stats["lookupSeconds"] += time.perf_counter() - started
        if hit is None:
            return None
        self.stats["hits"] += 1
        self.stats["byKind"][kind] = self.stats["byKind"].get(kind, 0) + 1
        return {"rawOCR": "", "corrected": hit["value"], "reviewRequired": False,
                "confidence": None, "valueSource": "VERIFIED_TEMPLATE", "variants": [],
                "templateEvidence": {"bankVersion": VERSION, "bankSha256": BANK_SHA256,
                                     **({"fieldKind":"unsupportedOutput", "sourceVerification":hit["sourceVerification"]}
                                        if kind == "unsupportedOutput" else {}),
                                     "references": hit["references"], "modes": hit["modes"],
                                     **{k:hit[k] for k in ("pixelDifference", "nextLabelDifference") if k in hit}},
                **({"masterMatch": "RESOLVED"} if kind in ("island", "item") else {})}
