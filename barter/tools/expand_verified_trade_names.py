"""Read-only extraction and dry-run building of independently verified name references."""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import sqlite3
import time
from types import SimpleNamespace

from PIL import Image, ImageDraw, ImageFont
from .trade_live_ocr import NAME_BOUNDS, _crop, _ink
from .trade_template_reader import VERSION, get_features

ROOT = Path(__file__).resolve().parents[2]
FONT_POLICY = "OCR_PRIMARY_20261027"
CUTOFF = "2026-10-27T03:00:00"


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def box_tuple(box):
    if (not isinstance(box, dict) or set(box) != {"x", "y", "width", "height"}
            or any(type(v) is not int or v < 0 for v in box.values()) or not box["width"] or not box["height"]):
        raise ValueError("invalid source box")
    return box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]


def build(database, out, *, bank=None, labels=None):
    database, out = Path(database).resolve(), Path(out).resolve()
    if not database.is_file() or out.exists():
        raise ValueError("database must exist and output directory must be new")
    bank = Path(bank or ROOT / "barter/recognition_data/trade-templates.json").resolve()
    base = read_json(bank)
    if (base.get("version") != VERSION or base.get("fontPolicy") != FONT_POLICY
            or any(not key.startswith(("item|native|", "item|scaled|", "island|native|", "island|scaled|"))
                   for key in base["lookup"])):
        raise ValueError("only current-font name banks are supported")
    manifest = read_json(labels) if labels else {"version": 1, "fontPolicy": FONT_POLICY, "labels": []}
    if manifest.get("version") != 1 or manifest.get("fontPolicy") != FONT_POLICY:
        raise ValueError("unsupported labels manifest")
    checks = {}
    for check in manifest["labels"]:
        if check["sampleId"] in checks:
            raise ValueError("duplicate label sampleId")
        if check.get("verification") != "ORIGINAL_IMAGE_AUDIT":
            raise ValueError("labels must explicitly record original-image verification")
        timestamp = datetime.fromisoformat(check["verifiedAt"].replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("verification time must have a timezone")
        checks[check["sampleId"]] = check
    catalog = read_json(ROOT / "barter/frontend/data/trade-catalog.json")
    masters = {"item": {name for names in catalog["masterData"].values() for name in names} | set(catalog["specialItems"]),
               "island": set(catalog["islands"] + catalog["t6Islands"] + catalog["t7Islands"])}
    out.mkdir(parents=True)
    (out / "crops").mkdir(); (out / "captures").mkdir()
    extractor = SimpleNamespace(_crop=_crop, _ink=_ink)
    skipped, samples, replay = Counter(), {}, {}
    lookup = json.loads(json.dumps(base["lookup"]))
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        connection.execute("PRAGMA query_only=ON"); connection.execute("BEGIN")
        for created, image_bytes, details_json in connection.execute(
                "SELECT created_at,image_png,details_json FROM trade_correction ORDER BY created_at,feedback_id,capture_id"):
            details = json.loads(details_json); metadata = details.get("metadata", {})
            fidelity = metadata.get("fidelity", {})
            if (created < CUTOFF or metadata.get("sourceType") != "native-screen"
                    or fidelity.get("rescaled") is not False or fidelity.get("evidence") != "native-pixels"):
                skipped["old_font_or_non_native"] += 1; continue
            with Image.open(BytesIO(image_bytes)) as source:
                if source.size != (987, 456):
                    skipped["wrong_frame_size"] += 1; continue
                image = source.convert("RGB")
            image_hash = hashlib.sha256(image_bytes).hexdigest()
            if image_hash not in replay:
                path = out / "captures" / (image_hash + ".png"); path.write_bytes(image_bytes)
                replay[image_hash] = {"captureId": metadata["captureId"], "metadata": metadata, "imagePath": str(path)}
            for row in details.get("snapshot", {}).get("rows", []):
                if row.get("excluded"):
                    skipped["excluded_row"] += 1; continue
                rb = row["rowBox"]; rb_tuple = box_tuple(rb)
                if rb_tuple[2] > image.width or rb_tuple[3] > image.height:
                    raise ValueError("row exceeds original image")
                row_image = image.crop(rb_tuple)
                for field_name, bounds in NAME_BOUNDS.items():
                    field = row["fields"][field_name]; kind = "island" if field_name == "island" else "item"
                    value = field.get("corrected")
                    if field.get("reviewRequired") or field.get("reviewDraft") or value not in masters[kind]:
                        skipped["unresolved_or_non_master_name"] += 1; continue
                    crop = _crop(row_image, bounds)
                    expected_box = {"x": rb["x"] + round(bounds[0] * rb["width"]),
                                    "y": rb["y"] + round(bounds[1] * rb["height"]),
                                    "width": crop.width, "height": crop.height}
                    if field.get("box") != expected_box:
                        skipped["field_box_mismatch"] += 1; continue
                    identity = {"fontPolicy": FONT_POLICY, "imageSha256": image_hash, "rowBox": rb,
                                "ordinal": row["ordinal"], "field": field_name, "value": value}
                    sample_id = digest(identity)
                    evidence = field.get("iconEvidence", {})
                    distance, gap = evidence.get("distance"), evidence.get("gap")
                    icon = (field.get("valueSource") == "VERIFIED_ICON" and kind == "item"
                            and type(distance) in (int, float) and type(gap) in (int, float)
                            and math.isfinite(distance) and math.isfinite(gap) and 0 <= distance <= .20 and gap >= .075)
                    check = checks.get(sample_id)
                    if check and check.get("value") != value:
                        raise ValueError("label differs from saved master name; report the discrepancy before expansion")
                    verified = "ORIGINAL_IMAGE_AUDIT" if check else "VERIFIED_ICON" if icon else None
                    sample = {**identity, "sampleId": sample_id, "kind": kind, "box": expected_box,
                              "crop": f"crops/{sample_id}.png", "valueSource": field.get("valueSource"),
                              "verification": verified, "verifiedAt": check["verifiedAt"] if check else created if icon else None}
                    previous = samples.get(sample_id)
                    if previous and (previous["verification"] or not verified):
                        continue
                    samples[sample_id] = sample
                    crop.save(out / sample["crop"])
                    if not verified:
                        continue
                    features, groups = get_features(kind, crop, extractor)
                    if not features:
                        skipped["no_complete_name_features"] += 1; continue
                    reference = {"referenceId": digest({**identity, "verification": verified}), "value": value,
                                 "source": {**identity, "verification": verified, "verifiedAt": sample["verifiedAt"]}}
                    for mode, key in features.items():
                        if key:
                            entries = lookup.setdefault(f"{kind}|{mode}|{key}", [])
                            if not any(r["referenceId"] == reference["referenceId"] for r in entries):
                                entries.append(reference)
    unknown_checks = set(checks) - set(samples)
    if unknown_checks:
        raise ValueError("labels contain sample IDs absent from eligible source images")
    collisions = [key for key, refs in lookup.items() if len({r["value"] for r in refs}) > 1]
    for key in collisions:
        del lookup[key]
    for refs in lookup.values():
        refs.sort(key=lambda r: r["referenceId"])
    references = {r["referenceId"] for refs in lookup.values() for r in refs}
    original = {r["referenceId"] for refs in base["lookup"].values() for r in refs}
    candidate = {"version": VERSION, "fontPolicy": FONT_POLICY, "referenceCount": len(references), "lookup": lookup}
    ordered = sorted(samples.values(), key=lambda s: s["sampleId"])
    report = {"fontPolicy": FONT_POLICY, "sourceBankSha256": hashlib.sha256(bank.read_bytes()).hexdigest(),
              "candidateBankSha256": hashlib.sha256(encoded(candidate)).hexdigest(), "captureCount": len(replay),
              "candidateNames": len(ordered), "verifiedSamples": sum(bool(s["verification"]) for s in ordered),
              "newReferences": len(references - original), "collisions": collisions, "skipped": dict(sorted(skipped.items())),
              "readyForReplay": bool(references - original) and not collisions,
              "sourceChanged": False, "automaticSourceApply": False}
    outputs = {"candidate-bank.json": candidate, "expansion-report.json": report, "samples.json": ordered,
               "replay-captures.json": list(replay.values()),
               "labels-template.json": {"version": 1, "fontPolicy": FONT_POLICY,
                                        "labels": [{"sampleId": s["sampleId"], "value": s["value"],
                                                    "verification": "UNVERIFIED", "verifiedAt": ""}
                                                   for s in ordered if not s["verification"]]}}
    for name, value in outputs.items():
        (out / name).write_bytes(encoded(value))
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/malgun.ttf", 15)
    except OSError:
        font = ImageFont.load_default()
    for offset in range(0, len(ordered), 24):
        sheet = Image.new("RGB", (1200, 12 * 105), "#171b22"); draw = ImageDraw.Draw(sheet)
        for i, sample in enumerate(ordered[offset:offset+24]):
            x, y = (i % 2) * 600 + 8, (i // 2) * 105 + 5
            draw.text((x, y), f"{sample['sampleId'][:12]} | {sample['field']} | {sample['value']}", font=font, fill="white")
            with Image.open(out / sample["crop"]) as crop:
                preview = crop.copy(); preview.thumbnail((580, 70)); sheet.paste(preview, (x, y + 25))
        sheet.save(out / f"contact-{offset//24:03}.png")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--database", type=Path)
    mode.add_argument("--replay", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--bank", type=Path)
    parser.add_argument("--labels", type=Path)
    parser.add_argument("--model-dir", type=Path)
    args = parser.parse_args()
    if args.database:
        if not args.out or args.model_dir:
            parser.error("extraction requires --out and does not use --model-dir")
        result = build(args.database, args.out, bank=args.bank, labels=args.labels)
    else:
        if not args.model_dir or args.out or args.bank or args.labels:
            parser.error("replay requires --model-dir and accepts no extraction options")
        result = replay(args.replay, args.model_dir)
    print(json.dumps(result, ensure_ascii=False))


def replay(directory, model_dir):
    from unittest.mock import patch
    from . import trade_template_reader as templates
    from .trade_live_ocr import recognize_live
    from barter.backend.services.trade_batch_runtime import MODEL_ONNX_SHA256, MODEL_CONFIG_SHA256
    directory, model_dir = Path(directory).resolve(), Path(model_dir).resolve()
    report = read_json(directory / "expansion-report.json")
    bank = directory / "candidate-bank.json"
    if (not report["readyForReplay"] or (directory / "replay-report.json").exists()
            or hashlib.sha256(bank.read_bytes()).hexdigest() != report["candidateBankSha256"]
            or hashlib.sha256((ROOT / "barter/recognition_data/trade-templates.json").read_bytes()).hexdigest() != report["sourceBankSha256"]):
        raise ValueError("replay requires an unchanged eligible candidate and source bank, and new output files")
    for name, expected in (("inference.onnx", MODEL_ONNX_SHA256), ("inference.yml", MODEL_CONFIG_SHA256)):
        if hashlib.sha256((model_dir / name).read_bytes()).hexdigest() != expected:
            raise ValueError("model integrity mismatch")
    captures = read_json(directory / "replay-captures.json")
    results, summary = {}, {}
    for label in ("baseline", "candidate"):
        rows, calls, hits = [], 0, 0
        start = time.perf_counter()
        expected_hash = templates.BANK_SHA256 if label == "baseline" else report["candidateBankSha256"]
        with patch.object(templates, "BANK_SHA256", expected_hash):
            for index in range(0, len(captures), 100):
                result = recognize_live(captures[index:index+100], model_dir, "name-expansion-replay",
                                        template_bank_path=bank if label == "candidate" else None)
                rows.extend(result["rows"])
                calls += result["templateMetrics"]["modelCalls"]
                hits += result["templateMetrics"]["hits"]
        results[label] = rows
        summary[label] = {"seconds": time.perf_counter() - start, "modelCalls": calls, "templateHits": hits}
        (directory / f"replay-{label}.json").write_bytes(encoded(rows))
    def values(rows):
        return {(r["captureId"], r["ordinal"], f): (v.get("corrected"), v.get("reviewRequired"))
                for r in rows for f, v in r["fields"].items()}
    before, after = values(results["baseline"]), values(results["candidate"])
    differences = [{"captureId": key[0], "ordinal": key[1], "field": key[2], "baseline": before.get(key), "candidate": after.get(key)}
                   for key in sorted(before.keys() | after.keys()) if before.get(key) != after.get(key)]
    accepted = (not differences and summary["candidate"]["seconds"] <= summary["baseline"]["seconds"] * 1.05
                and summary["candidate"]["modelCalls"] <= summary["baseline"]["modelCalls"])
    result = {"candidateBankSha256": report["candidateBankSha256"], "timing": summary, "differences": differences,
              "canApply": accepted, "actualGameF10": "NOT_RUN", "sourceChanged": False}
    (directory / "replay-report.json").write_bytes(encoded(result))
    return result


if __name__ == "__main__":
    main()
