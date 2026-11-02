"""Reproducible offline fitting/evaluation; never connects to operational SQLite."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

from .numeric_profile import NumericProfile, fit_profile, load_dataset


def evaluate(manifest, pixels, profile, split):
    if profile["fontProfile"] != manifest["profile"]:
        raise ValueError("dataset/font profile mismatch")
    selected = [(record, image) for record, image in zip(manifest["records"], pixels) if record["split"] == split]
    if not selected:
        raise ValueError("no observations in requested split")
    train_sources = {entry["source"]["sourceSha256"] for entry in profile["glyphs"]}
    if any(record["group"] in profile["trainGroups"] or record["sourceSha256"] in train_sources
           for record, image in selected):
        raise ValueError("evaluation source leaked into fitted profile")
    core = NumericProfile(profile)
    results = []
    start = time.perf_counter()
    training_values = {record["value"] for record in manifest["records"] if record["split"] == "train"}
    for record, image in selected:
        result = core.read(image)
        results.append({"id": record["id"], "group": record["group"], "truth": record["value"],
            "unseenQuantity": record["value"] not in training_values, **result})
    elapsed = time.perf_counter()-start

    def metrics(rows):
        return {"observations": len(rows),
            "correctAuto": sum(row["value"] == row["truth"] for row in rows),
            "wrongAuto": sum(row["value"] is not None and row["value"] != row["truth"] for row in rows),
            "review": sum(row["value"] is None for row in rows),
            "correctReviewCandidate": sum(row["value"] is None and row["candidate"] == row["truth"] for row in rows)}

    return {"version": 1, "evaluationType": manifest["evaluationType"], "split": split,
        "profileSha256": profile["sha256"], "wholeFieldCache": False, "tradeRules": False,
        "ocrCalls": 0, "fallbackNotExecuted": True, "seconds": elapsed,
        "total": metrics(results), "unseenQuantities": metrics([row for row in results if row["unseenQuantity"]]),
        "results": results}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fit = commands.add_parser("fit")
    fit.add_argument("--dataset", type=Path, required=True)
    fit.add_argument("--glyphs", type=Path, required=True)
    fit.add_argument("--out", type=Path, required=True)
    score = commands.add_parser("evaluate")
    score.add_argument("--dataset", type=Path, required=True)
    score.add_argument("--profile", type=Path, required=True)
    score.add_argument("--split", choices=["dev", "test", "retrospective"], required=True)
    score.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    manifest, pixels = load_dataset(args.dataset)
    if args.command == "fit":
        annotations = json.loads(args.glyphs.read_text(encoding="utf-8"))
        output = fit_profile(manifest, pixels, annotations)
    else:
        profile = json.loads(args.profile.read_text(encoding="utf-8"))
        output = evaluate(manifest, pixels, profile, args.split)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = ({"profileSha256": output["sha256"], "glyphs": len(output["glyphs"]),
                "reservedTrainGroups": len(output["trainGroups"])} if args.command == "fit" else
               {key: value for key, value in output.items() if key != "results"})
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
