"""Fit audited native trade glyphs and evaluate by whole batches, offline only."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import time

import numpy as np

from .numeric_profile import canonical_bytes
from .trade_numeric_profile import VERSION, TradeNumericProfile


def load_dataset(path):
    path = Path(path)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    with np.load(path.parent/manifest["rowArchive"], allow_pickle=False) as archive:
        rows = archive["pixels"].copy()
    if rows.dtype != np.uint8 or rows.shape[1:] != (70, 987, 3):
        raise ValueError("expected native row pixels; 69px rows may have one non-field padding row")
    roles, identifiers, observations = {}, set(), {}
    for record in manifest["records"]:
        if record["id"] in identifiers:
            raise ValueError("duplicate field identifier")
        identifiers.add(record["id"])
        if record["split"] not in {"train", "dev", "test"}:
            raise ValueError("unknown dataset split")
        for key in [("batch", record["group"]), ("source", record["sourceSha256"])]:
            if key in roles and roles[key] != record["split"]:
                raise ValueError("batch/source crosses dataset splits")
            roles[key] = record["split"]
        if record["verification"] != "ORIGINAL_IMAGE_AUDIT":
            raise ValueError("unchecked/OCR values are not truth")
        field, value = record["field"], record["value"]
        maximum = 10 if field == "count" else 9999
        minimum = 0 if field == "count" else 1
        if field not in {"count", "reqAmount", "yield"} or type(value) is not int or not minimum <= value <= maximum:
            raise ValueError("unsupported numeric label")
        if not 0 <= record["rowIndex"] < len(rows):
            raise ValueError("missing source row")
        observation = record.get("observationId", record["id"])
        signature = record["group"], field, value
        if observation in observations and observations[observation] != signature:
            raise ValueError("overlap identity has conflicting labels")
        observations[observation] = signature
    return manifest, rows


def _ink(rgb, front, back):
    axis = front-back
    level = ((rgb-back)*axis).sum(2)/(axis*axis).sum()
    return ((level > .55) & (level <= 1.02) &
            (np.abs(rgb-back-level[:, :, None]*axis).max(2) <= 3))


def fit_profile(manifest, rows, annotations, suffix):
    import cv2

    records = {(r["rowIndex"], r["field"]): r for r in manifest["records"]}
    contexts = {}
    for kind in ["white", "yellow"]:
        selected = [a for a in annotations if a["field"] == kind]
        foreground, outlines = [], []
        for annotation in selected:
            record = records[annotation["rowIndex"], annotation["sourceField"]]
            if record["split"] != "train" or record["verification"] != "ORIGINAL_IMAGE_AUDIT":
                raise ValueError("only audited TRAIN labels may fit the model")
            if annotation["verification"] != "ORIGINAL_GLYPH_AUDIT":
                raise ValueError("segmentation has not been audited")
            text = str(record["value"])
            if (annotation["value"] != record["value"] or type(annotation["digitIndex"]) is not int
                    or not 0 <= annotation["digitIndex"] < len(text)
                    or (kind == "yellow") != (annotation["sourceField"] == "count")):
                raise ValueError("invalid glyph/token association")
            if text[annotation["digitIndex"]] != str(annotation["digit"]):
                raise ValueError("glyph and token labels disagree")
            if annotation["sourceSha256"] != record["sourceSha256"] or annotation["group"] != record["group"]:
                raise ValueError("glyph provenance disagrees with source")
            x, y, width, height = annotation["box"]
            if x < 1 or y < 1 or x+width >= 987 or y+height >= record["rowBox"]["height"]:
                raise ValueError("glyph is cut at the source boundary")
            image = rows[annotation["rowIndex"]]
            rgb = image[y:y+height, x:x+width].astype(float)
            broad = ((rgb.min(2) > 155) & (np.ptp(rgb, axis=2) < 55) if kind == "white" else
                     (rgb[:, :, 0] > 140) & (rgb[:, :, 1] > 100) & (rgb[:, :, 2] < rgb[:, :, 1]*.8))
            mask = np.array(annotation["mask"], dtype=bool)
            if not np.array_equal(mask, broad):
                raise ValueError("annotation pixels are not the original source crop")
            foreground.extend(map(tuple, rgb[mask].astype(int).tolist()))
            padded = np.pad(mask, 1)
            ring = cv2.dilate(padded.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~padded
            outlines.extend(map(tuple, image[y-1:y+height+1, x-1:x+width+1][ring].tolist()))
        if not foreground or not outlines:
            raise ValueError("missing source foreground/outline pixels")
        front = np.array(Counter(foreground).most_common(1)[0][0], float)
        back = np.array(Counter(outlines).most_common(1)[0][0], float)
        if np.sum((front-back)**2) < 10000:
            raise ValueError("source foreground and background are not separable")
        glyphs = []
        for annotation in selected:
            x, y, width, height = annotation["box"]
            mask = _ink(rows[annotation["rowIndex"]][y:y+height, x:x+width].astype(float), front, back)
            ys, xs = np.nonzero(mask)
            if not len(xs):
                raise ValueError("no foreground in glyph")
            box = [int(x+xs.min()), int(y+ys.min()), int(xs.max()-xs.min()+1), int(ys.max()-ys.min()+1)]
            source = {k: annotation[k] for k in ["sourceField", "rowIndex", "digitIndex", "value", "sourceSha256", "group"]}
            source.update(box=box, verification="ORIGINAL_GLYPH_AUDIT")
            glyphs.append({"digit": annotation["digit"], "mask": mask[ys.min():ys.max()+1, xs.min():xs.max()+1].astype(int).tolist(), "source": source})
        digits = {g["digit"] for g in glyphs}
        if (kind == "white" and digits != set(range(10))) or not digits:
            raise ValueError("missing supported digits")
        ends = ({str(d): ([36, 37] if d == 1 else [38, 39]) for d in digits} if kind == "white" else
                {str(d): ([10, 11, 12, 21, 22, 23] if d == 0 else [7, 8, 9] if d == 1 else
                          [11, 12, 13] if d == 4 else [10, 11, 12]) for d in digits})
        contexts[kind] = {"foreground": front.tolist(), "outline": back.tolist(), "colorTolerance": 3,
            "minimumLevel": .55, "outlineDistance": kind == "white", "glyphs": glyphs, "parameters": {
                "maxGlyphDifference": 3, "minimumTokenMargin": 3, "tops": [28, 29, 30] if kind == "white" else [21, 22, 23],
                "maximumGap": 6, "maxDigits": 4 if kind == "white" else 2, "maximumPaths": 256,
                "requireClearGap": True, "rightEnds": ends}}
    record = records[suffix["rowIndex"], "count"]
    if record["split"] != "train" or suffix["verification"] != "ORIGINAL_GLYPH_AUDIT" or type(record["layoutOffset"]) is not int:
        raise ValueError("suffix requires audited TRAIN/native layout")
    x, y, width, height = suffix["box"]
    if x < 1 or y < 1 or width < 3 or height < 3 or x+width >= 987 or y+height >= record["rowBox"]["height"]:
        raise ValueError("suffix is cut at the source boundary")
    context = contexts["yellow"]
    mask = _ink(rows[suffix["rowIndex"]][y:y+height, x:x+width].astype(float),
                np.array(context["foreground"]), np.array(context["outline"]))
    profile = {"version": VERSION, "status": "OFFLINE_EXPERIMENT_ONLY", "fontProfile": "current-font-native-987x69-70",
        "layoutOffset": record["layoutOffset"], "contexts": contexts, "countSuffix": {
            "mask": mask.astype(int).tolist(), "tops": [y-18, y-17, y-16], "source": suffix},
        "trainGroups": sorted({r["group"] for r in manifest["records"] if r["split"] == "train"})}
    return {**profile, "sha256": hashlib.sha256(canonical_bytes(profile)).hexdigest()}


def evaluate(manifest, rows, profile, split):
    core = TradeNumericProfile(profile)
    used, results = set(), []
    train_sources = {g["source"]["sourceSha256"] for c in profile["contexts"].values() for g in c["glyphs"]}
    start = time.perf_counter()
    for record in manifest["records"]:
        if record["split"] != split:
            continue
        if record["group"] in profile["trainGroups"] or record["sourceSha256"] in train_sources:
            raise ValueError("evaluation source leaked into fitted profile")
        observation = record.get("observationId", record["id"])
        if observation in used:
            continue
        used.add(observation)
        result = core.read(rows[record["rowIndex"]], record["field"], layout_offset=record["layoutOffset"])
        results.append({"id": record["id"], "field": record["field"], "truth": record["value"],
                        "ruleFixed": record.get("ruleFixed", False), **result})
    def metrics(items):
        return {"total": len(items), "correctAuto": sum(r["value"] == r["truth"] for r in items),
            "wrongAuto": sum(r["value"] is not None and r["value"] != r["truth"] for r in items),
            "review": sum(r["value"] is None for r in items)}
    return {"split": split, "profileSha256": profile["sha256"], "seconds": time.perf_counter()-start,
        "wholeFieldCache": False, "ocrCalls": 0, "fallbackNotExecuted": True, "deduplicated": True,
        "total": metrics(results), "variable": metrics([r for r in results if not r["ruleFixed"]]),
        "fields": {f: metrics([r for r in results if r["field"] == f]) for f in ["count", "reqAmount", "yield"]}, "results": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["fit", "evaluate"])
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--glyphs", type=Path)
    parser.add_argument("--suffix", type=Path)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--split", choices=["dev", "test"], default="dev")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "fit" and (args.glyphs is None or args.suffix is None):
        parser.error("fit requires --glyphs and --suffix")
    if args.command == "evaluate" and args.profile is None:
        parser.error("evaluate requires --profile")
    manifest, rows = load_dataset(args.dataset)
    if args.command == "fit":
        output = fit_profile(manifest, rows, json.loads(args.glyphs.read_text()), json.loads(args.suffix.read_text()))
        summary = {"profileSha256": output["sha256"]}
    else:
        output = evaluate(manifest, rows, json.loads(args.profile.read_text()), args.split)
        summary = {k:v for k,v in output.items() if k != "results"}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
